import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";

const hook = join(import.meta.dir, "../scripts/hooks/touched-zod.sh");
const list = "scripts/hooks/touched-zod-changes.json";
const path = "src/nightly/ready.ts";
const before = 'import { z } from "zod";\nexport const root = "old";\n';
const after = before.replace('"old"', '"new"');

const entry = {
  path,
  issue: "NET-1769",
  reason: "Centralize installation root.",
};

test("an unchanged base entry grants nothing; changed and new entries apply per PR", async () => {
  for (const kind of ["unchanged", "changed", "absent base list"]) {
    const { root, base } = await fixture(
      kind === "absent base list" ? null : JSON.stringify([entry]),
    );

    try {
      await put(root, path, after);
      await put(
        root,
        list,
        JSON.stringify([
          {
            ...entry,
            reason: kind === "changed" ? "New scoped follow-up." : entry.reason,
          },
        ]),
      );
      expect(run(root, base).status).toBe(kind === "unchanged" ? 1 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("missing head list fails closed even for an ordinary clean change", async () => {
  const { root, base } = await fixture();

  try {
    await rm(join(root, list));
    await put(root, "src/clean.ts", "export const n = 1;\n");
    expect(run(root, base).status).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "rename",
  "symlink",
  "gitlink",
  "list symlink",
  "invalid base list",
])("declaration rejects %s", async (kind) => {
  const { root, base } = await fixture(
    kind === "invalid base list" ? "{" : "[]",
  );

  try {
    await put(root, path, after);
    let target = path;

    if (kind === "rename") {
      target = "src/moved.ts";
      await rename(join(root, path), join(root, target));
    }

    if (kind === "symlink") {
      await rm(join(root, path));
      await put(root, "target.ts", after);
      await symlink("../../target.ts", join(root, path));
    }

    if (kind === "gitlink") {
      git(root, "rm", "-f", path);
      git(
        root,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${base},${path}`,
      );
    }

    await put(root, list, JSON.stringify([{ ...entry, path: target }]));

    if (kind === "list symlink") {
      await put(root, "list.json", JSON.stringify([entry]));
      await rm(join(root, list));
      await symlink("../../list.json", join(root, list));
    }

    expect(run(root, base).status).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });

  if (result.status !== 0) throw new Error(result.stderr);

  return result.stdout.trim();
}

async function put(root: string, file: string, text: string) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

async function fixture(baseList: string | null = "[]") {
  const root = await mkdtemp(join(tmpdir(), "declared-zod-"));
  git(root, "init", "-b", "fixture");
  git(root, "config", "user.name", "Hook Test");
  git(root, "config", "user.email", "hook-test@example.invalid");
  await put(root, path, before);

  if (baseList !== null) await put(root, list, baseList);
  git(root, "add", "-A");
  git(root, "commit", "-m", "fixture base");

  return { root, base: git(root, "rev-parse", "HEAD") };
}

function run(root: string, base: string) {
  git(root, "add", "-A");
  git(root, "commit", "-m", "fixture candidate");

  const result = spawnSync("/bin/sh", [hook, base], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });

  return { status: result.status, output: result.stdout + result.stderr };
}

test("declared existing ready and update-notice permit small scoped body/import edits", async () => {
  const { root, base } = await fixture();

  try {
    await put(root, path, after);
    await put(root, list, JSON.stringify([entry]));
    expect(run(root, base)).toEqual({ status: 0, output: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const next = await fixture();

  try {
    const old = before + 'import { syntax } from "./meta-commands";\n';
    await put(next.root, "src/update-notice.ts", old);
    git(next.root, "add", "-A");
    git(next.root, "commit", "-m", "legacy update notice");
    const start = git(next.root, "rev-parse", "HEAD");
    await put(
      next.root,
      "src/update-notice.ts",
      old.replace('"./meta-commands"', '"./meta-command-syntax"'),
    );
    await put(
      next.root,
      list,
      JSON.stringify([
        {
          path: "src/update-notice.ts",
          issue: "NET-1771",
          reason: "Retarget extracted syntax leaf.",
        },
      ]),
    );
    expect(run(next.root, start).status).toBe(0);
  } finally {
    await rm(next.root, { recursive: true, force: true });
  }
});

test.each([
  ["new binding", after.replace("{ z }", "{ z, ZodError }")],
  ["specifier", after.replace('"zod"', '"zod/v4"')],
  ["Zod import whitespace", after.replace("{ z }", "{  z }")],
  ["extra import", after + 'import { ZodError } from "zod";\n'],
  ["dynamic Zod", after + 'const m = import("zod");\n'],
  ["computed loader", after + "const m = import(target);\n"],
  [
    "over budget",
    after +
      Array.from({ length: 19 }, (_, i) => `export const n${i} = ${i};\n`).join(
        "",
      ),
  ],
])("declared file rejects %s", async (_name, text) => {
  const { root, base } = await fixture();

  try {
    await put(root, path, text);
    await put(root, list, JSON.stringify([entry]));
    expect(run(root, base).status).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["invalid JSON", "{"],
  ["wrong issue", JSON.stringify([{ ...entry, issue: "OTHER-1" }])],
  ["missing issue", JSON.stringify([{ path, reason: entry.reason }])],
  ["issue newline", JSON.stringify([{ ...entry, issue: "NET-1769\n" }])],
  ["reason newline", JSON.stringify([{ ...entry, reason: "reason\n" }])],
  ["reason CRLF", JSON.stringify([{ ...entry, reason: "reason\r\n" }])],
  [
    "reason line separator",
    JSON.stringify([{ ...entry, reason: "reason\u2028" }]),
  ],
  [
    "reason paragraph separator",
    JSON.stringify([{ ...entry, reason: "reason\u2029" }]),
  ],
  ["missing reason", JSON.stringify([{ path, issue: "NET-1769" }])],
  ["multiline reason", JSON.stringify([{ ...entry, reason: "first\nsecond" }])],
  ["duplicate", JSON.stringify([entry, entry])],
  [
    "traversal",
    JSON.stringify([{ ...entry, path: "src/../src/nightly/ready.ts" }]),
  ],
  ["extra field", JSON.stringify([{ ...entry, bypass: true }])],
])("declaration fails closed for %s", async (_name, text) => {
  const { root, base } = await fixture();

  try {
    await put(root, path, after);
    await put(root, list, text);
    expect(run(root, base).status).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("twenty changed lines pass; undeclared and added/copied Zod remain strict", async () => {
  for (const kind of ["boundary", "undeclared", "added", "copy", "gain Zod"]) {
    const { root, base } = await fixture();

    try {
      if (kind === "boundary")
        await put(
          root,
          path,
          after +
            Array.from(
              { length: 18 },
              (_, i) => `export const n${i} = ${i};\n`,
            ).join(""),
        );
      else if (kind === "gain Zod") {
        await put(root, "src/clean.ts", "export const value = 1;\n");
        git(root, "add", "-A");
        git(root, "commit", "-m", "clean base");
      } else await put(root, path, after);

      const comparison =
        kind === "gain Zod" ? git(root, "rev-parse", "HEAD") : base;

      const target = kind === "gain Zod" ? "src/clean.ts" : "src/copied.ts";

      if (["added", "copy", "gain Zod"].includes(kind))
        await put(root, target, before);

      if (kind !== "undeclared")
        await put(
          root,
          list,
          JSON.stringify([
            entry,
            ...(["added", "copy", "gain Zod"].includes(kind)
              ? [{ ...entry, path: target }]
              : []),
          ]),
        );
      expect(run(root, comparison).status).toBe(kind === "boundary" ? 0 : 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("guard reads declarations from committed head, not dirty working copy", async () => {
  const { root, base } = await fixture();

  try {
    await put(root, path, after);
    git(root, "add", "-A");
    git(root, "commit", "-m", "undeclared head");
    await put(root, list, JSON.stringify([entry]));

    const result = spawnSync("/bin/sh", [hook, base], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
