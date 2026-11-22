import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";

/**
 * Digest of the crew plugin of one release tree: everything that OpenCode
 * loads from the release. Two releases with the same digest run the same
 * plugin, so a switch between them needs a restart of the gateway only.
 *
 * The digest covers:
 * - the plugin entry (`exports` in `package.json`) and every file of the
 *   tree that it imports, as Bun's own resolver finds it: static imports
 *   and `import()` or `require()` with a literal path;
 * - `package.json`, the lockfile and the Bun and TypeScript settings, which
 *   select the installed dependencies and how the source is read;
 * - `templates/`.
 *
 * Source files outside the import closure, tests and documentation are not
 * covered: only the gateway reads them. Packages are not hashed: an import
 * must resolve to `node_modules` of the tree, and the lockfile stands for
 * its content.
 *
 * The answer is `undefined` (unknown) when the closure cannot be proven
 * complete from the source alone:
 * - no entry, or a source file that does not parse;
 * - an imported file that is neither a scanned source format (`.ts`,
 *   `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`) nor plain data
 *   (`.json`, `.jsonc`, `.toml`, `.yaml`, `.yml`, `.txt`);
 * - an import that does not resolve, or resolves outside the tree, through
 *   a symbolic link or to something that is not a regular file;
 * - `import()` or `require()` with a computed path, `require` used as a
 *   value, `module.require`, `createRequire`;
 * - `import.meta` in a covered source file (it can read other files).
 * Unknown always means a full restart. Code that reads a file of the tree
 * by an absolute path and evaluates it is not detected.
 */
export const pluginDigestFile = ".stargate-plugin-digest";
const format = /^v1:[a-f0-9]{64}$/;
const settings = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "tsconfig.json",
];
const maxFiles = 5000;
/** Every source format that Bun runs and this module scans. */
const loaders: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};
/** Formats that Bun loads as a value: hashed, with no imports of their own. */
const data = new Set([".json", ".jsonc", ".toml", ".yaml", ".yml", ".txt"]);
const manifest = z.object({
  exports: z.union([z.string(), z.object({ ".": z.string() })]),
});

class Unknown extends Error {}

/** A regular file inside `root`, never a link. */
async function regularFile(root: string, path: string) {
  const inside = relative(root, path);
  if (!inside || inside.startsWith("..") || inside.startsWith(sep))
    return false;
  const stat = await lstat(path).catch(() => null);
  return stat?.isFile() === true;
}

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * The file of the tree that Bun runs for `specifier` in `from`, or
 * undefined for a builtin or a package installed in the tree.
 */
async function resolveImport(root: string, from: string, specifier: string) {
  let resolved: string;
  try {
    resolved = Bun.resolveSync(specifier, dirname(from));
  } catch {
    throw new Unknown();
  }
  if (/^(?:node|bun):/.test(resolved)) return undefined;
  const inside = relative(root, resolved);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Unknown();
  const relativeImport =
    specifier.startsWith("./") || specifier.startsWith("../");
  if (!relativeImport && inside.split(sep).includes("node_modules"))
    return undefined;
  // Bun answers with the real path. A relative import must name its file
  // itself (with or without the extension, or its directory): a symbolic
  // link on the way is unknown.
  if (relativeImport) {
    const named = resolve(dirname(from), specifier);
    const plain = (path: string) => path.replace(sourceExtension, "");
    if (
      resolved !== named &&
      plain(resolved) !== plain(named) &&
      !(dirname(resolved) === named && /^index\./.test(basename(resolved)))
    )
      throw new Unknown();
  }
  if (!(await regularFile(root, resolved))) throw new Unknown();
  return resolved;
}

const sentinel = "__stargate_plugin_digest_require__";
const count = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].length;

/**
 * The import paths of one source file. Unknown when the file can load a
 * module that its source does not name.
 */
function importsOf(source: string, loader: "ts" | "tsx" | "js" | "jsx") {
  if (source.includes("import.meta")) throw new Unknown();
  const found = new Bun.Transpiler({ loader }).scanImports(source);
  // Comments are gone here, and every use of `require` as an identifier is
  // the sentinel. Text in strings stays: it can only make the answer
  // unknown, never known.
  const code = new Bun.Transpiler({
    loader,
    define: { require: sentinel },
  }).transformSync(source);
  const of = (kind: string) =>
    found.filter((item) => item.kind === kind).length;
  if (
    // Each `import(` and each use of `require` is a call with a literal path.
    count(code, /\bimport\s*\(/g) !== of("dynamic-import") ||
    count(code, /\bimport\s*\(\s*["']/g) !== of("dynamic-import") ||
    count(code, new RegExp(sentinel, "g")) !== of("require-call") ||
    count(code, new RegExp(`${sentinel}\\(\\s*["']`, "g")) !==
      of("require-call") ||
    // `module.require(...)` is rewritten to a plain `require(...)`.
    /\brequire\s*\(/.test(code) ||
    /\bcreateRequire\b/.test(code)
  )
    throw new Unknown();
  return found.map((item) => item.path);
}

/** Every file below `directory`; a link or a special file is unknown. */
async function filesBelow(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(path)));
    else if (entry.isFile()) found.push(path);
    else throw new Unknown();
  }
  return found;
}

/** `v1:<sha256>` for the release tree in `directory`, or undefined. */
export async function pluginDigest(
  directory: string,
): Promise<string | undefined> {
  try {
    // Bun resolves to real paths; compare in the same form.
    const root = await realpath(resolve(directory));
    const parsed = manifest.safeParse(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    );
    if (!parsed.success) return undefined;
    const exported = parsed.data.exports;
    const entry = typeof exported === "string" ? exported : exported["."];
    if (!entry.startsWith("./")) return undefined;
    const start = resolve(root, entry);
    if (!(await regularFile(root, start))) return undefined;

    const covered = new Map<string, string>();
    const cover = async (path: string) => {
      const content = await readFile(path);
      covered.set(
        relative(root, path).split(sep).join("/"),
        createHash("sha256").update(content).digest("hex"),
      );
      return content;
    };
    const queue = [start];
    const seen = new Set<string>();
    for (let path = queue.pop(); path; path = queue.pop()) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (seen.size > maxFiles) return undefined;
      const source = (await cover(path)).toString("utf8");
      const extension = extname(path);
      if (data.has(extension)) continue;
      const loader = loaders[extension];
      // A format that Bun can run and this module cannot scan.
      if (!loader) return undefined;
      for (const specifier of importsOf(source, loader)) {
        const file = await resolveImport(root, path, specifier);
        if (file) queue.push(file);
      }
    }
    for (const name of settings)
      if (await regularFile(root, join(root, name)))
        await cover(join(root, name));
      else if (await lstat(join(root, name)).catch(() => null))
        return undefined;
    const templates = await lstat(join(root, "templates")).catch(() => null);
    if (templates?.isDirectory())
      for (const path of await filesBelow(join(root, "templates")))
        await cover(path);
    else if (templates) return undefined;

    const digest = createHash("sha256");
    for (const [path, hash] of [...covered].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ))
      digest.update(`${path}\0${hash}\n`);
    return `v1:${digest.digest("hex")}`;
  } catch {
    return undefined;
  }
}

/**
 * Compute the digest of a staged release and keep it beside the release
 * metadata. A file of this name that came with the archive is never
 * trusted: it is removed first.
 */
export async function writePluginDigest(directory: string) {
  const path = join(directory, pluginDigestFile);
  await rm(path, { recursive: true, force: true });
  const digest = await pluginDigest(directory);
  if (digest) await writeFile(path, `${digest}\n`, { flag: "wx", mode: 0o600 });
  return digest;
}

/** The digest recorded when the release was staged, if any. */
export async function readPluginDigest(directory: string) {
  const path = join(directory, pluginDigestFile);
  if (!(await regularFile(resolve(directory), resolve(path)))) return undefined;
  const text = (await readFile(path, "utf8").catch(() => "")).trim();
  return format.test(text) ? text : undefined;
}
