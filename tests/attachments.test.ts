import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Result, Schema } from "effect";
import {
  AttachmentUnavailable,
  checkPreparedAttachments,
  inspectAttachment,
  maxAttachmentBytes,
  maxAttachments,
  type PreparedAttachment,
  parseAttachments,
  preparedAttachmentSchema,
  readPreparedAttachment,
} from "../src/chat/attachments/attachments";
import { ordinaryFileDirectory } from "./file-fixture";

const cleanup: string[] = [];

afterEach(async () => {
  for (const directory of cleanup.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function directory() {
  const path = await ordinaryFileDirectory("stargate-attachments-");
  cleanup.push(path);

  return path;
}

// 1x1 transparent PNG and a minimal one-page PDF.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

const pdf = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("prepared metadata keeps code-point bounds, MIME spelling and strict fields", () => {
  const input = {
    sha256: "a".repeat(64),
    size: 1,
    mime: "Image/PNG",
    name: "😀".repeat(255),
    caption: "😀".repeat(1000),
    path: "/report.png",
  };

  const decode = Schema.decodeUnknownResult(preparedAttachmentSchema);
  const parsed = decode(input);

  if (Result.isFailure(parsed)) {
    throw new Error("Valid prepared metadata rejected");
  }

  expect(parsed.success).toEqual(input);
  expect(Object.keys(parsed.success)).toEqual([
    "path",
    "caption",
    "name",
    "mime",
    "size",
    "sha256",
  ]);

  for (const invalid of [
    { ...input, name: `${input.name}😀` },
    { ...input, caption: `${input.caption}😀` },
    { ...input, size: -0 },
    { ...input, size: Infinity },
    { ...input, extra: true },
    Object.assign(Object.create({ extra: true }), input),
  ]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
});

async function rejection(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return error;
  }

  throw new Error("Expected attachment rejection");
}

async function unavailable(work: Promise<unknown>, reason: string) {
  const error = await rejection(work);
  expect(error).toBeInstanceOf(AttachmentUnavailable);
  expect(error).toMatchObject({ reason, message: "Attachment unavailable" });

  return error;
}

test("explicit local image markers publish any file type and leave only captions", () => {
  expect(
    parseAttachments(
      "Proof:\n![Login screen](file:///tmp/opencode/shot.png)\nReport ![Q3](file:///tmp/opencode/q3.pdf).",
    ),
  ).toEqual({
    text: "Proof:\nLogin screen\nReport Q3.",
    files: [
      { path: "/tmp/opencode/shot.png", caption: "Login screen" },
      { path: "/tmp/opencode/q3.pdf", caption: "Q3" },
    ],
  });
  expect(
    parseAttachments(
      "![a](file:///tmp/x.png) again ![b](FILE:///tmp/x.png) ![](file:///tmp/y.png)",
    ),
  ).toEqual({
    text: "a again b ",
    files: [
      { path: "/tmp/x.png", caption: "a" },
      { path: "/tmp/y.png", caption: "" },
    ],
  });
  expect(parseAttachments(String.raw`![a \] b](file:///tmp/z.png)`)).toEqual({
    text: "a ] b",
    files: [{ path: "/tmp/z.png", caption: "a ] b" }],
  });
});

test("encoded spaces, angle destinations and Unicode decode to exact paths", () => {
  const unicode = "/tmp/opencode/résumé ✓/画面.png";
  expect(
    parseAttachments(
      `![one](file:///tmp/opencode/my%20shot.png) ![two](<file:///tmp/opencode/my shot 2.png>) ![three](${pathToFileURL(unicode).href}) ![four](file:///tmp/opencode/画面.png)`,
    ).files.map(({ path }) => path),
  ).toEqual([
    "/tmp/opencode/my shot.png",
    "/tmp/opencode/my shot 2.png",
    unicode,
    "/tmp/opencode/画面.png",
  ]);
});

test("unsafe file URLs never publish and never reveal their paths", () => {
  for (const destination of [
    "file://host/tmp/a.png",
    "file://localhost/tmp/a.png",
    "file:/tmp/a.png",
    "file:///tmp/a.png?raw=1",
    "file:///tmp/a.png#frag",
    "file:///tmp/a%2Fb.png",
    "file:///tmp/a%00.png",
    "file:///tmp/../etc/passwd",
    "file:///tmp/%2e%2e/etc/passwd",
    "file:///tmp/./a.png",
    "file:///tmp//a.png",
    "file:///tmp/dir/",
    "file:///tmp/a%ZZ.png",
    "file:///tmp/a\\b.png",
    "<file:///tmp/a\tb.png>",
  ]) {
    const parsed = parseAttachments(`Look ![cap](${destination}) done`);
    expect(parsed.files).toEqual([]);
    expect(parsed.text).not.toContain("/tmp");
    expect(parsed.text).not.toContain("etc/passwd");
  }
});

test("plain, bare and code local references are hidden but never published", () => {
  const parsed = parseAttachments(
    [
      "See [the source](file:///home/me/private/src.ts) and file:///home/me/secret.txt",
      'Auto <file:///home/me/auto.txt>, img <img src="file:///home/me/i.png">',
      "Inline `![x](file:///home/me/inline.png)` stays inert.",
      "```md",
      "![example](file:///home/me/example.png)",
      "```",
      "~~~",
      "![tilde](file:///home/me/tilde.png)",
      "~~~",
      "Remote ![chart](https://example.com/chart.png) stays.",
      "Escaped \\![no](file:///home/me/escaped.png).",
    ].join("\n"),
  );

  expect(parsed.files).toEqual([]);
  expect(parsed.text).not.toContain("/home/me");
  expect(parsed.text).toContain("See the source and file:///…");
  expect(parsed.text).toContain("![example](file:///…");
  expect(parsed.text).toContain(
    "Remote ![chart](https://example.com/chart.png) stays.",
  );

  // Odd characters cannot cut a hidden path short, in prose or in code.
  for (const sample of [
    "bare file:///home/me/a)b/private.txt end",
    "```\n![x](<file:///home/me/with space/private.png>)\n```",
    "`<file:///home/me/open angle/private.png`",
  ]) {
    expect(parseAttachments(sample).text).not.toContain("private");
  }

  // An unclosed fence remains code to the end of the answer.
  const unclosed = parseAttachments(
    "```\n![late](file:///home/me/late.png)\nstill code",
  );

  expect(unclosed.files).toEqual([]);
  expect(unclosed.text).not.toContain("/home/me");
  // Unmatched backticks are literal, so the marker after them is active.
  expect(
    parseAttachments("a ` b ![c](file:///tmp/c.png)").files.map(
      ({ path }) => path,
    ),
  ).toEqual(["/tmp/c.png"]);
});

test("streamed previews withhold partial local markers and never expose a path", () => {
  const answer =
    "Done! See [1] and ![Screen shot](file:///tmp/opencode/secret%20dir/shot.png) plus [link](https://example.com/x) and `file:///tmp/opencode/code.txt`.";

  for (let end = 0; end <= answer.length; end++) {
    const preview = parseAttachments(answer.slice(0, end), false);
    expect(preview.text).not.toContain("/tmp/opencode");
    expect(preview.text).not.toContain("secret");
    expect(preview.text).not.toMatch(/file:\/[^/…]/);
    expect(
      answer.startsWith(preview.text) || preview.text.includes("Screen shot"),
    ).toBe(true);
  }

  expect(parseAttachments("Wow![", false).text).toBe("Wow");
  expect(parseAttachments("Wow![", true).text).toBe("Wow![");
  expect(parseAttachments("Wow! It works", false).text).toBe("Wow! It works");
  expect(parseAttachments("see [docs](https://exa", false).text).toBe(
    "see [docs](https://exa",
  );
  expect(parseAttachments("see [docs](fi", false).text).toBe("see ");
  expect(parseAttachments("see [1]", true).text).toBe("see [1]");
  expect(parseAttachments(answer).text).toBe(
    "Done! See [1] and Screen shot plus [link](https://example.com/x) and `file:///…`.",
  );
});

test("real PNG and PDF files inspect, then reread with their recorded identity", async () => {
  const root = await directory();
  const image = join(root, "login screen ✓.png");
  const report = join(root, "report.pdf");
  await writeFile(image, png);
  await writeFile(report, pdf);

  const parsed = parseAttachments(
    `![Login](${pathToFileURL(image).href}) ![](${pathToFileURL(report).href})`,
  );

  const prepared = await Promise.all(
    parsed.files.map((file) => inspectAttachment(file)),
  );

  expect(prepared).toEqual([
    {
      path: image,
      caption: "Login",
      name: "login screen ✓.png",
      mime: "image/png",
      size: png.byteLength,
      sha256: sha256(png),
    },
    {
      path: report,
      caption: "",
      name: "report.pdf",
      mime: "application/pdf",
      size: pdf.byteLength,
      sha256: sha256(pdf),
    },
  ]);
  checkPreparedAttachments(prepared);
  const [first, second] = prepared;

  if (!first || !second) {
    throw new Error("Missing prepared fixtures");
  }

  expect(
    await readPreparedAttachment(JSON.parse(JSON.stringify(first))),
  ).toEqual({
    name: "login screen ✓.png",
    mime: "image/png",
    data: png,
  });
  expect((await readPreparedAttachment(second)).data).toEqual(pdf);
});

test("symlinks, FIFOs, directories, empty and oversized files are refused", async () => {
  const root = await directory();
  const real = join(root, "real.png");
  await writeFile(real, png);
  const link = join(root, "link.png");
  await symlink(real, link);
  await mkdir(join(root, "realdir"));
  await writeFile(join(root, "realdir", "inside.png"), png);
  await symlink(join(root, "realdir"), join(root, "linkdir"));
  const fifo = join(root, "pipe.png");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const empty = join(root, "empty.png");
  await writeFile(empty, "");
  const large = join(root, "large.pdf");
  await writeFile(large, "");
  await truncate(large, maxAttachmentBytes + 1);

  const cases: [string, string][] = [
    [link, "denied"],
    [join(root, "linkdir", "inside.png"), "denied"],
    [fifo, "type"],
    [join(root, "realdir"), "type"],
    [empty, "size"],
    [large, "size"],
    [join(root, "missing.png"), "missing"],
  ];

  for (const [path, reason] of cases) {
    const error = await unavailable(
      inspectAttachment({ path, caption: "x" }),
      reason,
    );

    expect(String(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain(root);
  }
});

test("credential and machine-state paths are denied before any filesystem access", async () => {
  const root = await directory();

  for (const name of [
    "id_ed25519",
    "server.key",
    "cert.pem",
    "stargate.json",
    "stargate.json.env",
    "app.env",
    "state.sqlite",
    "state.sqlite-wal",
    "data.db",
    "credentials.json",
    "secrets.yaml",
    "token.txt",
    "auth.json",
  ]) {
    // Missing files still report denial: the name blocks the open itself.
    await unavailable(
      inspectAttachment({ path: join(root, name), caption: "" }),
      "denied",
    );
  }

  for (const path of [
    join(root, ".ssh", "notes.png"),
    join(root, ".env"),
    "/proc/self/environ",
    "/sys/kernel/notes",
    "/dev/zero",
    "/etc/hostname",
    "/run/user/1000/bus",
  ]) {
    await unavailable(inspectAttachment({ path, caption: "" }), "denied");
  }

  for (const path of [
    "relative.png",
    "/tmp/opencode/../x.png",
    "/tmp//x.png",
  ]) {
    await unavailable(inspectAttachment({ path, caption: "" }), "invalid");
  }

  // Ordinary operator screenshot locations stay publishable.
  const shot = join(root, "Screenshot 2026-11-09.png");
  await writeFile(shot, png);
  expect((await inspectAttachment({ path: shot, caption: "" })).name).toBe(
    "Screenshot 2026-11-09.png",
  );
});

test("changed, replaced or invalid prepared files are never uploaded", async () => {
  const root = await directory();
  const path = join(root, "proof.png");
  await writeFile(path, png);
  const prepared = await inspectAttachment({ path, caption: "Proof" });
  const same = Uint8Array.from(png);
  same[same.length - 1] = (same.at(-1) ?? 0) ^ 1;
  await writeFile(path, same);
  await unavailable(readPreparedAttachment(prepared), "changed");
  await writeFile(path, pdf);
  await unavailable(readPreparedAttachment(prepared), "changed");
  await rm(path);
  await symlink(join(root, "elsewhere.png"), path);
  await writeFile(join(root, "elsewhere.png"), png);
  await unavailable(readPreparedAttachment(prepared), "denied");
  const forged: PreparedAttachment = { ...prepared, path: "/etc/hostname" };
  await unavailable(readPreparedAttachment(forged), "denied");
  await unavailable(
    readPreparedAttachment({ ...prepared, sha256: "nothex" }),
    "invalid",
  );
});

test("caller cancellation stops inspection and batch limits precede reads", async () => {
  const root = await directory();
  const path = join(root, "proof.png");
  await writeFile(path, png);
  const reason = new Error("caller cancelled");
  expect(
    await rejection(
      inspectAttachment({ path, caption: "" }, AbortSignal.abort(reason)),
    ),
  ).toBe(reason);
  const prepared = await inspectAttachment({ path, caption: "" });
  checkPreparedAttachments(Array(maxAttachments).fill(prepared));
  expect(() =>
    checkPreparedAttachments(Array(maxAttachments + 1).fill(prepared)),
  ).toThrow("Too many attachments");
  const big = { ...prepared, size: maxAttachmentBytes };
  expect(() => checkPreparedAttachments([big, big, big])).toThrow(
    "total size limit",
  );
});
