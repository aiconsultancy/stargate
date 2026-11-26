import { afterAll, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckoutDiff,
  type CheckoutDiffInput,
  DiffOutputParser,
  diffLimits,
  statusEntries,
  utf8Prefix,
} from "../src/coordination/crew/reporting/fleet-status";
import {
  createCheckoutDiffReader,
  createCrewGitReader,
} from "../src/coordination/crew/workspace/git-state";
import {
  spawnGit,
  streamGit,
} from "../src/coordination/crew/workspace/git-runner";
import {
  liveFleetGit,
  readWorktree,
} from "../src/coordination/crew/workspace/git-status";

const root = await realpath(
  await mkdtemp(join(tmpdir(), "stargate-crew-diff-")),
);

afterAll(() => rm(root, { recursive: true, force: true }));

const signal = new AbortController().signal;
const checkoutGit = liveFleetGit(spawnGit, streamGit);
const readDiff = createCheckoutDiffReader(checkoutGit);

async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );

  const output = await new Response(child.stdout).text();

  if ((await child.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}`);
  }

  return output.trim();
}

let count = 0;

/** A checkout on `feature`, one commit ahead of `origin/main`. */
async function checkout(files: Record<string, string> = {}) {
  const directory = join(root, `repo-${count++}`);
  const origin = `${directory}.git`;
  await mkdir(directory);
  await git(directory, "init");

  for (const [path, text] of Object.entries({ base: "base\n", ...files })) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), text);
  }

  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "base");
  await git(root, "clone", "--quiet", "--bare", directory, origin);
  await git(directory, "remote", "add", "origin", origin);
  await git(directory, "fetch", "--quiet", "origin");
  await git(directory, "remote", "set-head", "origin", "main");
  await git(directory, "checkout", "--quiet", "-b", "feature");

  return directory;
}

const input = (
  request: CheckoutDiffInput["request"],
  rest: Partial<Omit<CheckoutDiffInput, "request">> = {},
): CheckoutDiffInput => ({
  member: "worker",
  project: null,
  mode: "branch",
  request,
  ...rest,
});

const list = (
  directory: string,
  rest: Partial<Omit<CheckoutDiffInput, "request">> = {},
  start = 0,
) => readDiff(directory, input({ kind: "list", start }, rest), signal);

async function listed(
  directory: string,
  rest: Partial<Omit<CheckoutDiffInput, "request">> = {},
) {
  const result = await list(directory, rest);

  if (result.kind !== "list") {
    throw new Error(`Expected a list, got ${result.kind}`);
  }

  return result;
}

const patch = (directory: string, path: string, at?: string, offset = 0) =>
  readDiff(
    directory,
    input({ kind: "patch", path, offset }, at ? { at } : {}),
    signal,
  );

const content = (
  directory: string,
  path: string,
  side?: "old" | "new",
  offset = 0,
  rest: Partial<Omit<CheckoutDiffInput, "request">> = {},
) =>
  readDiff(
    directory,
    input({ kind: "content", path, offset, ...(side && { side }) }, rest),
    signal,
  );

function bytesOf(result: CheckoutDiff) {
  if (result.kind !== "content") {
    throw new Error(`Expected content, got ${result.kind}`);
  }

  return Buffer.from(result.data, "base64");
}

test("utf8Prefix cuts between characters and counts invalid bytes as replacements", () => {
  const text = Buffer.from("aé€😀");

  expect(utf8Prefix(text, 100, true)).toBe(text.length);
  expect(utf8Prefix(text, 2, true)).toBe(1);
  expect(utf8Prefix(text, 3, true)).toBe(3);
  expect(utf8Prefix(text, 9, true)).toBe(6);

  // A cut-off character waits for more bytes unless nothing follows.
  const cut = text.subarray(0, text.length - 1);
  expect(utf8Prefix(cut, 100, false)).toBe(6);
  expect(utf8Prefix(cut, 100, true)).toBe(cut.length);

  // Each invalid byte decodes to U+FFFD: three bytes.
  const invalid = Buffer.from([0x61, 0xff, 0xc0, 0x80, 0xed, 0xa0, 0x80]);
  expect(utf8Prefix(invalid, 4, true)).toBe(2);
  expect(utf8Prefix(invalid, 100, true)).toBe(invalid.length);
});

test("statusEntries keeps both paths of a rename and refuses malformed output", () => {
  expect(statusEntries("R  new\0old\0?? dir/\0")).toEqual([
    { code: "R ", path: "new", from: "old" },
    { code: "??", path: "dir/" },
  ]);
  expect(statusEntries("R  incomplete\0")).toBeNull();
  expect(statusEntries("?? missing terminator")).toBeNull();
});

test("the diff parser reads the same entries from any chunking", async () => {
  const directory = await checkout({ a: "1\n2\n3\n", b: "x\n", t: "file\n" });
  await writeFile(join(directory, "a"), "1\nTWO\n3\n");
  await git(directory, "mv", "b", "c");
  await unlink(join(directory, "t"));
  await symlink("a", join(directory, "t"));
  await writeFile(join(directory, "bin"), Buffer.from([0, 1, 2, 3]));
  await git(directory, "add", "-A");

  const output = Buffer.from(
    await git(
      directory,
      "diff",
      "--cached",
      "--raw",
      "--numstat",
      "-p",
      "-z",
      "--no-abbrev",
      "-M",
      "origin/main",
    ),
  );

  const parse = (size: number) => {
    const parser = new DiffOutputParser(
      true,
      (entries) =>
        new Map(entries.map((_entry, index) => [index, { from: 0, to: 1e6 }])),
    );

    for (let start = 0; start < output.length; start += size) {
      parser.feed(output.subarray(start, start + size));
    }

    // Git's trailing newline was trimmed by the fixture helper.
    parser.feed(Buffer.from("\n"));
    parser.end();

    return parser.entries.map((entry) => ({
      ...entry,
      kept: Buffer.concat(entry.kept).toString(),
    }));
  };

  const whole = parse(output.length);
  expect(whole.map(({ status, path }) => [status, path])).toEqual([
    ["M", "a"],
    ["A", "bin"],
    ["R", "c"],
    ["T", "t"],
  ]);
  expect(whole[0]?.kept).toBe("@@ -1,3 +1,3 @@\n 1\n-2\n+TWO\n 3\n");
  expect(whole[1]?.additions).toBeNull();
  expect(whole[2]?.previousPath).toBe("b");
  // A type change is two patch sections: both stay with its one entry.
  expect(whole[3]?.kept).toContain("-file");
  expect(whole[3]?.kept).toContain("+a");

  for (const size of [1, 2, 7, 64]) {
    expect(parse(size)).toEqual(whole);
  }

  const short = new DiffOutputParser(true);
  short.feed(output.subarray(0, output.indexOf(0) + 1));
  expect(() => short.end()).toThrow();
});

test("branch mode lists commits, staged, unstaged and untracked changes in byte order", async () => {
  const directory = await checkout({
    "modified.txt": "one\ntwo\n",
    "removed.txt": "gone\n",
    "moved.txt": "same\n",
    ".gitignore": ".env\nignored/\n",
    ".env.tracked": "TOKEN=1\n",
  });

  await writeFile(join(directory, "committed.txt"), "c\n");
  await git(directory, "add", "committed.txt");
  await git(directory, "commit", "-m", "work");
  await writeFile(join(directory, "modified.txt"), "one\nTWO\n");
  await git(directory, "rm", "--quiet", "removed.txt");
  await git(directory, "mv", "moved.txt", "renamed.txt");
  await writeFile(join(directory, "Zed"), "upper\n");
  await writeFile(join(directory, "é"), "accent\n");
  await writeFile(join(directory, ".env"), "SECRET=1\n");
  await mkdir(join(directory, "ignored"));
  await writeFile(join(directory, "ignored", "x"), "ignored\n");
  await writeFile(join(directory, ".env.tracked"), "TOKEN=2\n");

  const result = await listed(directory);
  const head = await git(directory, "rev-parse", "HEAD");
  const base = await git(directory, "rev-parse", "origin/main");

  expect(result).toMatchObject({
    branch: "feature",
    head,
    base: { ref: "origin/main", commit: base },
    unstable: false,
    total: 7,
    next: null,
  });
  expect(result.files.map((file) => [file.path, file.status])).toEqual([
    [".env.tracked", "modified"],
    ["Zed", "added"],
    ["committed.txt", "added"],
    ["modified.txt", "modified"],
    ["removed.txt", "removed"],
    ["renamed.txt", "renamed"],
    ["é", "added"],
  ]);
  expect(result.files[1]).toEqual({
    path: "Zed",
    previousPath: null,
    status: "added",
    additions: 1,
    deletions: 0,
    untracked: true,
    size: 6,
    patch: "@@ -0,0 +1 @@\n+upper\n",
  });
  expect(result.files[4]).toMatchObject({
    size: 5,
    patch: "@@ -1 +0,0 @@\n-gone\n",
  });
  expect(result.files[5]).toMatchObject({
    previousPath: "moved.txt",
    patch: null,
  });
  expect(result.additions).toBe(5);
  expect(result.deletions).toBe(3);

  // Ignored files are never listed and never served.
  expect(await patch(directory, ".env")).toEqual({
    kind: "absent",
    fingerprint: result.fingerprint,
  });
  expect((await content(directory, ".env")).kind).toBe("absent");
  expect((await content(directory, "ignored/x")).kind).toBe("absent");

  // Neither is an unchanged tracked file.
  expect((await patch(directory, "base")).kind).toBe("absent");
  expect((await content(directory, "base", "new")).kind).toBe("absent");
});

test("committed and working modes split the branch at HEAD", async () => {
  const directory = await checkout({ "file.txt": "a\n" });
  await writeFile(join(directory, "file.txt"), "b\n");
  await git(directory, "commit", "-qam", "commit");
  await writeFile(join(directory, "file.txt"), "c\n");
  await writeFile(join(directory, "new.txt"), "n\n");

  const committed = await listed(directory, { mode: "committed" });
  const working = await listed(directory, { mode: "working" });
  const branch = await listed(directory);

  expect(committed.files.map(({ path, patch }) => [path, patch])).toEqual([
    ["file.txt", "@@ -1 +1 @@\n-a\n+b\n"],
  ]);
  expect(working.files.map(({ path, patch }) => [path, patch])).toEqual([
    ["file.txt", "@@ -1 +1 @@\n-b\n+c\n"],
    ["new.txt", "@@ -0,0 +1 @@\n+n\n"],
  ]);
  expect(branch.files.map(({ path, patch }) => [path, patch])).toEqual([
    ["file.txt", "@@ -1 +1 @@\n-a\n+c\n"],
    ["new.txt", "@@ -0,0 +1 @@\n+n\n"],
  ]);

  // Every mode has the same fingerprint and base, which crew Git state shares.
  expect(
    new Set([committed, working, branch].map((r) => r.fingerprint)).size,
  ).toBe(1);
  expect(working.base).toEqual(branch.base);

  const state = await createCrewGitReader(checkoutGit)(directory, signal);
  expect(state?.fingerprint).toBe(branch.fingerprint);

  // The committed side of a changed file comes from the object store.
  expect(
    bytesOf(
      await content(directory, "file.txt", "new", 0, { mode: "committed" }),
    ).toString(),
  ).toBe("b\n");
  expect(
    bytesOf(
      await content(directory, "file.txt", "old", 0, { mode: "working" }),
    ).toString(),
  ).toBe("b\n");
  expect(bytesOf(await content(directory, "file.txt")).toString()).toBe("c\n");
});

test("the fingerprint moves with HEAD, the index, origin and any changed file", async () => {
  const directory = await checkout({ "file.txt": "a\n" });
  await mkdir(join(directory, "dir"));
  await writeFile(join(directory, "dir", "untracked"), "1\n");
  const seen = new Set<string>();

  const next = async () => {
    const { fingerprint } = await listed(directory);
    expect(seen.has(fingerprint)).toBe(false);
    seen.add(fingerprint);

    return fingerprint;
  };

  const first = await next();
  expect((await listed(directory)).fingerprint).toBe(first);

  // The same size: only the modification time differs.
  await writeFile(join(directory, "dir", "untracked"), "2\n");
  await utimes(join(directory, "dir", "untracked"), 1, 1);
  await next();
  await git(directory, "add", "dir/untracked");
  await next();
  await git(directory, "commit", "-qm", "c");
  await next();
  await git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
  await next();

  // A pinned read of an older state is stale.
  expect(await patch(directory, "dir/untracked", first)).toEqual({
    kind: "stale",
    fingerprint: [...seen].at(-1) ?? "",
  });
});

test("a checkout that keeps changing is retried once, then marked unstable or stale", async () => {
  const directory = await checkout();
  let writes = 0;

  const moving = (path: string, abort: AbortSignal) => {
    const live = checkoutGit(path, abort);

    return {
      ...live,
      isolated: async <T>(
        head: string | null,
        use: Parameters<typeof live.isolated<T>>[1],
      ) => {
        await writeFile(join(directory, "moving"), `${writes++}\n`);

        return live.isolated(head, use);
      },
    };
  };

  const read = createCheckoutDiffReader(moving);

  const result = await read(
    directory,
    input({ kind: "list", start: 0 }),
    signal,
  );

  expect(result).toMatchObject({ kind: "list", unstable: true });
  expect(writes).toBe(2);

  const pinned = await read(
    directory,
    input(
      { kind: "patch", path: "moving", offset: 0 },
      {
        at: result.kind === "list" ? result.fingerprint : "",
      },
    ),
    signal,
  );

  expect(pinned.kind).toBe("stale");
});

test("symbolic links serve their own text, never their target", async () => {
  const directory = await checkout({ "file.txt": "a\n" });
  await symlink("/etc/passwd", join(directory, "outside"));
  await symlink(root, join(directory, "dirlink"));

  const result = await listed(directory);
  expect(result.files.find(({ path }) => path === "outside")).toMatchObject({
    status: "added",
    kind: "symlink",
    untracked: true,
    size: "/etc/passwd".length,
  });

  expect(bytesOf(await content(directory, "outside")).toString()).toBe(
    "/etc/passwd",
  );
  // The patch route of a link is its text as a patch, too.
  expect(await patch(directory, "outside")).toMatchObject({
    kind: "patch",
    file: {
      patch: "@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n",
    },
  });

  // A path through a linked directory is refused at every step.
  expect(
    await readWorktree(directory, "dirlink/repo-0/base", 0, 10),
  ).toBeUndefined();
  expect(await readWorktree(directory, ".git/config", 0, 10)).toBeUndefined();
  expect(await readWorktree(directory, "../escape", 0, 10)).toBeUndefined();
});

test("a type change is one modified entry", async () => {
  const directory = await checkout({ kind: "file\n" });
  await unlink(join(directory, "kind"));
  await symlink("base", join(directory, "kind"));

  const result = await listed(directory);
  expect(result.files.find(({ path }) => path === "kind")).toMatchObject({
    status: "modified",
    kind: "symlink",
    additions: 1,
    deletions: 1,
  });
  expect(bytesOf(await content(directory, "kind", "old")).toString()).toBe(
    "file\n",
  );
  expect(bytesOf(await content(directory, "kind", "new")).toString()).toBe(
    "base",
  );
});

test("an untracked embedded repository is an added submodule with no bytes", async () => {
  const directory = await checkout();
  const inner = join(directory, "inner");
  await mkdir(inner);
  await git(inner, "init", "--quiet");
  await git(inner, "commit", "--quiet", "--allow-empty", "-m", "inner");

  const result = await listed(directory);
  expect(result.files).toEqual([
    {
      path: "inner",
      previousPath: null,
      status: "added",
      additions: 1,
      deletions: 0,
      untracked: true,
      patch: expect.stringContaining("+Subproject commit "),
      kind: "submodule",
    },
  ]);
  expect((await content(directory, "inner")).kind).toBe("absent");
  expect(await patch(directory, "inner")).toMatchObject({ kind: "patch" });
});

test("binary and empty files answer with bytes; each side exists only where the file does", async () => {
  const directory = await checkout({ "old.bin": "\0old" });
  await unlink(join(directory, "old.bin"));
  await writeFile(join(directory, "new.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(directory, "empty"), "");

  const result = await listed(directory);
  expect(
    result.files.map(({ path, binary, additions, size }) => [
      path,
      binary,
      additions,
      size,
    ]),
  ).toEqual([
    ["empty", undefined, 0, 0],
    ["new.bin", true, null, 3],
    ["old.bin", true, null, 4],
  ]);

  expect(await patch(directory, "empty")).toMatchObject({
    kind: "content",
    side: "new",
    offset: 0,
    size: 0,
    data: "",
    next: null,
  });
  expect(await patch(directory, "old.bin")).toMatchObject({
    kind: "content",
    side: "old",
    size: 4,
  });
  expect(bytesOf(await patch(directory, "new.bin"))).toEqual(
    Buffer.from([0, 1, 2]),
  );
  expect((await content(directory, "new.bin", "old")).kind).toBe("absent");
  expect((await content(directory, "old.bin", "new")).kind).toBe("absent");
  expect((await content(directory, "new.bin", "new", 4)).kind).toBe("absent");
  expect(await content(directory, "new.bin", "new", 3)).toMatchObject({
    size: 3,
    data: "",
    next: null,
  });
});

test("large content is paged in mebibytes from both sides", async () => {
  const size = diffLimits.page + 1000;
  const old = Buffer.alloc(size, 1);
  const directory = await checkout({ large: old.toString("latin1") });
  const fresh = Buffer.alloc(size + 1, 2);
  await writeFile(join(directory, "large"), fresh);

  for (const [side, expected] of [
    ["old", old],
    ["new", fresh],
  ] as const) {
    const first = await content(directory, "large", side);
    expect(first).toMatchObject({
      offset: 0,
      size: expected.length,
      next: diffLimits.page,
    });
    expect(bytesOf(first).length).toBe(diffLimits.page);
    const second = await content(directory, "large", side, diffLimits.page);
    expect(second).toMatchObject({ next: null });
    expect(Buffer.concat([bytesOf(first), bytesOf(second)])).toEqual(
      Buffer.from(expected.toString("latin1"), "latin1"),
    );
  }
});

test("long patches are cut between characters and continue by byte offset", async () => {
  // Three-byte characters in lines of 41 bytes: cuts land mid-character.
  const line = "€".repeat(13) + "\n";
  const directory = await checkout();
  await writeFile(join(directory, "long"), line.repeat(40_000));

  const result = await listed(directory);
  const listedFile = result.files[0];
  expect(Buffer.byteLength(listedFile?.patch ?? "")).toBeLessThanOrEqual(
    diffLimits.inlinePatch,
  );
  expect(listedFile?.patchNext).toBe(
    Buffer.byteLength(listedFile?.patch ?? ""),
  );

  const pages: string[] = [];
  let offset: number | undefined = 0;

  while (offset !== undefined) {
    const page = await patch(directory, "long", result.fingerprint, offset);

    if (page.kind !== "patch") {
      throw new Error(page.kind);
    }

    const text = page.file.patch ?? "";
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(diffLimits.page);
    expect(text).not.toContain("\uFFFD");
    pages.push(text);
    offset = page.file.patchNext;
  }

  expect(pages.length).toBe(2);
  expect(pages.join("")).toBe(
    `@@ -0,0 +1,40000 @@\n${`+${line}`.repeat(40_000)}`,
  );
  expect(pages[0]?.startsWith(listedFile?.patch ?? "-")).toBe(true);

  // An offset past the end is not a page.
  const end = Buffer.byteLength(pages.join(""));
  expect((await patch(directory, "long", result.fingerprint, end)).kind).toBe(
    "absent",
  );
});

test("a list page ends before the file that would pass 4 MiB, and at 1,000 files", async () => {
  const directory = await checkout();
  const big = `${"x".repeat(99)}\n`.repeat(700);

  for (let index = 0; index < 70; index++) {
    await writeFile(
      join(directory, `big-${String(index).padStart(2, "0")}`),
      big,
    );
  }

  const first = await listed(directory);

  const inline = (files: typeof first.files) =>
    files.reduce((sum, file) => sum + Buffer.byteLength(file.patch ?? ""), 0);

  expect(first.total).toBe(70);
  expect(first.files.length).toBe(
    Math.floor(diffLimits.listPatches / diffLimits.inlinePatch),
  );
  expect(inline(first.files)).toBeLessThanOrEqual(diffLimits.listPatches);
  expect(first.next).toBe(first.files.length);

  const rest = await list(
    directory,
    { at: first.fingerprint },
    first.next ?? 0,
  );

  expect(rest).toMatchObject({
    kind: "list",
    total: 70,
    next: null,
    fingerprint: first.fingerprint,
  });
  expect(rest.kind === "list" && rest.files[0]?.path).toBe(
    `big-${first.files.length}`,
  );

  // Past the end is not a page; a moved checkout is stale.
  expect((await list(directory, { at: first.fingerprint }, 70)).kind).toBe(
    "absent",
  );
  await appendFile(join(directory, "big-00"), "more\n");
  expect((await list(directory, { at: first.fingerprint }, 64)).kind).toBe(
    "stale",
  );

  const many = await checkout();

  for (let index = 0; index < 1001; index++) {
    await writeFile(join(many, `f${String(index).padStart(4, "0")}`), "");
  }

  const page = await listed(many);
  expect(page.files.length).toBe(diffLimits.files);
  expect(page.next).toBe(diffLimits.files);
  const last = await list(many, { at: page.fingerprint }, diffLimits.files);
  expect(last.kind === "list" && last.files.map(({ path }) => path)).toEqual([
    "f1000",
  ]);
});

test("an unborn branch has no head; without origin there is no base", async () => {
  const directory = join(root, `unborn-${count++}`);
  await mkdir(directory);
  await git(directory, "init", "--quiet");
  await writeFile(join(directory, "first"), "1\n");

  const branch = await listed(directory);
  expect(branch).toMatchObject({
    head: null,
    base: null,
    branch: "main",
    total: 1,
  });
  expect(branch.files[0]).toMatchObject({
    path: "first",
    status: "added",
    untracked: true,
  });
  expect((await listed(directory, { mode: "committed" })).files).toEqual([]);
});

test("no checkout is missing; a broken one fails", async () => {
  expect(await list(join(root, "nowhere"))).toEqual({ kind: "missing" });

  const plain = join(root, `plain-${count++}`);
  await mkdir(plain);
  expect(await list(plain)).toEqual({ kind: "missing" });

  const directory = await checkout();
  await writeFile(join(directory, ".git", "index"), "broken");
  await writeFile(join(directory, "new"), "n\n");
  await expect(list(directory)).rejects.toThrow();
});

test("a linked worktree's split index lists untracked files", async () => {
  const directory = await checkout({ tracked: "t\n" });
  const linked = join(root, `linked-${count++}`);
  await git(directory, "worktree", "add", "--quiet", "-b", "linked", linked);
  await git(linked, "update-index", "--split-index");
  await writeFile(join(linked, "tracked"), "changed\n");
  await git(linked, "add", "tracked");
  await writeFile(join(linked, "untracked"), "u\n");

  const result = await listed(linked);
  expect(result.files.map(({ path, untracked }) => [path, untracked])).toEqual([
    ["tracked", undefined],
    ["untracked", true],
  ]);
});
