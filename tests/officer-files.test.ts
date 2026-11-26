import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("officer file tools prepare requested local and written documents without shell or issue access", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "officer-files-")));
  const staging = join(root, "stage");
  const exports = join(root, "exports");

  try {
    mkdirSync(staging);
    mkdirSync(exports);
    writeFileSync(join(staging, "output.pdf"), "sample-pdf", { mode: 0o600 });
    symlinkSync(join(staging, "output.pdf"), join(staging, "linked.pdf"));

    const inputs = [
      { source: "staged", fileName: "output.pdf" },
      {
        source: "text",
        fileName: "meeting notes.md",
        text: "Requested minutes",
      },
      { source: "staged", fileName: "linked.pdf" },
      { source: "staged", fileName: "../output.pdf" },
      { source: "text", fileName: "secrets.txt", text: "private" },
      { source: "issue", issue: "X-1", mediaId: "invalid", exports: "/tmp" },
    ];

    const requests = inputs.map((args, id) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "prepare_file", arguments: args },
      }),
    );

    const process = spawnSync(
      "python3",
      [
        "-I",
        "scripts/officer_files.py",
        "--staging",
        staging,
        "--exports",
        exports,
        "--socket",
        join(root, "unused.sock"),
      ],
      { input: requests.join("\n") + "\n", encoding: "utf8" },
    );

    expect(process.status).toBe(0);

    const replies = process.stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            result: { isError?: boolean; content: { text: string }[] };
          },
      );

    const files = replies.slice(0, 2).map(({ result }) => {
      const value = JSON.parse(result.content[0]?.text ?? "{}") as {
        marker: string;
      };

      const url = /\((file:\/\/[^)]+)\)$/.exec(value.marker)?.[1];

      if (!url) {
        throw new Error("Missing publication marker");
      }

      return readFileSync(fileURLToPath(url), "utf8");
    });

    expect(files).toEqual(["sample-pdf", "Requested minutes"]);
    expect(replies.slice(2).map(({ result }) => result.isError)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("officer file helper verifies issue membership, bytes, permissions and upload identity", () => {
  const result = spawnSync(
    "python3",
    ["-I", "-B", "tests/officer-files-fixture.py"],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
});
