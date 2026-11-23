import { createHash } from "node:crypto";
import { appendFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";

// Compares the checked-out commit with its first parent.
// For a PR this is the merge commit; for a push, the pushed commit.
// See docs/development.md.
const BASELINE = "tests/architecture-baseline.json";
const DECLARATION = "tests/architecture-change.json";
const POLICY = "tests/architecture-policy.json";

const declarationSchema = Schema.Struct({
  baselineSha256: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ),
  pruneStale: Schema.optionalKey(Schema.Boolean),
  closureAdditions: Schema.optionalKey(Schema.Array(Schema.String)),
  rekeyExceptions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ oldKey: Schema.String, newKey: Schema.String }),
    ),
  ),
});

const recordSchema = Schema.Record(Schema.String, Schema.Unknown);

const receiptSchema = Schema.Struct({
  inventory: recordSchema,
  exceptions: Schema.Array(Schema.String),
  largeFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  prunedExceptions: Schema.optionalKey(Schema.Array(Schema.String)),
  prunedLargeFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  closureReviewRequired: Schema.optionalKey(Schema.String),
});

function fail(code: string, detail = ""): never {
  const text = detail ? `${code}: ${detail}` : code;
  console.error(`::error title=Architecture baseline::${escape(text)}`);
  console.error(text);
  process.exit(1);
}

/** GitHub workflow-command data escaping. */
function escape(text: string) {
  return text
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

const usage =
  "Usage: check-architecture-baseline.ts --root PATH [--pr-head SHA | --push-before SHA]";

const options = new Map<string, string>();

for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];

  if (
    !key ||
    !["--root", "--pr-head", "--push-before"].includes(key) ||
    value === undefined ||
    options.has(key)
  )
    fail("usage", usage);
  options.set(key, value);
}

if (options.has("--pr-head") && options.has("--push-before"))
  fail("usage", usage);

const root = resolve(options.get("--root") ?? ".");
const fullSha = /^[a-f0-9]{40}$/;

async function spawnText(args: string[]) {
  const child = Bun.spawn(args, {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, exit };
}

async function command(args: string[], allowFailure = false) {
  const { stdout, stderr, exit } = await spawnText(args);

  if (exit !== 0 && !allowFailure)
    fail(`command-failed:${args[0]}`, `${args.join(" ")} (${exit}): ${stderr}`);

  return exit === 0 ? stdout : undefined;
}

const revision = async (name: string) =>
  (
    await command(
      ["git", "rev-parse", "--verify", "--quiet", `${name}^{commit}`],
      true,
    )
  )?.trim();

const head = await revision("HEAD");

if (!head) fail("event:no-head", "the root is not a Git checkout");

const parent = await revision("HEAD^1");

if (!parent)
  fail(
    "event:no-parent",
    `HEAD ${head} has no first parent; fetch history (fetch-depth: 0)`,
  );

const prHead = options.get("--pr-head");

if (prHead !== undefined) {
  if (!fullSha.test(prHead))
    fail("event:pr-head-invalid", `expected a full SHA, got "${prHead}"`);
  const second = await revision("HEAD^2");

  if (second !== prHead)
    fail(
      "event:not-merge-ref",
      `HEAD ${head} is not the merge of PR head ${prHead} into its target; check out refs/pull/N/merge`,
    );
}

const before = options.get("--push-before");

if (before !== undefined) {
  if (!fullSha.test(before) || /^0+$/.test(before))
    fail(
      "event:push-before-missing",
      `github.event.before is "${before}"; a new branch or deleted ref has no comparison commit`,
    );

  if (before !== parent)
    fail(
      "event:push-not-single-commit",
      `before ${before} is not HEAD's first parent ${parent}. Only one commit per push is checked; check each commit of this push against its own parent`,
    );
}

/** Rejects a JSON object with a repeated key at any depth. */
function duplicateKey(text: string): string | undefined {
  const frames: { keys: Set<string> | undefined; expectKey: boolean }[] = [];
  const token = /\s*(?:("(?:[^"\\]|\\.)*")|([{}[\]:,])|([^\s{}[\]:,"]+))/y;

  for (let match = token.exec(text); match; match = token.exec(text)) {
    const frame = frames.at(-1);
    const [, string, punctuation] = match;

    if (punctuation === "{") frames.push({ keys: new Set(), expectKey: true });
    else if (punctuation === "[")
      frames.push({ keys: undefined, expectKey: false });
    else if (punctuation === "}" || punctuation === "]") frames.pop();
    else if (punctuation === "," && frame?.keys) frame.expectKey = true;
    else if (string !== undefined && frame?.keys && frame.expectKey) {
      let key: string;

      try {
        key = JSON.parse(string) as string;
      } catch {
        // JSON.parse below names the syntax error.
        return undefined;
      }

      if (frame.keys.has(key)) return key;
      frame.keys.add(key);
      frame.expectKey = false;
    }
  }

  return undefined;
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const atParent = async (path: string) =>
  (await command(["git", "ls-tree", "--name-only", parent, "--", path]))?.trim()
    ? await command(["git", "show", `${parent}:${path}`])
    : undefined;

const parentBaseline = await atParent(BASELINE);

if (parentBaseline === undefined)
  fail("event:parent-without-baseline", `${parent} has no ${BASELINE}`);

const parentBaselineSha256 = sha256(parentBaseline);
const parentDeclaration = await atParent(DECLARATION);

// P7's ten rekeys and one closure file take 1.7 KiB.
// 64 KiB allows about 400 rekey pairs.
// It keeps the tool's arguments well below ARG_MAX.
const DECLARATION_LIMIT = 64 * 1024;
const declarationPath = join(root, DECLARATION);

const declarationStatus = await lstat(declarationPath).catch(
  (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  },
);

if (declarationStatus?.isSymbolicLink())
  fail(
    "declaration:symlink",
    `${DECLARATION} is a symbolic link; commit the declaration as a regular file, so the diff shows its allowances`,
  );

if (declarationStatus && !declarationStatus.isFile())
  fail(
    "declaration:not-regular-file",
    `${DECLARATION} is ${declarationStatus.isDirectory() ? "a directory" : "not a regular file"}`,
  );

if (declarationStatus && declarationStatus.size > DECLARATION_LIMIT)
  fail(
    "declaration:too-large",
    `${DECLARATION} has ${declarationStatus.size} bytes; the limit is ${DECLARATION_LIMIT}`,
  );

const currentDeclaration = declarationStatus
  ? await readFile(declarationPath, "utf8")
  : undefined;

// A declaration applies only to the change that writes it.
// Inherited bytes name an older baseline and grant nothing.
const changed =
  currentDeclaration !== undefined && currentDeclaration !== parentDeclaration;

let parsed: unknown = {};

if (changed && currentDeclaration?.trim()) {
  const duplicate = duplicateKey(currentDeclaration);

  if (duplicate !== undefined)
    fail("declaration:duplicate-key", `"${duplicate}" appears twice`);

  try {
    parsed = JSON.parse(currentDeclaration);
  } catch (error) {
    fail("declaration:invalid-json", String(error));
  }
}

let declaration: typeof declarationSchema.Type = {};

try {
  declaration = Schema.decodeUnknownSync(declarationSchema, {
    onExcessProperty: "error",
  })(parsed);
} catch (error) {
  fail("declaration:invalid", String(error));
}

const allowances =
  Boolean(declaration.pruneStale) ||
  Boolean(declaration.closureAdditions?.length) ||
  Boolean(declaration.rekeyExceptions?.length);

if (allowances && declaration.baselineSha256 === undefined)
  fail(
    "declaration:missing-baseline-sha256",
    `add "baselineSha256": "${parentBaselineSha256}" after checking the allowances against current main`,
  );

const stale =
  declaration.baselineSha256 !== undefined &&
  declaration.baselineSha256 !== parentBaselineSha256;

const staleDetail = `declared ${declaration.baselineSha256}, parent ${parent} has ${parentBaselineSha256}`;

// A PR must bind to its current parent.
// A push cannot undo a merge: main does not require up-to-date branches.
// So a push re-validates the allowances against the actual parent.
if (stale && before === undefined)
  fail(
    "declaration:stale-baseline",
    `${staleDetail}. Another change rewrote the baseline: regenerate on current main the baseline and the declaration`,
  );

const failStale = (detail: string): never =>
  fail(
    "declaration:stale-baseline",
    `${staleDetail}. The allowances do not validate against the parent: ${detail}`,
  );

const args: string[] = [];

if (declaration.pruneStale) args.push("--prune-stale");

for (const file of declaration.closureAdditions ?? [])
  args.push("--allow-closure-addition", file);

for (const { oldKey, newKey } of declaration.rekeyExceptions ?? [])
  args.push("--rekey-exception", oldKey, newKey);

const baselineBytes = await readFile(join(root, BASELINE), "utf8");

const working = Schema.decodeUnknownSync(recordSchema)(
  JSON.parse(baselineBytes),
);

const directory = await mkdtemp(join(tmpdir(), "stargate-baseline-check-"));
let receipt: typeof receiptSchema.Type;

try {
  const receiptPath = join(directory, "receipt.json");

  const tool = [
    process.execPath,
    join(import.meta.dir, "refresh-architecture-baseline.ts"),
    "--root",
    root,
    "--base",
    parent,
    "--output",
    receiptPath,
    ...args,
  ];

  if (stale) {
    const result = await spawnText(tool);

    if (result.exit !== 0) failStale(result.stderr);
  } else await command(tool);
  receipt = Schema.decodeUnknownSync(receiptSchema)(
    JSON.parse(await readFile(receiptPath, "utf8")),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

const expected: Record<string, unknown> = {
  ...working,
  ...receipt.inventory,
  exceptions: receipt.exceptions,
  largeFiles: receipt.largeFiles ?? working["largeFiles"],
};

const differences = Object.keys(expected).filter(
  (key) => !isDeepStrictEqual(working[key], expected[key]),
);

if ((await readFile(join(root, BASELINE), "utf8")) !== baselineBytes)
  fail("baseline-changed-during-check");

if (differences.length && stale)
  failStale(differences.map((key) => `baseline-diff:${key}`).join("\n"));

if (differences.length)
  fail(
    "baseline-diff",
    differences.map((key) => `baseline-diff:${key}`).join("\n"),
  );

// Every allowance is printed in full: the reader must verify each one.
const notices: [string, string][] = [];

for (const file of declaration.closureAdditions ?? [])
  notices.push([
    "closure addition",
    `${file}. Reader: verify that this file holds only code the crew plugin closure already loaded (moved bodies, no new package).`,
  ]);

for (const { oldKey, newKey } of declaration.rekeyExceptions ?? [])
  notices.push([
    "exception rekey",
    `${oldKey} => ${newKey}. Reader: verify that the importing code moved unchanged into the new file.`,
  ]);

const listed = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const previous = Schema.decodeUnknownSync(recordSchema)(
  JSON.parse(parentBaseline),
);

const rekeyed = new Set(
  (declaration.rekeyExceptions ?? []).map(({ oldKey }) => oldKey),
);

const removedExceptions = listed(previous["exceptions"]).filter(
  (key) => !listed(working["exceptions"]).includes(key) && !rekeyed.has(key),
);

const removedLargeFiles = listed(previous["largeFiles"]).filter(
  (file) => !listed(working["largeFiles"]).includes(file),
);

if (declaration.pruneStale)
  notices.push([
    "prune stale",
    `removed against the parent: exceptions: ${removedExceptions.join(", ") || "none"}; size entries: ${removedLargeFiles.join(", ") || "none"}. Pruning only removes entries.`,
  ]);

// The commit under test supplies its own policy: every edit is a permission.
const policyStat = (
  await command(["git", "diff", "--numstat", parent, "HEAD", "--", POLICY])
)
  ?.trim()
  .split("\t");

const policyChange =
  policyStat && policyStat.length >= 2
    ? `the reader checks every changed line (${policyStat[0]} added, ${policyStat[1]} removed)`
    : undefined;

const activeState = stale
  ? `active declaration re-validated against parent baseline sha256 ${parentBaselineSha256}`
  : `active declaration for baseline sha256 ${parentBaselineSha256}`;

const changedState = allowances
  ? activeState
  : "declaration changed, no allowances";

const state = changed
  ? changedState
  : "no active declaration (inherited or absent)";

const warning = stale
  ? `declaration was bound to an older baseline; allowances re-validated against the parent (${staleDetail}): ${notices.map(([kind, text]) => `${kind}: ${text}`).join(" | ")}`
  : undefined;

if (warning) {
  console.log(
    `::warning title=Architecture declaration re-validated::${escape(warning)}`,
  );
  console.log(`Warning: ${warning}`);
}

if (policyChange) {
  console.log(
    `::notice title=Architecture policy changed::policy changed in this commit: ${escape(policyChange)}`,
  );
  console.log(`Architecture policy changed in this commit: ${policyChange}`);
}

for (const [kind, text] of notices) {
  console.log(
    `::notice title=Architecture allowance: ${kind}::${escape(text)}`,
  );
  console.log(`Architecture allowance: ${kind}: ${text}`);
}

if (notices.length && receipt.closureReviewRequired)
  console.log(`Tool: ${receipt.closureReviewRequired}`);

console.log(
  `Architecture baseline matches preview against parent ${parent} (${state}; ${notices.length} allowances)`,
);

const summary = process.env["GITHUB_STEP_SUMMARY"];

if (summary)
  await appendFile(
    summary,
    [
      "### Architecture baseline",
      "",
      `Compared with parent \`${parent}\`: ${state}.`,
      "",
      ...(warning ? [`**Warning**: ${warning}`, ""] : []),
      ...(policyChange
        ? [`- **policy changed in this commit**: ${policyChange}`]
        : []),
      ...(notices.length
        ? notices.map(([kind, text]) => `- **${kind}**: \`${text}\``)
        : ["No allowances."]),
      "",
    ].join("\n"),
  );
