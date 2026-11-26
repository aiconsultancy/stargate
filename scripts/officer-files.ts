import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Result, Schema } from "effect";
import { officerRequestLines } from "./officer-stdio";
import { type PreviewBrowser, renderMarkdownPreview } from "./markdown-preview";

import { RestFiles } from "./officer-rest-files";

const fileLimit = 10 * 1024 * 1024;
const legacyUploadLimit = 25_000_000;
const textLimit = 65_536;
const versions = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);
const initialVersion = "2025-03-26";

const chatTypes = new Map([
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["txt", "text/plain"],
  ["text", "text/plain"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["pdf", "application/pdf"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["zip", "application/zip"],
]);

const textTypes = new Set(["md", "markdown", "txt", "text", "csv"]);

const prepareTool = {
  name: "prepare_file",
  description:
    "Prepare an issue attachment, an existing Subspace chat upload reference, a named file in your configured staging directory, or a new text document for a requested reply. Default output is a local file publication marker. To create an IRC attachment card readable by all active Subspace members for 30 days, supply a fresh chatUploadId and reuse it on retry. For a labelled Teams image preview of Markdown or text, set preview to teams and use page for additional pages.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", enum: ["upload", "issue", "staged", "text"] },
      chatUploadId: { type: "string", format: "uuid" },
      issue: { type: "string" },
      reference: { type: "string" },
      mediaId: { type: "string" },
      fileName: { type: "string" },
      text: { type: "string", maxLength: textLimit },
      preview: { type: "string", enum: ["teams"] },
      page: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["source"],
    additionalProperties: false,
  },
};

const uploadTool = {
  name: "upload_file",
  description:
    "Upload a file explicitly staged at /tmp/subspace-share-<fileName> to temporary chat storage. All active members can read it for 30 days. Include the returned UPL reference only in the authorised IRC reply. Reuse uploadId on retry.",
  inputSchema: {
    type: "object",
    properties: {
      fileName: { type: "string" },
      uploadId: { type: "string", format: "uuid" },
    },
    required: ["fileName", "uploadId"],
    additionalProperties: false,
  },
};

const chatUploadId = Schema.optionalKey(Schema.String);

const previewFields = {
  preview: Schema.optionalKey(Schema.Literal("teams")),
  page: Schema.optionalKey(Schema.Int),
};

const argumentsSchema = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("upload"),
    reference: Schema.String,
    ...previewFields,
  }),
  Schema.Struct({
    source: Schema.Literal("issue"),
    issue: Schema.String,
    mediaId: Schema.String,
    chatUploadId,
    ...previewFields,
  }),
  Schema.Struct({
    source: Schema.Literal("staged"),
    fileName: Schema.String,
    chatUploadId,
    ...previewFields,
  }),
  Schema.Struct({
    source: Schema.Literal("text"),
    fileName: Schema.String,
    text: Schema.String,
    chatUploadId,
    ...previewFields,
  }),
]);

const decodeArguments = Schema.decodeUnknownResult(argumentsSchema, {
  onExcessProperty: "error",
});

const decodeUploadArguments = Schema.decodeUnknownResult(
  Schema.Struct({ fileName: Schema.String, uploadId: Schema.String }),
  { onExcessProperty: "error" },
);

const mediaFields = {
  fileName: Schema.String,
  sizeBytes: Schema.Int,
  sha256: Schema.optionalKey(Schema.NullOr(Schema.String)),
};

const mediaPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      ...mediaFields,
      mediaId: Schema.String,
      contentType: Schema.String,
      kind: Schema.Literals(["file", "image"]),
    }),
  ),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const issueBody = Schema.Struct({
  ...mediaFields,
  contentType: Schema.String,
  base64: Schema.String,
});

const chatItem = Schema.Struct({ ...mediaFields, reference: Schema.String });
const chatBody = Schema.Struct({ upload: chatItem, base64: Schema.String });

const uploadReceipt = Schema.Struct({
  reference: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Int,
});

const replySchema = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Int,
    result: Schema.Unknown,
  }),
);

const toolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(
    Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
  ),
});

const requestSchema = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(
      Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])),
    ),
    method: Schema.String,
    params: Schema.optionalKey(
      Schema.Struct({
        protocolVersion: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
        arguments: Schema.optionalKey(Schema.Unknown),
      }),
    ),
  }),
);

type Relay = ({ socket: string } | { port: number } | { endpoint: string }) & {
  actor?: string;
};

type FileConfig = {
  staging: string;
  exports: string;
  browser?: PreviewBrowser;
  rest: boolean;
};

type Config = Relay &
  (FileConfig | { staging: string; legacyUpload: true; rest: boolean });

/** Only these messages are safe for the officer to see. */
class Refused extends Error {}

function suffix(name: string) {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

function safeName(name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,179}$/.test(name) || /[ .]$/.test(name)) {
    throw new Refused("Use a plain file name without directories.");
  }

  if (
    !name.includes(".") ||
    !(chatTypes.has(suffix(name)) || ["csv", "pptx"].includes(suffix(name)))
  ) {
    throw new Refused("Unsupported file type.");
  }

  if (/^(credentials?|passwords?|secrets?|tokens?|id)[._ -]/i.test(name)) {
    throw new Refused("This file name is reserved.");
  }

  return name;
}

function uuid(input: string) {
  const hex = input
    .replace(/^urn:uuid:/, "")
    .replace(/^\{|\}$/g, "")
    .replaceAll("-", "")
    .toLowerCase();

  const parts =
    /^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/.exec(
      hex,
    );

  if (hex.length !== 32 || !parts) {
    throw new Refused("Use a valid UUID.");
  }

  return parts.slice(1).join("-");
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function verifiedBytes(
  item: typeof chatItem.Type | (typeof mediaPage.Type.items)[number],
  encoded: string,
) {
  const size = item.sizeBytes;

  if (
    size < 1 ||
    size > fileLimit ||
    encoded.length !== 4 * Math.ceil(size / 3)
  ) {
    throw new Refused(
      "Attachment length differs from its record or exceeds 10 MiB.",
    );
  }

  const bytes = Buffer.from(encoded, "base64");

  if (
    bytes.length !== size ||
    bytes.toString("base64") !== encoded ||
    (item.sha256 && sha256(bytes) !== item.sha256.toLowerCase())
  ) {
    throw new Refused("The attachment changed. Read it again.");
  }

  return bytes;
}

async function boundedBytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (!reader) {
    throw new Refused("Subspace returned an empty response.");
  }

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) {
        return Buffer.concat(chunks, size);
      }

      size += chunk.value.byteLength;

      if (size > limit) {
        await reader.cancel();
        throw new Refused("Subspace response exceeds the file limit.");
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function boundedResponse(response: Response, limit: number) {
  return (await boundedBytes(response, limit)).toString("utf8");
}

async function postToRelay(relay: Relay, path: string, options: RequestInit) {
  if ("socket" in relay) {
    return fetch(new URL(path, "http://localhost"), {
      ...options,
      unix: relay.socket,
    });
  }

  const origin =
    "endpoint" in relay ? relay.endpoint : `http://127.0.0.1:${relay.port}`;

  return fetch(new URL(path, origin), options);
}

function eventMessage(response: Response, raw: string) {
  return response.headers.get("Content-Type")?.startsWith("text/event-stream")
    ? /^data:[ \t]*([^\r\n]*)/m.exec(raw)?.[1]
    : raw;
}

class IssueReader {
  private version = initialVersion;
  private session: string | null = null;

  public constructor(
    private readonly relay: Relay,
    private readonly signal: AbortSignal,
    private readonly legacy: boolean,
  ) {}

  private async request(
    method: string,
    params: Record<string, unknown>,
    id?: number,
  ) {
    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.version,
      "User-Agent": this.legacy
        ? "subspace-officer-uploads/1"
        : "stargate-officer-files/1",
    });

    if (this.session) {
      headers.set("Mcp-Session-Id", this.session);
    }

    if (this.relay.actor) {
      headers.set("X-Subspace-Agent", this.relay.actor);
    }

    const options: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
      redirect: "error",
      signal: AbortSignal.any([
        this.signal,
        AbortSignal.timeout(this.legacy ? 90_000 : 40_000),
      ]),
    };

    const response = await postToRelay(this.relay, "/mcp", options);

    if (
      this.legacy ? !response.ok : ![200, 202, 204].includes(response.status)
    ) {
      await response.body?.cancel();
      throw new Refused("Subspace refused the file request.");
    }

    this.session = response.headers.get("Mcp-Session-Id") ?? this.session;

    if (id === undefined) {
      await response.body?.cancel();

      return;
    }

    // Subspace can JSON-escape each base64 character in a text block. The
    // Enclosing MCP envelope can double the backslash, making seven bytes.
    const readMedia = [
      "subspace_get_attachment",
      "subspace_get_issue_image",
      "subspace_get_chat_upload",
    ].some((name) => name === params["name"]);

    const limit = this.legacy
      ? 65_536
      : readMedia
        ? 7 * (4 * Math.ceil(fileLimit / 3)) + 131_072
        : 2 * 1024 * 1024;

    const raw = await boundedResponse(response, limit);

    const line = eventMessage(response, raw);

    const decoded = Schema.decodeUnknownResult(replySchema)(line);

    if (Result.isFailure(decoded) || decoded.success.id !== id) {
      throw new Refused("Subspace did not confirm the file request.");
    }

    return decoded.success.result;
  }

  public async connect() {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: this.version,
        capabilities: {},
        clientInfo: {
          name: this.legacy ? "officer-uploads" : "officer-files",
          version: "1",
        },
      },
      1,
    );

    const reply = Schema.decodeUnknownSync(
      Schema.Struct({ protocolVersion: Schema.String }),
    )(result);

    this.version = reply.protocolVersion;
    await this.request("notifications/initialized", {});
  }

  public async tool(name: string, args: Record<string, unknown>) {
    const result = Schema.decodeUnknownSync(toolResult)(
      await this.request(
        "tools/call",
        { name: `subspace_${name}`, arguments: args },
        2,
      ),
    );

    if (result.isError) {
      throw new Refused("The requested attachment is unavailable.");
    }

    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }

    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
      result.content?.[0]?.text,
    );
  }

  public async upload(reference: string) {
    const body = Schema.decodeUnknownSync(chatBody)(
      await this.tool("get_chat_upload", { reference, includeBytes: true }),
    );

    if (body.upload.reference !== reference || !body.upload.sha256) {
      throw new Refused("Subspace returned a different upload.");
    }

    return {
      name: safeName(body.upload.fileName),
      data: verifiedBytes(body.upload, body.base64),
    };
  }

  public async attachment(issue: string, media: string) {
    if (!/^[A-Z][A-Z0-9]{0,18}-[1-9][0-9]{0,9}$/.test(issue)) {
      throw new Refused("Use an issue key.");
    }

    const mediaId = uuid(media);
    let cursor: string | null | undefined;

    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const args: Record<string, unknown> = { issue, limit: 100 };

      if (cursor) {
        args["cursor"] = cursor;
      }

      const page = Schema.decodeUnknownSync(mediaPage)(
        await this.tool("list_attachments", args),
      );

      const item = page.items.find((entry) => entry.mediaId === mediaId);

      if (item) {
        const name = safeName(item.fileName);

        if (item.sizeBytes < 1 || item.sizeBytes > fileLimit) {
          throw new Refused("Attachment exceeds the size limit.");
        }

        const body = Schema.decodeUnknownSync(issueBody)(
          await this.tool(
            item.kind === "file" ? "get_attachment" : "get_issue_image",
            { mediaId },
          ),
        );

        if (
          body.fileName !== name ||
          body.contentType !== item.contentType ||
          body.sizeBytes !== item.sizeBytes
        ) {
          throw new Refused("The attachment changed. Read it again.");
        }

        return { name, data: verifiedBytes(item, body.base64) };
      }

      cursor = page.nextCursor;

      if (!cursor) {
        break;
      }
    }

    throw new Refused("Attachment not found on that issue.");
  }
}

// Darwin defines O_NOFOLLOW_ANY separately from O_NOFOLLOW.
const noFollow =
  process.platform === "darwin" ? 0x20_00_00_00 : constants.O_NOFOLLOW;

const readFlags = constants.O_RDONLY | noFollow | constants.O_NONBLOCK;
const directoryFlags = constants.O_DIRECTORY | readFlags;

async function openDirectory(path: string) {
  if (process.platform === "linux") {
    return open(path, directoryFlags);
  }

  if (process.platform !== "darwin") {
    throw new Refused("The file tool needs Linux or macOS.");
  }

  // On macOS has no procfs path for a pinned directory. Refuse ancestors
  // Another user can replace, and use O_NOFOLLOW_ANY on every open.
  let parent = dirname(path);

  for (;;) {
    const info = await lstat(parent);

    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    ) {
      throw new Refused("File directories need trusted parent directories.");
    }

    const next = dirname(parent);

    if (next === parent) {
      break;
    }

    parent = next;
  }

  return open(path, directoryFlags);
}

function relativePath(directory: FileHandle, path: string, name: string) {
  return process.platform === "linux"
    ? `/proc/self/fd/${directory.fd}/${name}`
    : join(path, name);
}

async function staged(root: string, name: string, limit: number) {
  const directory = await openDirectory(root);

  try {
    const file = await open(relativePath(directory, root, name), readFlags);

    try {
      const before = await file.stat({ bigint: true });

      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        Number(before.uid) !== process.getuid?.() ||
        (before.mode & 0o022n) !== 0n ||
        before.size < 1n ||
        before.size > BigInt(limit)
      ) {
        throw new Refused(
          "Stage an officer-owned regular file within the size limit.",
        );
      }

      const buffer = Buffer.alloc(Number(before.size) + 1);
      let total = 0;

      while (total < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );

        if (bytesRead === 0) {
          break;
        }

        total += bytesRead;
      }

      if (
        total !== Number(before.size) ||
        (await file.stat({ bigint: true })).ctimeNs !== before.ctimeNs
      ) {
        throw new Refused("Finish writing the file before sharing it.");
      }

      return buffer.subarray(0, total);
    } finally {
      await file.close();
    }
  } finally {
    await directory.close();
  }
}

async function saveFile(rootPath: string, name: string, data: Uint8Array) {
  // Start private. The export group sees the completed file only after chmod.
  const folder = randomUUID().replaceAll("-", "");
  const root = await openDirectory(rootPath);
  const folderPath = relativePath(root, rootPath, folder);
  const fullPath = join(rootPath, folder, name);

  try {
    await mkdir(folderPath, { mode: 0o700 });

    try {
      const directory = await open(folderPath, directoryFlags);

      const filePath = relativePath(directory, folderPath, name);

      try {
        const file = await open(
          filePath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
          0o600,
        );

        try {
          await file.writeFile(data);
          await file.chmod(0o640);
        } finally {
          await file.close();
        }

        await directory.chmod(0o2750);
      } catch (error) {
        await rm(filePath, { force: true });
        throw error;
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rmdir(folderPath);
      throw error;
    }
  } finally {
    await root.close();
  }

  return {
    fileName: name,
    sizeBytes: data.length,
    marker: `![${name}](${pathToFileURL(fullPath).href.replaceAll("(", "%28").replaceAll(")", "%29")})`,
  };
}

async function publish(
  write: (payload: Record<string, unknown>) => Promise<unknown>,
  name: string,
  data: Buffer,
  uploadId: string,
) {
  const contentType = chatTypes.get(suffix(name));

  if (!contentType) {
    throw new Refused(
      "This file type cannot be published as a Subspace chat upload.",
    );
  }

  const expected = `UPL-${Buffer.from(uploadId.replaceAll("-", ""), "hex").toString("base64url")}`;

  const receipt = Schema.decodeUnknownResult(uploadReceipt)(
    await write({
      uploadId,
      fileName: name,
      contentType,
      base64: data.toString("base64"),
    }),
  );

  if (
    Result.isFailure(receipt) ||
    receipt.success.reference !== expected ||
    receipt.success.sizeBytes !== data.length ||
    receipt.success.sha256.toLowerCase() !== sha256(data)
  ) {
    throw new Refused(
      "Upload unconfirmed. Check the same upload ID before retrying.",
    );
  }

  return { fileName: name, sizeBytes: data.length, reference: expected };
}

async function postUpload(relay: Relay, payload: unknown, signal: AbortSignal) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "subspace-officer-uploads/1",
  });

  if (!("socket" in relay) && relay.actor) {
    headers.set("X-Subspace-Agent", relay.actor);
  }

  const response = await postToRelay(relay, "/api/v1/chat/uploads", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    redirect: "error",
    signal,
  });

  if (!response.ok) {
    await response.body?.cancel();

    if (response.status === 409) {
      throw new Refused(
        "Check the upload UUID with subspace_get_chat_upload. Reuse a matching ready reference; if the ID is still unavailable after checking, use a new UUID.",
      );
    }

    throw new Refused(
      `Subspace returned HTTP ${response.status}. Check the upload ID before retrying.`,
    );
  }

  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
    eventMessage(response, await boundedResponse(response, 65_536)),
  );
}

function restReader(relay: Relay, signal: AbortSignal) {
  return new RestFiles(
    async (path, limit) => {
      const headers = new Headers();

      if (!("socket" in relay) && relay.actor) {
        headers.set("X-Subspace-Agent", relay.actor);
      }

      const response = await postToRelay(relay, path, {
        method: "GET",
        headers,
        redirect: "error",
        signal,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Refused("Subspace refused the file request.");
      }

      return boundedBytes(response, limit);
    },
    safeName,
    uuid,
  );
}

async function prepareOutput(
  config: FileConfig,
  name: string,
  data: Buffer,
  options: { preview?: "teams"; page?: number },
  signal: AbortSignal,
) {
  if (!options.preview) {
    return saveFile(config.exports, name, data);
  }

  if (!config.browser) {
    throw new Refused(
      "Offline Markdown previews are unavailable for this officer.",
    );
  }

  if (!["md", "markdown", "txt", "text"].includes(suffix(name))) {
    throw new Refused(
      "Teams document previews support Markdown and plain text.",
    );
  }

  let rendered: Awaited<ReturnType<typeof renderMarkdownPreview>>;
  const page = options.page ?? 1;

  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(data);

    rendered = await renderMarkdownPreview(source, name, page, config.browser);
  } catch {
    throw new Refused(
      "Could not render the preview. Check the page or provide a shorter plain-text document.",
    );
  }

  signal.throwIfAborted();

  const label = name.slice(0, name.lastIndexOf(".")).slice(0, 140);

  const saved = await saveFile(
    config.exports,
    `${label}-preview-${page}.png`,
    rendered.preview,
  );

  return {
    ...saved,
    originalFileName: name,
    page,
    pages: rendered.pages,
    contentType: "image/png",
  };
}

async function prepare(input: unknown, config: Config, signal: AbortSignal) {
  if ("legacyUpload" in config) {
    const parsed = decodeUploadArguments(input);

    if (Result.isFailure(parsed)) {
      throw new Refused("Supply the file name and upload ID.");
    }

    const name = safeName(parsed.success.fileName);
    const uploadId = uuid(parsed.success.uploadId);

    const limit =
      config.rest && "socket" in config ? fileLimit : legacyUploadLimit;

    const data = await staged(config.staging, `subspace-share-${name}`, limit);

    if (config.rest) {
      return publish(
        (args) => postUpload(config, args, signal),
        name,
        data,
        uploadId,
      );
    }

    const reader = new IssueReader(config, signal, true);

    await reader.connect();

    return publish(
      (args) => reader.tool("create_chat_upload", args),
      name,
      data,
      uploadId,
    );
  }

  const parsed = decodeArguments(input);

  if (Result.isFailure(parsed)) {
    throw new Refused("Choose one source and supply its required fields.");
  }

  const args = parsed.success;

  if (
    (args.page !== undefined && args.preview === undefined) ||
    (args.preview && "chatUploadId" in args && args.chatUploadId !== undefined)
  ) {
    throw new Refused(
      "Choose a Teams preview or a chat upload, and use page only for a preview.",
    );
  }

  const mcp = new IssueReader(config, signal, false);
  const reader = config.rest ? restReader(config, signal) : mcp;

  if (args.source === "upload") {
    if (!/^UPL-[A-Za-z0-9_-]{22}$/.test(args.reference)) {
      throw new Refused(
        "Use an existing UPL reference without a new upload ID.",
      );
    }

    if (!config.rest) {
      await mcp.connect();
    }

    const file = await reader.upload(args.reference);

    return prepareOutput(config, file.name, file.data, args, signal);
  }

  const uploadId =
    args.chatUploadId === undefined ? undefined : uuid(args.chatUploadId);

  if (!config.rest && (uploadId || args.source === "issue")) {
    await mcp.connect();
  }

  let name: string;
  let data: Buffer;

  if (args.source === "issue") {
    ({ name, data } = await reader.attachment(args.issue, args.mediaId));
  } else {
    name = safeName(args.fileName);

    if (args.source === "staged") {
      data = await staged(config.staging, name, fileLimit);
    } else {
      if (!textTypes.has(suffix(name))) {
        throw new Refused("Use a text document extension for new text.");
      }

      if (!args.text.isWellFormed()) {
        throw new Refused("Use valid UTF-8 for new text.");
      }

      data = Buffer.from(args.text, "utf8");

      if (data.length === 0 || data.length > textLimit) {
        throw new Refused("Use 1 to 65536 UTF-8 bytes for new text.");
      }
    }
  }

  signal.throwIfAborted();

  return uploadId
    ? publish(
        (payload) =>
          config.rest
            ? postUpload(config, payload, signal)
            : mcp.tool("create_chat_upload", payload),
        name,
        data,
        uploadId,
      )
    : prepareOutput(config, name, data, args, signal);
}

async function serve(config: Config) {
  const legacy = "legacyUpload" in config;
  const tool = legacy ? uploadTool : prepareTool;
  const invalid = { error: { code: -32_600, message: "Invalid request" } };

  for await (const line of officerRequestLines(legacy ? 8192 : 400_000)) {
    const parsed = Schema.decodeUnknownResult(requestSchema)(line);
    let id: string | number | null = null;
    let reply: Record<string, unknown> = invalid;

    if (Result.isSuccess(parsed)) {
      const request = parsed.success;

      if (request.id === undefined) {
        continue;
      }

      id = request.id;

      if (request.method === "initialize") {
        const requested = request.params?.protocolVersion;

        const protocolVersion =
          requested && versions.has(requested) ? requested : initialVersion;

        reply = {
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "officer-files", version: "1" },
          },
        };
      } else if (request.method === "tools/list") {
        reply = { result: { tools: [tool] } };
      } else if (request.method === "ping") {
        reply = { result: {} };
      } else if (
        request.method === "tools/call" &&
        request.params?.name === tool.name
      ) {
        const deadline = AbortSignal.timeout(legacy ? 90_000 : 80_000);

        try {
          const value = await prepare(
            request.params.arguments,
            config,
            deadline,
          );

          reply = {
            result: {
              content: [{ type: "text", text: JSON.stringify(value) }],
            },
          };
        } catch (error) {
          let detail = "Could not prepare the requested file.";

          if (error instanceof Refused) {
            detail = error.message;
          } else if (deadline.aborted) {
            detail =
              "File preparation timed out. Check the upload ID before retrying.";
          }

          reply = {
            result: {
              isError: true,
              content: [{ type: "text", text: detail }],
            },
          };
        }
      }
    }

    const output = JSON.stringify({ jsonrpc: "2.0", id, ...reply });

    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${output}\n`, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

async function config(): Promise<Config> {
  const { values } = parseArgs({
    options: {
      staging: { type: "string" },
      exports: { type: "string" },
      socket: { type: "string" },
      port: { type: "string" },
      actor: { type: "string" },
      endpoint: { type: "string" },
      playwright: { type: "string" },
      chromium: { type: "string" },
      "browser-cache": { type: "string" },
      rest: { type: "boolean" },
      "legacy-upload": { type: "boolean" },
    },
  });

  const staging = values.staging;
  const exports = values.exports;
  const port = Number(values.port);

  if (
    !staging ||
    [values.socket, values.port, values.endpoint].filter(Boolean).length !==
      1 ||
    (values.endpoint && !values.rest) ||
    (values.port &&
      (!/^\d+$/.test(values.port) || port < 1 || port > 65_535)) ||
    Boolean(exports) === Boolean(values["legacy-upload"])
  ) {
    throw new Refused(
      "Configure --staging, --exports or --legacy-upload, and a --socket, --port or legacy REST --endpoint.",
    );
  }

  for (const path of exports ? [staging, exports] : [staging]) {
    if (!isAbsolute(path) || (await realpath(path)) !== path) {
      throw new Refused("Configure canonical absolute directories.");
    }
  }

  let relay: Relay;

  if (values.endpoint) {
    const endpoint = new URL(values.endpoint);

    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Refused("Configure an HTTP or HTTPS Subspace agent endpoint.");
    }

    relay = { endpoint: endpoint.origin };
  } else {
    relay = values.socket ? { socket: values.socket } : { port };
  }

  if (values.actor) {
    relay.actor = values.actor;
  }

  if (!exports) {
    return {
      ...relay,
      staging,
      legacyUpload: true,
      rest: values.rest ?? false,
    };
  }

  const result: Config = {
    ...relay,
    staging,
    exports,
    rest: values.rest ?? false,
  };

  if (values.playwright) {
    if (
      !isAbsolute(values.playwright) ||
      (values.chromium && !isAbsolute(values.chromium)) ||
      (values["browser-cache"] && !isAbsolute(values["browser-cache"]))
    ) {
      throw new Refused("Configure absolute paths for the offline browser.");
    }

    const browser: PreviewBrowser = { playwright: values.playwright };

    if (values.chromium) {
      browser.chromium = values.chromium;
    }

    if (values["browser-cache"]) {
      browser.browserCache = values["browser-cache"];
    }

    result.browser = browser;
  }

  return result;
}

try {
  await serve(await config());
} catch (error) {
  process.stderr.write(
    `${error instanceof Refused ? error.message : "Could not start the officer file tool."}\n`,
  );
  process.exitCode = 1;
}
