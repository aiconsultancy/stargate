import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  pluginDigest,
  pluginDigestFile,
  readPluginDigest,
  writePluginDigest,
} from "../src/nightly/plugin-digest";

const base = await mkdtemp("/tmp/opencode/stargate-plugin-digest-");
afterAll(() => rm(base, { recursive: true, force: true }));
let count = 0;

/** A release tree: a plugin that imports one shared module, and a gateway. */
async function release(files: Record<string, string> = {}) {
  const root = join(base, `release-${count++}`);
  const tree: Record<string, string> = {
    "package.json":
      '{ "name": "stargate", "exports": { ".": "./src/crew/plugin.ts" } }\n',
    "bun.lock": "lock 1\n",
    "src/crew/plugin.ts":
      'import { shared } from "../shared";\nimport type { Job } from "../store";\nexport const plugin = async () => (await import("./lazy")).lazy(shared);\n',
    "src/crew/lazy.ts": "export const lazy = (value: string) => value;\n",
    "src/shared.ts": 'export const shared = "one";\n',
    "src/store.ts": "export type Job = { id: number };\n",
    "src/gateway.ts":
      'import { shared } from "./shared";\nexport const gateway = shared;\n',
    "templates/agents/crew.md": "crew\n",
    "tests/gateway.test.ts": "test\n",
    "docs/design.md": "design\n",
    "README.md": "readme\n",
    ...files,
  };
  for (const [path, text] of Object.entries(tree)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test("gateway source, tests and documentation do not change the digest", async () => {
  const digest = await pluginDigest(await release());
  expect(digest).toMatch(/^v1:[a-f0-9]{64}$/);
  expect(
    await pluginDigest(
      await release({
        "src/gateway.ts": "export const gateway = 2;\n",
        // Imported by the plugin for its type only.
        "src/store.ts": "export type Job = { id: string };\n",
        "src/new-gateway-module.ts": "export {};\n",
        "tests/gateway.test.ts": "changed\n",
        "docs/design.md": "changed\n",
        "README.md": "changed\n",
      }),
    ),
  ).toBe(digest);
});

test("everything that the plugin can load changes the digest", async () => {
  const digest = await pluginDigest(await release());
  for (const change of [
    {
      "src/crew/plugin.ts":
        'import { shared } from "../shared";\nexport const plugin = shared;\n',
    },
    { "src/shared.ts": 'export const shared = "two";\n' },
    // Loaded only when first used.
    { "src/crew/lazy.ts": "export const lazy = () => 2;\n" },
    {
      "package.json":
        '{ "name": "stargate", "version": "2", "exports": { ".": "./src/crew/plugin.ts" } }\n',
    },
    { "bun.lock": "lock 2\n" },
    { "tsconfig.json": "{}\n" },
    { "templates/agents/crew.md": "changed\n" },
    { "templates/new.md": "new\n" },
  ]) {
    const changed = await pluginDigest(await release(change));
    expect([Object.keys(change), changed]).not.toEqual([
      Object.keys(change),
      digest,
    ]);
    expect(changed).toMatch(/^v1:/);
  }
});

test("a tree that cannot be proven complete has no digest", async () => {
  for (const files of [
    { "package.json": '{ "name": "stargate" }\n' },
    { "package.json": '{ "exports": { ".": "../outside.ts" } }\n' },
    { "package.json": "not json" },
    { "src/crew/plugin.ts": 'import "./missing";\n' },
    { "src/crew/plugin.ts": 'import "../../../outside";\n' },
    { "src/crew/plugin.ts": "export const broken = ;\n" },
    // It can read any file of the tree at run time.
    { "src/shared.ts": "export const shared = import.meta.dir;\n" },
  ])
    expect([files, await pluginDigest(await release(files))]).toEqual([
      files,
      undefined,
    ]);
  const linked = await release();
  await rm(join(linked, "src/shared.ts"));
  await symlink(join(linked, "src/gateway.ts"), join(linked, "src/shared.ts"));
  expect(await pluginDigest(linked)).toBeUndefined();
  const template = await release();
  await symlink("/etc/hostname", join(template, "templates/link.md"));
  expect(await pluginDigest(template)).toBeUndefined();
});

test("an import that cannot be resolved from the source has no digest", async () => {
  const plugin = (body: string) => ({
    "src/crew/plugin.ts": `import { shared } from "../shared";\n${body}\nexport const plugin = shared;\n`,
  });
  for (const files of [
    // Computed: the module that runs is not known from the source.
    plugin('const path = "./lazy";\nexport const load = () => import(path);'),
    plugin(
      ["export const load = (name: string) => import(`./$", "{name}`);"].join(
        "",
      ),
    ),
    plugin('const path = "./lazy";\nexport const load = () => require(path);'),
    plugin("const load = require;\nexport const lazy = load;"),
    plugin('export const path = require.resolve("./lazy");'),
    plugin('export const lazy = module.require("./lazy");'),
    plugin(
      'import { createRequire } from "node:module";\nexport const load = createRequire(__filename);',
    ),
  ])
    expect([files, await pluginDigest(await release(files))]).toEqual([
      files,
      undefined,
    ]);
  // Literal forms are followed; the words in text and comments are not code.
  const literal = plugin(
    'export const a = () => import("./lazy");\nexport const b = () => require("./lazy");\n// import(anything) and require(anything)\nexport const text = "Tasks require approval before import.";',
  );
  const digest = await pluginDigest(await release(literal));
  expect(digest).toMatch(/^v1:/);
  expect(
    await pluginDigest(
      await release({
        ...literal,
        "src/crew/lazy.ts": "export const lazy = () => 2;\n",
      }),
    ),
  ).not.toBe(digest);
});

test("the digest follows the file that Bun runs", async () => {
  // Bun resolves `../shared` to shared.tsx before shared.ts.
  const both = {
    "src/shared.ts": 'export const shared = "ts";\n',
    "src/shared.tsx": 'export const shared = "tsx one";\n',
  };
  const digest = await pluginDigest(await release(both));
  expect(digest).toMatch(/^v1:/);
  expect(
    await pluginDigest(
      await release({
        ...both,
        "src/shared.tsx": 'export const shared = "tsx two";\n',
      }),
    ),
  ).not.toBe(digest);
  // The file that Bun does not run is not part of the plugin.
  expect(
    await pluginDigest(
      await release({ ...both, "src/shared.ts": "export const shared = 0;\n" }),
    ),
  ).toBe(digest);
  // A directory import runs its index file.
  const index = {
    "src/crew/plugin.ts":
      'import { part } from "./parts";\nexport const plugin = part;\n',
    "src/crew/parts/index.ts": "export const part = 1;\n",
  };
  expect(await pluginDigest(await release(index))).not.toBe(
    await pluginDigest(
      await release({
        ...index,
        "src/crew/parts/index.ts": "export const part = 2;\n",
      }),
    ),
  );
  // A path alias from tsconfig.json to a file of the tree is followed too.
  const alias = {
    "tsconfig.json":
      '{ "compilerOptions": { "paths": { "@lib/*": ["./src/lib/*"] } } }\n',
    "src/crew/plugin.ts":
      'import { lib } from "@lib/value";\nexport const plugin = lib;\n',
    "src/lib/value.ts": "export const lib = 1;\n",
  };
  const aliased = await pluginDigest(await release(alias));
  expect(aliased).toMatch(/^v1:/);
  expect(
    await pluginDigest(
      await release({
        ...alias,
        "src/lib/value.ts": "export const lib = 2;\n",
      }),
    ),
  ).not.toBe(aliased);
  // A package that is not installed in the tree cannot be checked.
  expect(
    await pluginDigest(
      await release({
        "src/crew/plugin.ts":
          'import { z } from "zod";\nexport const plugin = z;\n',
      }),
    ),
  ).toBeUndefined();
});

test("every executable file of the closure is scanned, or there is no digest", async () => {
  // CommonJS: a literal require is followed like an import.
  for (const extension of ["cjs", "cts"]) {
    const tree = (value: number) => ({
      "src/crew/plugin.ts": `import part from "./part.${extension}";\nexport const plugin = part;\n`,
      [`src/crew/part.${extension}`]:
        'module.exports = require("./deep.ts");\n',
      "src/crew/deep.ts": `export const value = ${value};\n`,
    });
    const digest = await pluginDigest(await release(tree(1)));
    expect([extension, digest]).toEqual([
      extension,
      expect.stringMatching(/^v1:/),
    ]);
    expect(await pluginDigest(await release(tree(2)))).not.toBe(digest);
    // A computed require in it is unknown, as in any other source file.
    expect(
      await pluginDigest(
        await release({
          ...tree(1),
          [`src/crew/part.${extension}`]:
            'const name = "./deep.ts";\nmodule.exports = require(name);\n',
        }),
      ),
    ).toBeUndefined();
  }
  // The other module formats are scanned too.
  for (const extension of ["mjs", "mts", "js", "jsx", "tsx"]) {
    const tree = (value: number) => ({
      "src/crew/plugin.ts": `import { part } from "./part.${extension}";\nexport const plugin = part;\n`,
      [`src/crew/part.${extension}`]:
        'import { value } from "./deep";\nexport const part = value;\n',
      "src/crew/deep.ts": `export const value = ${value};\n`,
    });
    const digest = await pluginDigest(await release(tree(1)));
    expect([extension, digest]).toEqual([
      extension,
      expect.stringMatching(/^v1:/),
    ]);
    expect(await pluginDigest(await release(tree(2)))).not.toBe(digest);
  }
  // Data is hashed and has no imports.
  const data = (value: number) => ({
    "src/crew/plugin.ts":
      'import settings from "./settings.json";\nexport const plugin = settings;\n',
    "src/crew/settings.json": `{ "value": ${value} }\n`,
  });
  const digest = await pluginDigest(await release(data(1)));
  expect(digest).toMatch(/^v1:/);
  expect(await pluginDigest(await release(data(2)))).not.toBe(digest);
  // A format that Bun can run and this scanner cannot read is unknown.
  for (const name of ["part.wasm", "part.node", "part.html", "part.sh"])
    expect([
      name,
      await pluginDigest(
        await release({
          "src/crew/plugin.ts": `import part from "./${name}";\nexport const plugin = part;\n`,
          [`src/crew/${name}`]: "content\n",
        }),
      ),
    ]).toEqual([name, undefined]);
});

test("the recorded digest is computed here, never taken from the archive", async () => {
  const root = await release({
    [pluginDigestFile]: `v1:${"0".repeat(64)}\n`,
  });
  const digest = await writePluginDigest(root);
  expect(digest).toBe(await pluginDigest(root));
  expect(await readPluginDigest(root)).toBe(digest);
  expect(await readFile(join(root, pluginDigestFile), "utf8")).toBe(
    `${digest}\n`,
  );
  // Unknown: no file is left, also not the one from the archive.
  const unknown = await release({
    "package.json": '{ "name": "stargate" }\n',
    [pluginDigestFile]: `v1:${"0".repeat(64)}\n`,
  });
  expect(await writePluginDigest(unknown)).toBeUndefined();
  expect(await readPluginDigest(unknown)).toBeUndefined();
  // A damaged record is unknown.
  await writeFile(join(root, pluginDigestFile), "v1:short\n");
  expect(await readPluginDigest(root)).toBeUndefined();
});

test("this repository's crew plugin has a digest", async () => {
  expect(await pluginDigest(join(import.meta.dir, ".."))).toMatch(
    /^v1:[a-f0-9]{64}$/,
  );
});
