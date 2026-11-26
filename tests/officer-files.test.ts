import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
    chmodSync(exports, 0o2750);
    writeFileSync(join(staging, "output.pdf"), "sample-pdf", { mode: 0o600 });
    symlinkSync(join(staging, "output.pdf"), join(staging, "linked.pdf"));

    linkSync(join(staging, "output.pdf"), join(staging, "hardlinked.pdf"));
    writeFileSync(join(staging, "sample.pdf"), "other", { mode: 0o600 });
    writeFileSync(join(staging, "writable.txt"), "unsafe", { mode: 0o600 });

    chmodSync(join(staging, "writable.txt"), 0o620);

    const fifo = spawnSync("mkfifo", [join(staging, "pipe.txt")]);

    expect(fifo.status).toBe(0);

    const inputs = [
      { source: "staged", fileName: "sample.pdf" },
      {
        source: "text",
        fileName: "meeting notes.md",
        text: "Requested minutes",
      },
      { source: "staged", fileName: "linked.pdf" },
      { source: "staged", fileName: "hardlinked.pdf" },
      { source: "staged", fileName: "writable.txt" },
      { source: "staged", fileName: "pipe.txt" },
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

    // Exercise the service's prohibition on requesting setuid or setgid bits.
    const preload = join(root, "restrict-chmod.ts");
    writeFileSync(
      preload,
      `import { open } from "node:fs/promises";
const handle = await open(import.meta.filename);
const prototype = Object.getPrototypeOf(handle);
await handle.close();
const chmod = prototype.chmod;
prototype.chmod = function (mode) {
  if ((mode & 0o6000) || (mode === 0o750 && process.env.FAIL_PUBLISH)) {
    throw new Error("Operation not permitted");
  }
  return chmod.call(this, mode);
};`,
    );

    const command = [
      "--no-env-file",
      "--no-install",
      "--preload",
      preload,
      "scripts/officer-files.ts",
      "--staging",
      staging,
      "--exports",
      exports,
      "--socket",
      join(root, "unused.sock"),
    ];

    const child = spawnSync(process.execPath, command, {
      input: requests.join("\n") + "\n",
      encoding: "utf8",
    });

    expect(child.status).toBe(0);

    const replies = child.stdout
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

      const path = fileURLToPath(url);

      expect(statSync(path).mode & 0o777).toBe(0o640);
      expect(statSync(join(path, "..")).mode & 0o7777).toBe(0o750);
      expect(statSync(path).gid).toBe(statSync(exports).gid);
      expect(statSync(join(path, "..")).gid).toBe(statSync(exports).gid);

      return readFileSync(path, "utf8");
    });

    const beforeFailure = readdirSync(exports).sort();

    const failure = spawnSync(process.execPath, command, {
      input: requests[0] + "\n",
      encoding: "utf8",
      env: { ...process.env, FAIL_PUBLISH: "1" },
    });

    expect(failure.status).toBe(0);
    expect(JSON.parse(failure.stdout).result.isError).toBe(true);
    expect(readdirSync(exports).sort()).toEqual(beforeFailure);

    expect(files).toEqual(["other", "Requested minutes"]);
    expect(replies.slice(2).map(({ result }) => result.isError)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type RelayRequest = {
  id: number;
  method: string;
  params: { name?: string; arguments: Record<string, unknown> };
};

function envelope(request: RelayRequest, content: unknown) {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: content },
  };
}

async function startHelper(
  roots: string[],
  relay: string[],
  inputs: Record<string, unknown>[],
  tool = "prepare_file",
) {
  const request = (
    id: number,
    method: string,
    params: Record<string, unknown> = {},
  ) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

  const requests = [
    request(0, "initialize", { protocolVersion: "2025-11-25" }),
    request(1, "tools/list"),
    ...inputs.map((args, id) =>
      request(id + 2, "tools/call", { name: tool, arguments: args }),
    ),
  ];

  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      "scripts/officer-files.ts",
      ...roots,
      ...relay,
    ],
    {
      stdin: new Blob([requests.join("\n"), "\n"]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [output, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(stderr);
  }

  return output
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          result: {
            protocolVersion?: string;
            tools?: { name: string }[];
            isError?: boolean;
            content?: { text: string }[];
          };
        },
    );
}

function prepared(
  result: Awaited<ReturnType<typeof startHelper>>[number] | undefined,
) {
  return JSON.parse(result?.result.content?.[0]?.text ?? "{}") as {
    fileName: string;
    marker?: string;
    reference?: string;
    sizeBytes: number;
  };
}

test("officer file helper verifies issue membership, escaped media, permissions and upload identity", async () => {
  // The repeated bytes encode as '+' characters, which .NET can Unicode-escape
  // Inside an MCP text result. The outer envelope escapes each backslash again.
  const raw = Buffer.alloc(2 * 1024 * 1024, new Uint8Array([0xfb, 0xef, 0xbe]));
  const mediaId = randomUUID();
  const uploadId = randomUUID();
  const reference = `UPL-${Buffer.from(uploadId.replaceAll("-", ""), "hex").toString("base64url")}`;
  const knownReference = `UPL-${"A".repeat(22)}`;

  const item = {
    mediaId,
    kind: "image",
    fileName: "test.png",
    contentType: "image/png",
    sizeBytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };

  const base64 = raw.toString("base64");

  const escaped = JSON.stringify({ ...item, base64 }).replaceAll(
    "+",
    "\\u002B",
  );

  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "officer-issue-files-")),
  );

  const socket = join(root, "api.sock");

  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      const rpc = (await request.json()) as RelayRequest;

      expect(request.headers.get("X-Subspace-Agent")).toBe("fixture");
      expect(new URL(request.url).pathname).toBe("/mcp");

      if (rpc.method === "initialize") {
        return Response.json(
          { id: rpc.id, result: { protocolVersion: "2025-06-18" } },
          { headers: { "Mcp-Session-Id": "fixture-session" } },
        );
      }

      expect(request.headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
      expect(request.headers.get("Mcp-Session-Id")).toBe("fixture-session");

      if (rpc.method === "notifications/initialized") {
        return new Response(null, { status: 204 });
      }

      const args = rpc.params.arguments;

      switch (rpc.params.name) {
        case "subspace_list_attachments":
          if (args["issue"] === "DEMO-2") {
            return Response.json(envelope(rpc, { items: [] }));
          }

          if (args["cursor"] === undefined) {
            return Response.json(
              envelope(rpc, { items: [], nextCursor: "page2" }),
            );
          }

          expect(args["cursor"]).toBe("page2");

          return Response.json(
            envelope(rpc, {
              items: [
                args["issue"] === "DEMO-3"
                  ? { ...item, sha256: "0".repeat(64) }
                  : item,
              ],
            }),
          );
        case "subspace_get_issue_image": {
          expect(args["mediaId"]).toBe(mediaId);

          const wire = JSON.stringify({
            id: rpc.id,
            result: { content: [{ type: "text", text: escaped }] },
          });

          expect(wire.length).toBeGreaterThan(14 * 1024 * 1024);

          return new Response(`event: message\ndata: ${wire}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        case "subspace_get_chat_upload":
          expect(args["includeBytes"]).toBe(true);

          return Response.json(
            envelope(rpc, {
              upload: { ...item, reference: knownReference },
              base64,
            }),
          );
        case "subspace_create_chat_upload":
          expect(args).toEqual({
            uploadId,
            fileName: item.fileName,
            contentType: item.contentType,
            base64,
          });

          return Response.json(
            envelope(rpc, {
              reference,
              sha256: item.sha256,
              sizeBytes: raw.length,
            }),
          );
        default:
          throw new Error("Unexpected file tool call");
      }
    },
  });

  try {
    const issue = { source: "issue", issue: "DEMO-1", mediaId };

    const replies = await startHelper(
      ["--staging", root, "--exports", root],
      ["--socket", socket, "--actor", "fixture"],
      [
        issue,
        { ...issue, chatUploadId: uploadId },
        { ...issue, issue: "DEMO-2" },
        { ...issue, issue: "DEMO-3" },
        { source: "upload", reference: knownReference },
        { source: "upload", reference: `UPL-${"B".repeat(22)}` },
      ],
    );

    expect(replies[0]?.result.protocolVersion).toBe("2025-11-25");
    expect(replies[1]?.result.tools?.[0]?.name).toBe("prepare_file");
    expect(prepared(replies[2]).marker).toContain("test.png");
    expect(prepared(replies[3])).toEqual({
      fileName: "test.png",
      sizeBytes: raw.length,
      reference,
    });
    expect(replies[4]?.result.isError).toBe(true);
    expect(replies[5]?.result.isError).toBe(true);
    expect(prepared(replies[6]).sizeBytes).toBe(raw.length);
    expect(replies[7]?.result.isError).toBe(true);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("legacy staged uploads use the same verified receipt and keep the existing tool name", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "officer-legacy-upload-")),
  );

  const fileName = "proof.txt";
  const data = "approved evidence";
  const uploadId = randomUUID();
  const reference = `UPL-${Buffer.from(uploadId.replaceAll("-", ""), "hex").toString("base64url")}`;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const rpc = (await request.json()) as RelayRequest;

      if (rpc.method === "initialize") {
        return Response.json({
          id: rpc.id,
          result: { protocolVersion: "2025-03-26" },
        });
      }

      if (rpc.method === "notifications/initialized") {
        return new Response(null, { status: 204 });
      }

      expect(rpc.params.name).toBe("subspace_create_chat_upload");
      expect(rpc.params.arguments).toEqual({
        fileName,
        uploadId,
        contentType: "text/plain",
        base64: Buffer.from(data).toString("base64"),
      });

      return Response.json(
        envelope(rpc, {
          reference,
          sizeBytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        }),
      );
    },
  });

  try {
    writeFileSync(join(root, `subspace-share-${fileName}`), data, {
      mode: 0o600,
    });

    const replies = await startHelper(
      ["--staging", root, "--legacy-upload"],
      ["--port", String(server.port)],
      [{ fileName, uploadId }],
      "upload_file",
    );

    expect(replies[1]?.result.tools?.[0]?.name).toBe("upload_file");
    expect(prepared(replies[2])).toEqual({
      fileName,
      reference,
      sizeBytes: data.length,
    });
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy REST uploads use the signing socket without a caller-supplied actor header", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "officer-rest-upload-")),
  );

  const socket = join(root, "api.sock");
  const fileName = "proof.txt";
  const uploadId = randomUUID();
  const evidence = "requested proof";
  const reference = `UPL-${Buffer.from(uploadId.replaceAll("-", ""), "hex").toString("base64url")}`;
  let posted = 0;

  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      posted++;
      expect(new URL(request.url).pathname).toBe("/api/v1/chat/uploads");
      expect(request.headers.has("X-Subspace-Agent")).toBe(false);
      expect(await request.json()).toEqual({
        uploadId,
        fileName,
        contentType: "text/plain",
        base64: Buffer.from(evidence).toString("base64"),
      });

      return Response.json(
        {
          reference,
          sizeBytes: evidence.length,
          sha256: createHash("sha256").update(evidence).digest("hex"),
        },
        { status: 201 },
      );
    },
  });

  try {
    writeFileSync(join(root, `subspace-share-${fileName}`), evidence, {
      mode: 0o600,
    });

    const replies = await startHelper(
      ["--staging", root, "--legacy-upload", "--rest"],
      ["--socket", socket, "--actor", "untrusted-actor"],
      [{ fileName, uploadId }],
      "upload_file",
    );

    expect(posted).toBe(1);
    expect(prepared(replies[2])).toEqual({
      fileName,
      reference,
      sizeBytes: evidence.length,
    });
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare_file renders a labelled Markdown issue preview through the officer socket without a shell", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "officer-preview-mcp-")),
  );

  const socket = join(root, "api.sock");
  const browser = join(root, "browser.ts");
  const mediaId = randomUUID();
  const raw = Buffer.from("# Requested release notes\n\n- Approved change\n");

  const item = {
    mediaId,
    kind: "file",
    fileName: "notes.md",
    contentType: "text/markdown",
    sizeBytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };

  const published = new Set<string>();

  const api = Bun.serve({
    unix: socket,
    async fetch(request) {
      const rpc = (await request.json()) as RelayRequest;

      if (rpc.method === "initialize") {
        return Response.json({
          id: rpc.id,
          result: { protocolVersion: "2025-03-26" },
        });
      }

      if (rpc.method === "notifications/initialized") {
        return new Response(null, { status: 204 });
      }

      const tool = rpc.params.name;

      if (tool) {
        published.add(tool);
      }

      if (tool === "subspace_list_attachments") {
        expect(rpc.params.arguments["issue"]).toBe("DEMO-1");

        return Response.json(envelope(rpc, { items: [item] }));
      }

      if (tool === "subspace_get_attachment") {
        expect(rpc.params.arguments["mediaId"]).toBe(mediaId);

        return Response.json(
          envelope(rpc, { ...item, base64: raw.toString("base64") }),
        );
      }

      throw new Error("A preview must not create a chat upload.");
    },
  });

  try {
    writeFileSync(
      browser,
      `export const chromium = { async launch(options) {
      if (options.chromiumSandbox !== true) throw new Error();
      return { async close() {}, async newContext(settings) {
        if (!settings.offline || settings.javaScriptEnabled) throw new Error();
        return { async route() {}, async newPage() { return {
          async setContent(html) {
            if (!html.includes("<h1>Requested release notes</h1>") || !html.includes("notes.md")) throw new Error();
          },
          async evaluate() { return 625; },
          async screenshot() {
            return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
          },
        }; } };
      } };
    } };`,
    );

    const replies = await startHelper(
      ["--staging", root, "--exports", root, "--playwright", browser],
      ["--socket", socket],
      [{ source: "issue", issue: "DEMO-1", mediaId, preview: "teams" }],
    );

    const result = prepared(replies[2]);

    expect(result).toMatchObject({
      fileName: "notes-preview-1.png",
      originalFileName: "notes.md",
      page: 1,
      pages: 1,
    });
    expect(published).toEqual(
      new Set(["subspace_list_attachments", "subspace_get_attachment"]),
    );
    const url = /\((file:\/\/[^)]+)\)$/.exec(result.marker ?? "")?.[1];

    if (!url) {
      throw new Error("Missing Teams publication marker");
    }

    const bytes = readFileSync(fileURLToPath(url));

    expect(bytes[25]).toBe(3);
  } finally {
    await api.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the full file tool uses the local agent's REST identity and verifies issue membership", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "officer-rest-files-")));
  const mediaId = randomUUID();
  const payload = "approved REST attachment";

  const item = {
    mediaId,
    fileName: "notes.md",
    sizeBytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };

  let downloads = 0;

  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("X-Subspace-Agent")).toBe("fixture-captain");
      const { pathname } = new URL(request.url);

      if (pathname === "/api/v1/issues/DEMO-1/attachments") {
        return Response.json({ items: [item], nextCursor: null });
      }

      if (pathname === "/api/v1/issues/attachments/" + mediaId) {
        downloads++;

        return new Response(payload);
      }

      return Response.json({ items: [], nextCursor: null });
    },
  });

  try {
    const replies = await startHelper(
      ["--staging", root, "--exports", root, "--rest"],
      [
        "--endpoint",
        `http://127.0.0.1:${api.port}/mcp`,
        "--actor",
        "fixture-captain",
      ],
      [
        { source: "issue", issue: "DEMO-1", mediaId },
        { source: "issue", issue: "DEMO-2", mediaId },
      ],
    );

    expect(prepared(replies[2])).toMatchObject({
      fileName: "notes.md",
      sizeBytes: payload.length,
    });
    expect(replies[3]?.result.isError).toBe(true);
    expect(downloads).toBe(1);
  } finally {
    await api.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
