import { afterAll, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readArchive,
  validateArchive,
  verifyExtracted,
} from "../src/nightly/archive";
import { type TarEntry, tarball } from "./tar";

const root = "stargate-v1.0.0";
const check = (entries: TarEntry[], withRoot = root) =>
  validateArchive(readArchive(tarball(entries)), withRoot);
const loose = (entries: TarEntry[]) =>
  validateArchive(readArchive(tarball(entries)));
const base: TarEntry[] = [
  { path: `${root}/`, type: "5" },
  { path: `${root}/src/`, type: "5" },
  { path: `${root}/src/main.ts`, data: "export {};\n" },
];

describe("release archive validation", () => {
  test("accepts one real root with contained files and links", () => {
    const entries = check([
      ...base,
      { path: `${root}/entry`, type: "2", link: "src/main.ts" },
      { path: `${root}/src/self`, type: "2", link: "../src" },
      {
        path: `${root}/x`,
        pax: { path: `${root}/${"long-name-".repeat(15)}.ts` },
      },
    ]);
    expect(entries.map((entry) => entry.type)).toEqual([
      "directory",
      "directory",
      "file",
      "symlink",
      "symlink",
      "file",
    ]);
    expect(entries.at(-1)?.path).toContain("long-name-long-name");
  });

  test("rejects a root symlink and entries written through it", () => {
    expect(() =>
      check([
        { path: root, type: "2", link: "/tmp/opencode" },
        { path: `${root}/payload`, data: "x" },
      ]),
    ).toThrow("archive-invalid");
    expect(() =>
      check([
        ...base,
        { path: `${root}/d`, type: "2", link: "src" },
        { path: `${root}/d/payload`, data: "x" },
      ]),
    ).toThrow("archive-invalid");
  });

  test("requires the exact root directory entry", () => {
    expect(() => check(base.slice(1))).toThrow("archive-invalid");
    expect(() => check(base, "stargate-v2.0.0")).toThrow("archive-invalid");
    expect(() => check([...base, { path: "other/file", data: "x" }])).toThrow(
      "archive-invalid",
    );
  });

  test("rejects absolute paths, dot-dot, duplicates and pax escapes", () => {
    for (const entries of [
      [...base, { path: "/etc/cron.d/x", data: "x" }],
      [...base, { path: `${root}/../x`, data: "x" }],
      [...base, { path: `${root}/./x`, data: "x" }],
      [...base, { path: `${root}/src/main.ts`, data: "again" }],
      [...base, { path: `${root}/ok`, pax: { path: `${root}/../../x` } }],
    ] satisfies TarEntry[][])
      expect(() => check(entries)).toThrow("archive-invalid");
  });

  test("rejects hard links, devices and FIFOs", () => {
    for (const type of ["1", "3", "6"] as const)
      expect(() =>
        check([
          ...base,
          { path: `${root}/x`, type, link: `${root}/src/main.ts` },
        ]),
      ).toThrow("archive-invalid");
  });

  test("rejects links that leave the root", () => {
    for (const link of ["../../etc/passwd", "/etc/passwd", "../"])
      expect(() =>
        check([...base, { path: `${root}/x`, type: "2", link }]),
      ).toThrow("archive-invalid");
    // Without a root (proxy assets) a link may not leave the archive either.
    expect(() => loose([{ path: "a", type: "2", link: "../outside" }])).toThrow(
      "archive-invalid",
    );
    expect(
      loose([{ path: "cli-proxy-api", data: "bin", mode: 0o755 }]),
    ).toHaveLength(1);
  });

  test("rejects corrupt headers and non-gzip data", () => {
    expect(() => readArchive(tarball(base, true))).toThrow("archive-invalid");
    expect(() => readArchive(new TextEncoder().encode("plain"))).toThrow(
      "archive-invalid",
    );
  });

  test("only git archive's commit comment may be a global pax header", () => {
    const comment = { comment: "a".repeat(40) };
    expect(
      check([{ ...base[0], global: comment } as TarEntry, ...base.slice(1)]),
    ).toHaveLength(3);
    for (const global of [
      // tar applies a global linkpath/path to every later entry.
      { linkpath: "/tmp/opencode/outside" },
      { path: "../escape" },
      { comment: "not a commit" },
      { ...comment, "GNU.sparse.size": "16777216" },
    ])
      expect(() =>
        check([
          { path: `${root}/`, type: "5", global },
          { path: `${root}/bin`, type: "2", link: "src/main.ts" },
        ]),
      ).toThrow("archive-invalid");
    // A global header anywhere but first is refused too.
    expect(() =>
      check([...base, { path: `${root}/late`, data: "x", global: comment }]),
    ).toThrow("archive-invalid");
  });

  test("rejects sparse, GNU long names and non-POSIX headers", () => {
    for (const entries of [
      [
        ...base,
        {
          path: `${root}/s`,
          pax: { "GNU.sparse.size": "16777216", "GNU.sparse.map": "0,1" },
        },
      ],
      [...base, { path: `${root}/m`, pax: { mtime: "1" } }],
      [...base, { path: `${root}/sparse`, type: "S" }],
      [...base, { path: `${root}/long`, type: "L", data: "x" }],
      [...base, { path: `${root}/longlink`, type: "K" }],
      [
        ...base,
        {
          path: `${root}/gnu`,
          data: "x",
          magic: "ustar  \u0000",
          gnuSparse: true,
        },
      ],
      [...base, { path: `${root}/dirdata`, type: "5", size: 512 }],
    ] satisfies TarEntry[][])
      expect(() => check(entries)).toThrow("archive-invalid");
  });

  test("old-GNU headers with an empty GNU area are accepted (release assets)", () => {
    expect(
      validateArchive(
        readArchive(
          tarball([
            { path: "cli-proxy-api", data: "bin", magic: "ustar  \u0000" },
          ]),
        ),
      ),
    ).toHaveLength(1);
    expect(() =>
      readArchive(
        tarball([
          {
            path: "cli-proxy-api",
            data: "bin",
            magic: "ustar  \u0000",
            global: { comment: "a".repeat(40) },
          },
        ]),
      ),
    ).not.toThrow();
  });

  test("caps the total extracted size", () => {
    const big = [...base, { path: `${root}/big`, data: "x".repeat(4096) }];
    expect(check(big)).toHaveLength(4);
    expect(() =>
      validateArchive(readArchive(tarball(big), 2048), root),
    ).toThrow("archive-invalid");
  });
});

const extracted = await mkdtemp("/tmp/opencode/stargate-extract-");
afterAll(() => rm(extracted, { recursive: true, force: true }));

describe("post-extraction check", () => {
  const entries = readArchive(
    tarball([
      ...base,
      { path: `${root}/entry`, type: "2", link: "src/main.ts" },
    ]),
  );
  const tree = async (name: string) => {
    const dir = join(extracted, name);
    await mkdir(join(dir, root, "src"), { recursive: true });
    await writeFile(join(dir, root, "src", "main.ts"), "export {};\n");
    await symlink("src/main.ts", join(dir, root, "entry"));
    return dir;
  };

  test("accepts exactly the validated tree", async () => {
    await verifyExtracted(await tree("ok"), entries);
  });

  test("rejects extra paths, changed links and hard links", async () => {
    const extra = await tree("extra");
    await symlink("/tmp/opencode", join(extra, root, "src", "escape"));
    await expect(verifyExtracted(extra, entries)).rejects.toThrow(
      "archive-invalid",
    );
    const moved = await tree("moved");
    await rm(join(moved, root, "entry"));
    await symlink("/etc/passwd", join(moved, root, "entry"));
    await expect(verifyExtracted(moved, entries)).rejects.toThrow(
      "archive-invalid",
    );
    const hard = await tree("hard");
    await link(
      join(hard, root, "src", "main.ts"),
      join(extracted, "outside-hardlink"),
    );
    await expect(verifyExtracted(hard, entries)).rejects.toThrow(
      "archive-invalid",
    );
  });

  test("rejects a chain of links that resolves outside the root", async () => {
    // Each link looks contained on its own: back -> .. is the root, and
    // escape -> deep/back/../../outside normalises to root/outside.
    const chain = readArchive(
      tarball([
        { path: `${root}/`, type: "5" },
        { path: `${root}/deep/`, type: "5" },
        { path: `${root}/deep/back`, type: "2", link: ".." },
        { path: `${root}/escape`, type: "2", link: "deep/back/../../outside" },
      ]),
    );
    expect(validateArchive(chain, root)).toHaveLength(4);
    const dir = join(extracted, "chain");
    await mkdir(join(dir, root, "deep"), { recursive: true });
    await symlink("..", join(dir, root, "deep", "back"));
    await symlink("deep/back/../../outside", join(dir, root, "escape"));
    // The kernel resolves it to <extracted>/outside, which exists.
    await mkdir(join(extracted, "outside"), { recursive: true });
    await expect(verifyExtracted(dir, chain, root)).rejects.toThrow(
      "archive-invalid",
    );
  });

  test("rejects a dangling link", async () => {
    const dangling = readArchive(
      tarball([
        { path: `${root}/`, type: "5" },
        { path: `${root}/missing`, type: "2", link: "nowhere" },
      ]),
    );
    const dir = join(extracted, "dangling");
    await mkdir(join(dir, root), { recursive: true });
    await symlink("nowhere", join(dir, root, "missing"));
    await expect(verifyExtracted(dir, dangling, root)).rejects.toThrow(
      "archive-invalid",
    );
  });
});
