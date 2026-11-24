import { expect, test } from "bun:test";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inspectAttachment } from "../src/chat/attachments/attachments";
import { ordinaryFileDirectory, publishedFileDirectory } from "./file-fixture";

test("hidden release temp keeps ordinary files visible and publisher scratch private", async () => {
  const base = await ordinaryFileDirectory("stargate-file-fixture-");
  const previous = process.env["TMPDIR"];

  try {
    const hidden = join(base, ".staging-test", "tmp");
    await mkdir(hidden, { recursive: true, mode: 0o700 });
    process.env["TMPDIR"] = hidden;
    const ordinary = await ordinaryFileDirectory("ordinary-");
    const published = await publishedFileDirectory("published-");
    expect(dirname(ordinary)).toBe(base);
    expect(dirname(published)).toBe(join(hidden, "opencode"));

    for (const directory of [ordinary, published, dirname(published)]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }

    const proof = join(ordinary, "proof.txt");
    await writeFile(proof, "proof");
    expect((await inspectAttachment({ path: proof, caption: "" })).size).toBe(
      5,
    );
    const hiddenProof = join(published, "proof.txt");
    await writeFile(hiddenProof, "proof");
    await expect(
      inspectAttachment({ path: hiddenProof, caption: "" }),
    ).rejects.toMatchObject({ reason: "denied" });
  } finally {
    if (previous === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = previous;
    }

    await rm(base, { recursive: true, force: true });
  }
});

test("publisher fixtures refuse a nonprivate temp before creating scratch", async () => {
  const base = await ordinaryFileDirectory("stargate-file-fixture-");
  const previous = process.env["TMPDIR"];

  try {
    const wide = join(base, "wide");
    await mkdir(wide);
    await chmod(wide, 0o755);
    process.env["TMPDIR"] = wide;
    await expect(publishedFileDirectory("refused-")).rejects.toThrow(
      "private owned TMPDIR",
    );
    await expect(stat(join(wide, "opencode"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (previous === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = previous;
    }

    await rm(base, { recursive: true, force: true });
  }
});
