import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { moveModules } from "../scripts/move-modules";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Module fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Module fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString();
}

async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "stargate-module-move-"));
  roots.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "core.hooksPath", "/dev/null");
  git(root, "config", "commit.gpgSign", "false");
  git(root, "config", "tag.gpgSign", "false");
  git(root, "config", "core.fsmonitor", "false");
  git(root, "config", "gc.auto", "0");

  for (const [path, text] of Object.entries(files)) await put(root, path, text);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");

  return root;
}

function text(root: string, path: string) {
  return readFile(join(root, path), "utf8");
}

async function expectFailure(work: Promise<void>, message?: string) {
  // Settle native stdio before asserting. Bun's rejects matcher blocks its callbacks.
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(Error);

  if (message && error instanceof Error)
    expect(error.message).toContain(message);
}

test("moves modules and updates all code roots without changing other strings", async () => {
  const consumer = [
    'import { value } from "../src/item";',
    "import '../src/item.ts';",
    "export { value } from '../src/item.js';",
    'const loaded = import("../src/item");',
    'const untouched = "../src/item";',
    '// import "../src/item";',
    'const template = `import("../src/item")`;',
    String.raw`const pattern = /import\("..\/src\/item"\)/;`,
    "",
  ].join("\n");

  const root = await fixture({
    "src/item.ts":
      'import { helper } from "./helper";\nexport const value = helper;\n',
    "src/helper.ts": "export const helper = 1;\n",
    "src/use.ts": consumer.replaceAll("../src/", "./"),
    "tests/use.ts": consumer,
    "scripts/use.ts": consumer,
    "perf/use.ts": consumer,
    "plugins/opencode/crew/plugin.ts":
      'export { value } from "../../../src/item";\n',
  });

  await moveModules(root, [["src/item.ts", "src/domain/item.ts"]]);
  expect(await text(root, "src/domain/item.ts")).toBe(
    'import { helper } from "../helper";\nexport const value = helper;\n',
  );

  for (const path of ["tests/use.ts", "scripts/use.ts", "perf/use.ts"]) {
    expect(await text(root, path)).toBe(
      [
        'import { value } from "../src/domain/item";',
        "import '../src/domain/item.ts';",
        "export { value } from '../src/domain/item.js';",
        'const loaded = import("../src/domain/item");',
        'const untouched = "../src/item";',
        '// import "../src/item";',
        'const template = `import("../src/item")`;',
        String.raw`const pattern = /import\("..\/src\/item"\)/;`,
        "",
      ].join("\n"),
    );
  }

  expect(await text(root, "src/use.ts")).toContain('from "./domain/item"');
  expect(await text(root, "plugins/opencode/crew/plugin.ts")).toBe(
    'export { value } from "../../../src/domain/item";\n',
  );
  expect(git(root, "diff", "--cached", "--name-status")).toContain(
    "src/domain/item.ts",
  );
  await moveModules(root, [["src/item.ts", "src/domain/item.ts"]], {
    check: true,
  });
});

test("batch moves preserve index shorthand, extension spelling and moved dependencies", async () => {
  const root = await fixture({
    "src/lib/index.ts": 'export { helper } from "../helper";\n',
    "src/helper.ts": "export const helper = 3;\n",
    "src/foo.test.ts": "export const testValue = 4;\n",
    "tests/use.ts": [
      "// Unicode offset: café 🚀",
      'import type { helper } from "../src/lib";',
      "export * from '../src/lib/index.ts';",
      "const loaded = import(`../src/lib/index.js`);",
      'type Helper = import("../src/lib/").helper;',
      'import "../src/foo.test";',
      "",
    ].join("\n"),
  });

  const moves = [
    ["src/lib/index.ts", "src/domain/index.ts"],
    ["src/helper.ts", "src/domain/.helper.ts"],
    ["src/foo.test.ts", "src/domain/bar.test.ts"],
  ] as const;

  await moveModules(root, moves);
  expect(await text(root, "src/domain/index.ts")).toBe(
    'export { helper } from "./.helper";\n',
  );
  expect(await text(root, "tests/use.ts")).toBe(
    [
      "// Unicode offset: café 🚀",
      'import type { helper } from "../src/domain";',
      "export * from '../src/domain/index.ts';",
      "const loaded = import(`../src/domain/index.js`);",
      'type Helper = import("../src/domain/").helper;',
      'import "../src/domain/bar.test";',
      "",
    ].join("\n"),
  );
  await moveModules(root, moves, { check: true });
});

test.each([
  ["src/item/use.ts", "../item"],
  ["src/item/nested/use.ts", "../../item"],
] as const)(
  "keeps the sibling file named when its importer moves to %s",
  async (destination, specifier) => {
    const root = await fixture({
      "src/item.ts": "export const value = 1;\n",
      "src/use.ts": 'import { value } from "./item";\n',
    });

    const moves = [["src/use.ts", destination]] as const;
    await moveModules(root, moves);
    expect(await text(root, destination)).toBe(
      `import { value } from "${specifier}";\n`,
    );
    await moveModules(root, moves, { check: true });
  },
);

test("updates a root importer when its dependency moves into the same-named folder", async () => {
  const root = await fixture({
    "src/item.ts": 'export { value } from "./use";\n',
    "src/use.ts": "export const value = 1;\n",
  });

  const moves = [["src/use.ts", "src/item/use.ts"]] as const;
  await moveModules(root, moves);
  expect(await text(root, "src/item.ts")).toBe(
    'export { value } from "./item/use";\n',
  );
  await moveModules(root, moves, { check: true });
});

test("names the index file when a directly imported file moves to index.ts", async () => {
  const root = await fixture({
    "src/item.ts": "export const value = 1;\n",
    "src/use.ts": 'import { value } from "./item";\n',
  });

  const moves = [["src/item.ts", "src/item/index.ts"]] as const;
  await moveModules(root, moves);
  expect(await text(root, "src/use.ts")).toBe(
    'import { value } from "./item/index";\n',
  );
  await moveModules(root, moves, { check: true });
});

test("preserves directory shorthand when an index module moves to index.ts", async () => {
  const root = await fixture({
    "src/old/index.ts": "export const value = 1;\n",
    "src/use.ts": 'import { value } from "./old";\n',
  });

  const moves = [["src/old/index.ts", "src/item/index.ts"]] as const;
  await moveModules(root, moves);
  expect(await text(root, "src/use.ts")).toBe(
    'import { value } from "./item";\n',
  );
  await moveModules(root, moves, { check: true });
});

test("rewrites exact documentation paths once, not lookalikes or other files", async () => {
  const original = [
    "`src/item.ts` [module](src/item.ts) src/item.ts:14 src/item.ts.",
    "src/item.tsx src/item.ts.old src/item.ts-more src/item.ts/child",
    "other-src/item.ts xsrc/item.ts /src/item.ts other/src/item.ts",
    "https://example.invalid/src/item.ts λsrc/item.ts src/item.tsλ",
    "src/next.ts",
    "",
  ].join("\n");

  const root = await fixture({
    "src/item.ts": "export const value = 1;\n",
    "src/next.ts": "export const value = 2;\n",
    "docs/nested/readme.md": original,
    "AGENTS.md": original,
    "README.md": original,
    "CONTRIBUTING.md": original,
    "other.md": original,
  });

  await moveModules(root, [
    ["src/item.ts", "src/new/item.ts"],
    ["src/next.ts", "src/new/next.ts"],
  ]);

  const expected = original
    .replace(
      "`src/item.ts` [module](src/item.ts) src/item.ts:14 src/item.ts.",
      "`src/new/item.ts` [module](src/new/item.ts) src/new/item.ts:14 src/new/item.ts.",
    )
    .replace("\nsrc/next.ts\n", "\nsrc/new/next.ts\n");

  for (const path of [
    "docs/nested/readme.md",
    "AGENTS.md",
    "README.md",
    "CONTRIBUTING.md",
  ])
    expect(await text(root, path)).toBe(expected);
  expect(await text(root, "other.md")).toBe(original);
});

test("rewrites canonical document-relative paths with fragments, leaving URLs and lookalikes intact", async () => {
  const unchanged = [
    "[wrong depth](../src/item.ts#L2)",
    "[suffix](../../src/item.ts.old) ../../src/item.tsx",
    "[noncanonical](../../src/./item.ts) ../../src/../src/item.ts",
    "[absolute](/src/item.ts) [other](other/src/item.ts)",
    "[URL](https://example.invalid/../../src/item.ts#L2)",
    "[query URL](https://example.invalid/?next=../../src/item.ts)",
    "other/../../src/item.ts x../../src/item.ts λ../../src/item.ts",
    "../../src/item.tsλ ../../src/item.ts/child",
    "",
  ].join("\n");

  const root = await fixture({
    "src/item.ts": "export const value = 1;\n",
    "docs/guide.md": '[module](../src/item.ts#L2 "Module")\n',
    "docs/nested/guide.md":
      "[module](../../src/item.ts?raw=1#L2)\n" + unchanged,
    "docs/nested/deep/guide.md": "`../../../src/item.ts`\n",
    "README.md": "[outside](../src/item.ts)\n",
  });

  const moves = [["src/item.ts", "src/domain/item.ts"]] as const;
  await moveModules(root, moves);
  expect(await text(root, "docs/guide.md")).toBe(
    '[module](../src/domain/item.ts#L2 "Module")\n',
  );
  expect(await text(root, "docs/nested/guide.md")).toBe(
    "[module](../../src/domain/item.ts?raw=1#L2)\n" + unchanged,
  );
  expect(await text(root, "docs/nested/deep/guide.md")).toBe(
    "`../../../src/domain/item.ts`\n",
  );
  expect(await text(root, "README.md")).toBe("[outside](../src/item.ts)\n");
  await moveModules(root, moves, { check: true });
});

test("preserves unrelated staged, unstaged, untracked and ignored content", async () => {
  const root = await fixture({
    "src/item.ts": "export const value = 1;\n",
    "notes.txt": "base\n",
    ".gitignore": "ignored/\n",
  });

  await put(root, "notes.txt", "staged\n");
  git(root, "add", "notes.txt");
  await put(root, "notes.txt", "unstaged\n");
  await put(root, "scratch.txt", "untracked\n");
  await put(root, "ignored/file.txt", "ignored\n");
  await moveModules(root, [["src/item.ts", "src/domain/item.ts"]]);
  expect(git(root, "show", ":notes.txt")).toBe("staged\n");
  expect(await text(root, "notes.txt")).toBe("unstaged\n");
  expect(await text(root, "scratch.txt")).toBe("untracked\n");
  expect(await text(root, "ignored/file.txt")).toBe("ignored\n");
});

test.each([
  ["src/main.ts", "src/new.ts", "Locked"],
  ["src/config.ts", "src/new.ts", "Locked"],
  ["plugins/opencode/crew/plugin.ts", "src/new.ts", "Locked"],
  ["plugins/opencode/fleet/plugin.ts", "src/new.ts", "Locked"],
  ["src/fleet/plugin.ts", "src/new.ts", "Locked"],
  ["src/missing.ts", "src/new.ts", "Unknown"],
  ["src/item.ts", "src/other.ts", "collision"],
  ["src/item.ts", "src/OTHER.ts", "collision"],
  ["src/item.ts", "src/../new.ts", "Invalid"],
  ["src/item.ts", "/src/new.ts", "Invalid"],
  ["../src/item.ts", "src/new.ts", "Invalid"],
  ["src/item.ts", "src//new.ts", "Invalid"],
  ["src/item.ts", "src/new.js", "extensions"],
  ["src/item.ts", "docs/new.ts", "Invalid"],
])(
  "rejects unsafe mapping %s → %s before mutation",
  async (oldPath, newPath, message) => {
    const root = await fixture({
      "src/item.ts": "export const value = 1;\n",
      "src/other.ts": "export const other = 2;\n",
      "src/main.ts": "export {};\n",
      "src/config.ts": "export {};\n",
      "plugins/opencode/crew/plugin.ts": "export {};\n",
      "plugins/opencode/fleet/plugin.ts": "export {};\n",
      "src/fleet/plugin.ts": "export {};\n",
    });

    const index = git(root, "ls-files", "--stage");
    await expectFailure(
      moveModules(root, [[oldPath ?? "", newPath ?? ""]]),
      message,
    );
    expect(git(root, "ls-files", "--stage")).toBe(index);
    expect(git(root, "status", "--porcelain")).toBe("");
  },
);

test("rejects duplicate, colliding, overlapping and partially invalid batches", async () => {
  const root = await fixture({
    "src/item.ts": "export {};\n",
    "src/other.ts": "export {};\n",
  });

  for (const moves of [
    [
      ["src/item.ts", "src/a.ts"],
      ["src/item.ts", "src/b.ts"],
    ],
    [
      ["src/item.ts", "src/a.ts"],
      ["src/other.ts", "src/a.ts"],
    ],
    [
      ["src/item.ts", "src/a.ts"],
      ["src/other.ts", "src/a.ts/file.ts"],
    ],
    [
      ["src/item.ts", "src/a.ts"],
      ["src/missing.ts", "src/b.ts"],
    ],
  ] satisfies (readonly (readonly [string, string])[])[]) {
    await expectFailure(moveModules(root, moves));
    expect(git(root, "status", "--porcelain")).toBe("");
  }
});

test("rejects source and destination symlinks, including escaping parents", async () => {
  const root = await fixture({
    "src/item.ts": "export {};\n",
    "src/other.ts": "export {};\n",
  });

  const outside = await mkdtemp(join(tmpdir(), "stargate-module-outside-"));
  roots.push(outside);
  await put(outside, "keep.txt", "outside\n");
  await symlink(outside, join(root, "src/escape"));
  await symlink("item.ts", join(root, "src/link.ts"));
  git(root, "add", "src/link.ts");
  git(root, "commit", "--quiet", "-m", "link fixture");
  const status = git(root, "status", "--porcelain");

  for (const moves of [
    [["src/link.ts", "src/new.ts"]],
    [["src/item.ts", "src/escape/item.ts"]],
    [["src/item.ts", "src/link.ts"]],
  ] satisfies (readonly (readonly [string, string])[])[])
    await expectFailure(moveModules(root, moves));
  expect(git(root, "status", "--porcelain")).toBe(status);
  expect(await text(outside, "keep.txt")).toBe("outside\n");
  expect(await Bun.file(join(outside, "item.ts")).exists()).toBe(false);
});

test.each([
  "staged",
  "unstaged",
  "untracked destination",
  "ignored destination",
])("rejects %s affected content without a partial move", async (kind) => {
  const root = await fixture({
    "src/item.ts": "export {};\n",
    "tests/use.ts": 'import "../src/item";\n',
    ".gitignore": "src/domain/\n",
  });

  if (kind === "staged" || kind === "unstaged") {
    await put(root, "tests/use.ts", 'import "../src/item"; // local change\n');

    if (kind === "staged") git(root, "add", "tests/use.ts");
  } else
    await put(
      root,
      kind === "ignored destination" ? "src/domain/item.ts" : "src/new.ts",
      "keep me\n",
    );
  const status = git(root, "status", "--porcelain");
  const index = git(root, "ls-files", "--stage");
  await expectFailure(
    moveModules(root, [
      [
        "src/item.ts",
        kind === "untracked destination" ? "src/new.ts" : "src/domain/item.ts",
      ],
    ]),
  );
  expect(git(root, "status", "--porcelain")).toBe(status);
  expect(git(root, "ls-files", "--stage")).toBe(index);
  expect(await text(root, "src/item.ts")).toBe("export {};\n");
});

test("refuses unresolved moved imports or changed resolution before mutation", async () => {
  const root = await fixture({ "src/item.ts": 'import "./missing";\n' });
  await expectFailure(
    moveModules(root, [["src/item.ts", "src/new/item.ts"]]),
    "Cannot resolve",
  );
  expect(git(root, "status", "--porcelain")).toBe("");
});

test("rejects a move that shadows an existing index import without mutation", async () => {
  const root = await fixture({
    "src/item.ts": "export const value = 1;\n",
    "src/lib/index.ts": "export const value = 2;\n",
    "tests/use.ts": 'import "../src/lib";\n',
  });

  await expectFailure(
    moveModules(root, [["src/item.ts", "src/lib.ts"]]),
    "resolution",
  );
  expect(git(root, "status", "--porcelain")).toBe("");
});

test.each(["directory package", "source/runtime ambiguity"])(
  "refuses %s resolution rather than guessing",
  async (kind) => {
    const root = await fixture(
      kind === "directory package"
        ? {
            "src/lib/package.json": '{"main":"entry.ts"}\n',
            "src/lib/entry.ts": "export const value = 1;\n",
            "src/lib/index.ts": "export const value = 2;\n",
            "tests/use.ts": 'import "../src/lib";\n',
          }
        : {
            "src/lib/entry.ts": "export const value = 1;\n",
            "src/lib/entry.js": "export const value = 2;\n",
            "tests/use.ts": 'import "../src/lib/entry.js";\n',
          },
    );

    await expectFailure(
      moveModules(root, [["src/lib/entry.ts", "src/new.ts"]]),
      "resolution",
    );
    expect(git(root, "status", "--porcelain")).toBe("");
  },
);

test("preserves BOM, CRLF and executable modes while moving across code roots", async () => {
  const root = await fixture({
    "scripts/item.ts":
      '\uFEFFimport "../src/lib";\r\nexport const value = 1;\r\n',
    "src/lib/index.ts": "export {};\r\n",
    "tests/use.ts": 'import "../scripts/item.ts";\r\n',
  });

  await chmod(join(root, "scripts/item.ts"), 0o755);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "mode fixture");

  const moves = [
    ["scripts/item.ts", "perf/nested/item.ts"],
    ["src/lib/index.ts", "src/helper.ts"],
  ] as const;

  await moveModules(root, moves);
  expect(await text(root, "perf/nested/item.ts")).toBe(
    '\uFEFFimport "../../src/helper";\r\nexport const value = 1;\r\n',
  );
  expect(await text(root, "tests/use.ts")).toBe(
    'import "../perf/nested/item.ts";\r\n',
  );
  expect(git(root, "ls-files", "--stage", "perf/nested/item.ts")).toStartWith(
    "100755 ",
  );
  await moveModules(root, moves, { check: true });
});

test.each(["before", "after"])(
  "rolls back moves when git mv fails %s renaming, preserving the real index",
  async (phase) => {
    const root = await fixture({
      "src/item.ts": "export const first = 1;\n",
      "src/other.ts": "export const second = 2;\n",
      "notes.txt": "base\n",
    });

    await put(root, "notes.txt", "staged\n");
    git(root, "add", "notes.txt");
    await put(root, "notes.txt", "unstaged\n");
    const wrapper = await mkdtemp(join(tmpdir(), "stargate-module-git-"));
    roots.push(wrapper);
    const realGit = Bun.which("git");

    if (!realGit) throw new Error("Git is required for module-move tests");
    const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
    await put(
      wrapper,
      "git",
      `#!/bin/sh\nif [ "$1" = mv ] && [ "$3" = src/other.ts ]; then\n  ${phase === "after" ? `${quotedGit} "$@" || exit $?` : ":"}\n  echo 'fixture move failure' >&2\n  exit 1\nfi\nexec ${quotedGit} "$@"\n`,
    );
    await chmod(join(wrapper, "git"), 0o755);
    const status = git(root, "status", "--porcelain");
    const index = await readFile(join(root, ".git/index"));

    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/move-modules.ts"),
        "src/item.ts",
        "src/new/item.ts",
        "src/other.ts",
        "src/new/other.ts",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${wrapper}:${process.env["PATH"] ?? ""}`,
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("fixture move failure");
    expect(git(root, "status", "--porcelain")).toBe(status);
    expect(await readFile(join(root, ".git/index"))).toEqual(index);
    expect(await text(root, "src/item.ts")).toBe("export const first = 1;\n");
    expect(await text(root, "src/other.ts")).toBe("export const second = 2;\n");
    expect(await text(root, "notes.txt")).toBe("unstaged\n");
    expect(await Bun.file(join(root, "src/new/item.ts")).exists()).toBe(false);
  },
);

test.each([
  "statement",
  "string",
  "comment",
  "unrelated",
  "untracked",
  "staged",
  "staged deletion",
  "mode",
])("check rejects %s changes and stays read-only", async (kind) => {
  const root = await fixture({
    "src/item.ts": 'export const value = "original"; // comment\n',
    "notes.txt": "base\n",
  });

  const moves = [["src/item.ts", "src/domain/item.ts"]] as const;
  await moveModules(root, moves);

  if (kind === "statement")
    await put(
      root,
      "src/domain/item.ts",
      'export const changed = "original"; // comment\n',
    );

  if (kind === "string")
    await put(
      root,
      "src/domain/item.ts",
      'export const value = "changed"; // comment\n',
    );

  if (kind === "comment")
    await put(
      root,
      "src/domain/item.ts",
      'export const value = "original"; // changed\n',
    );

  if (kind === "unrelated") await put(root, "notes.txt", "changed\n");

  if (kind === "untracked") await put(root, "extra.txt", "new\n");

  if (kind === "staged") {
    await put(root, "notes.txt", "staged\n");
    git(root, "add", "notes.txt");
    await put(root, "notes.txt", "base\n");
  }

  if (kind === "staged deletion") {
    git(root, "rm", "--cached", "notes.txt");
  }

  if (kind === "mode") await chmod(join(root, "src/domain/item.ts"), 0o755);
  const status = git(root, "status", "--porcelain");
  const index = git(root, "ls-files", "--stage");
  await expectFailure(moveModules(root, moves, { check: true }), "Unexpected");
  expect(git(root, "status", "--porcelain")).toBe(status);
  expect(git(root, "ls-files", "--stage")).toBe(index);
});

test("check reconstructs mappings from an explicit base, without rename detection", async () => {
  const root = await fixture({
    "src/item.ts": "export const value = 1;\n",
    "tests/use.ts": 'import "../src/item";\n',
  });

  const base = git(root, "rev-parse", "HEAD").trim();
  const moves = [["src/item.ts", "src/domain/item.ts"]] as const;
  await moveModules(root, moves);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "move fixture");
  await moveModules(root, moves, { check: true, base });
  expect(git(root, "status", "--porcelain")).toBe("");
  await expectFailure(moveModules(root, moves, { check: true }), "Unknown");
});

test("CLI exposes help and rejects invalid options without touching a fixture", async () => {
  const root = await fixture({ "src/item.ts": "export {};\n" });
  const script = join(import.meta.dir, "../scripts/move-modules.ts");

  const help = Bun.spawnSync([process.execPath, script, "--help"], {
    cwd: root,
  });

  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("--check");

  for (const args of [
    ["--unknown"],
    ["--check", "src/item.ts"],
    ["--base"],
    ["--base", "HEAD", "src/item.ts", "src/new.ts"],
  ]) {
    const result = Bun.spawnSync([process.execPath, script, ...args], {
      cwd: root,
    });

    expect(result.exitCode).toBe(1);
    expect(git(root, "status", "--porcelain")).toBe("");
  }
});
