import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Predicate, Schema } from "effect";
import {
  HISTORY_PARTS,
  type HistoryEntriesInput,
  type HistoryEntry,
  type HistoryEntryPage,
  type HistoryPart,
  type HistorySession,
  type HistorySessionPage,
  type SessionHistory,
  clipHistory,
  exactStruct,
  historyChildrenInputSchema,
  historyDescribeInputSchema,
  historyEntriesInputSchema,
} from "../../shared/session-history";

const unavailable = "Claude history unavailable or cancelled.";
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

async function readBoundedTranscript(path: string): Promise<string> {
  const handle = await open(path, "r");

  try {
    const info = await handle.stat();
    const truncated = info.size > MAX_TRANSCRIPT_BYTES;
    const toRead = Math.min(info.size, MAX_TRANSCRIPT_BYTES);
    const offset = truncated ? info.size - MAX_TRANSCRIPT_BYTES : 0;

    if (toRead <= 0) {
      return "";
    }

    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");

    if (!truncated) {
      return text;
    }

    const firstNewline = text.indexOf("\n");

    return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  } finally {
    await handle.close();
  }
}

function queuedCommandText(prompt: unknown): string | undefined {
  if (typeof prompt === "string" && prompt.length > 0) {
    return prompt;
  }

  if (Array.isArray(prompt)) {
    const parts: string[] = [];

    for (const entry of prompt) {
      const block = asRecord(entry);

      if (block?.["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"]);
      }
    }

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  return undefined;
}

const uuidSchema = Schema.String.check(Schema.isUUID());
const isUUID = Schema.is(uuidSchema);

const decodeDescribe = Schema.decodeUnknownSync(historyDescribeInputSchema);
const decodeChildren = Schema.decodeUnknownSync(historyChildrenInputSchema);
const decodeEntries = Schema.decodeUnknownSync(historyEntriesInputSchema);

const cursorSchema = exactStruct({
  sessionID: Schema.String,
  afterId: Schema.String,
  order: Schema.Literals(["asc", "desc"]),
});

const decodeCursor = Schema.decodeUnknownSync(cursorSchema);

type MutableToolPart = {
  type: "tool";
  name: string;
  status?: "pending" | "running" | "completed" | "error";
  input?: string;
  output?: string;
  truncated?: true;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Predicate.isObject(value) && !Array.isArray(value) ? value : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);

    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

function extractToolResultText(rawContent: unknown): string | undefined {
  if (typeof rawContent === "string") {
    return rawContent;
  }

  if (rawContent !== undefined) {
    return JSON.stringify(rawContent);
  }

  return undefined;
}

function buildToolUsePart(
  block: Record<string, unknown>,
  detail: HistoryEntriesInput["detail"],
): MutableToolPart {
  const name =
    typeof block["name"] === "string" ? block["name"].slice(0, 200) : "tool";

  const part: MutableToolPart = { type: "tool", name };

  if (detail === "full" && block["input"] !== undefined) {
    const clipped = clipHistory(JSON.stringify(block["input"]));
    part.input = clipped.text;

    if (clipped.truncated) {
      part.truncated = true;
    }
  }

  return part;
}

function applyToolResult(
  target: MutableToolPart,
  block: Record<string, unknown>,
  detail: HistoryEntriesInput["detail"],
): void {
  target.status = block["is_error"] === true ? "error" : "completed";

  if (detail === "full") {
    const text = extractToolResultText(block["content"]);

    if (text !== undefined) {
      const clipped = clipHistory(text);
      target.output = clipped.text;

      if (clipped.truncated) {
        target.truncated = true;
      }
    }
  }
}

function mapContentBlock(
  rawBlock: unknown,
  detail: HistoryEntriesInput["detail"],
  toolCalls: Map<string, MutableToolPart>,
): HistoryPart | undefined {
  const block = asRecord(rawBlock);

  if (!block) {
    return undefined;
  }

  const blockType = block["type"];

  if (blockType === "text" && typeof block["text"] === "string") {
    return { type: "text", ...clipHistory(block["text"]) };
  }

  if (blockType === "thinking") {
    return detail === "full" && typeof block["thinking"] === "string"
      ? { type: "reasoning", ...clipHistory(block["thinking"]) }
      : { type: "reasoning" };
  }

  if (blockType === "tool_use") {
    const part = buildToolUsePart(block, detail);

    if (typeof block["id"] === "string" && block["id"].length > 0) {
      toolCalls.set(block["id"], part);
    }

    return part;
  }

  if (blockType === "tool_result") {
    const callId =
      typeof block["tool_use_id"] === "string"
        ? block["tool_use_id"]
        : undefined;

    const existing = callId ? toolCalls.get(callId) : undefined;

    if (existing) {
      applyToolResult(existing, block, detail);

      return undefined;
    }

    const orphan: MutableToolPart = { type: "tool", name: "tool_result" };
    applyToolResult(orphan, block, detail);

    return orphan;
  }

  return undefined;
}

function parseTranscriptRecords(
  raw: string,
  detail: HistoryEntriesInput["detail"],
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const toolCalls = new Map<string, MutableToolPart>();
  const lines = raw.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const record = asRecord(parsed);

    if (!record) {
      continue;
    }

    const id =
      typeof record["uuid"] === "string" && record["uuid"].length > 0
        ? record["uuid"].slice(0, 512)
        : `line-${index}`;

    const type = record["type"];

    if (type === "attachment") {
      const attachment = asRecord(record["attachment"]);

      const text =
        attachment?.["type"] === "queued_command"
          ? queuedCommandText(attachment["prompt"])
          : undefined;

      if (text !== undefined) {
        const entry: HistoryEntry = {
          id,
          role: "user",
          parts: [{ type: "text", ...clipHistory(text) }],
        };

        const createdAt = parseTimestamp(record["timestamp"]);

        if (createdAt !== undefined) {
          entry.createdAt = createdAt;
        }

        entries.push(entry);
      }

      continue;
    }

    if (type !== "user" && type !== "assistant" && type !== "system") {
      continue;
    }

    // Never expose synthetic provider error frames in dashboard history.
    if (
      type === "assistant" &&
      (record["error"] !== undefined || record["isApiErrorMessage"] === true)
    ) {
      continue;
    }

    const message = asRecord(record["message"]);
    const content = message?.["content"];
    const parts: HistoryPart[] = [];
    let omitted = 0;

    const addPart = (part: HistoryPart) => {
      if (parts.length < HISTORY_PARTS) {
        parts.push(part);
      } else {
        omitted += 1;
      }
    };

    if (typeof content === "string") {
      addPart({ type: "text", ...clipHistory(content) });
    } else if (Array.isArray(content)) {
      for (const rawBlock of content) {
        const mapped = mapContentBlock(rawBlock, detail, toolCalls);

        if (mapped) {
          addPart(mapped);
        }
      }
    } else if (typeof record["text"] === "string") {
      addPart({ type: "text", ...clipHistory(record["text"]) });
    }

    if (parts.length === 0) {
      continue;
    }

    const entry: HistoryEntry =
      omitted > 0
        ? { id, role: type, parts, omittedParts: omitted }
        : { id, role: type, parts };

    const createdAt = parseTimestamp(record["timestamp"]);

    if (createdAt !== undefined) {
      entry.createdAt = createdAt;
    }

    const model = message?.["model"];

    if (typeof model === "string" && model.length > 0) {
      entry.model = model.slice(0, 200);
    }

    entries.push(entry);
  }

  return entries;
}

function readTranscriptMetadata(raw: string): {
  title?: string;
  model?: string;
} {
  let title: string | undefined;
  let model: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const record = asRecord(parsed);

    if (!record) {
      continue;
    }

    if (record["type"] === "custom-title") {
      const value = record["customTitle"] ?? record["title"];

      if (typeof value === "string" && value.trim().length > 0) {
        title = value.trim().slice(0, 300);
      }
    } else if (
      record["type"] === "assistant" &&
      record["error"] === undefined &&
      record["isApiErrorMessage"] !== true
    ) {
      const msgModel = asRecord(record["message"])?.["model"];

      if (
        typeof msgModel === "string" &&
        msgModel.length > 0 &&
        msgModel !== "<synthetic>"
      ) {
        model = msgModel.slice(0, 200);
      }
    }
  }

  const metadata: { title?: string; model?: string } = {};

  if (title !== undefined) {
    metadata.title = title;
  }

  if (model !== undefined) {
    metadata.model = model;
  }

  return metadata;
}

async function findTranscriptFile(
  home: string,
  sessionID: string,
): Promise<string | undefined> {
  if (!isUUID(sessionID)) {
    return undefined;
  }

  const projects = join(home, "projects");
  let dirs: string[];

  try {
    dirs = await readdir(projects);
  } catch {
    return undefined;
  }

  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionID}.jsonl`);

    try {
      const info = await stat(candidate);

      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // Not in this project directory.
    }
  }

  return undefined;
}

/**
 * Read-only `SessionHistory` over Claude Code's private `CLAUDE_CONFIG_DIR`
 * JSONL transcripts. Uses stable entry-ID cursors and merges tool results
 * into their matching tool calls. Never spawns a CLI or mutates state.
 */
export function createClaudeHistory(
  home: string,
  configuredModel: string,
): SessionHistory {
  return {
    roots(signal: AbortSignal): Promise<HistorySession[]> {
      signal.throwIfAborted();

      return Promise.resolve([]);
    },

    async describe(
      ids: readonly string[],
      signal: AbortSignal,
    ): Promise<HistorySession[]> {
      const validated = decodeDescribe({ ids });
      signal.throwIfAborted();
      const sessions: HistorySession[] = [];

      for (const sessionID of validated.ids) {
        signal.throwIfAborted();
        const file = await findTranscriptFile(home, sessionID);

        if (!file) {
          continue;
        }

        try {
          const [info, raw] = await Promise.all([
            stat(file),
            readBoundedTranscript(file),
          ]);

          const meta = readTranscriptMetadata(raw);

          const session: HistorySession = {
            id: sessionID,
            harness: "claude",
            kind: "conversation",
            model: (meta.model ?? configuredModel).slice(0, 200),
            createdAt: Math.max(
              0,
              Math.floor(info.birthtimeMs || info.mtimeMs),
            ),
            updatedAt: Math.max(0, Math.floor(info.mtimeMs)),
          };

          if (meta.title !== undefined) {
            sessions.push({ ...session, title: meta.title });
          } else {
            sessions.push(session);
          }
        } catch {
          // Omit unreadable session.
        }
      }

      return sessions;
    },

    children(
      input: Parameters<SessionHistory["children"]>[0],
      signal: AbortSignal,
    ): Promise<HistorySessionPage> {
      decodeChildren(input);
      signal.throwIfAborted();

      return Promise.resolve({ sessions: [] });
    },

    async entries(
      input: HistoryEntriesInput,
      signal: AbortSignal,
    ): Promise<HistoryEntryPage> {
      const parsed = decodeEntries(input);
      signal.throwIfAborted();

      let afterId: string | undefined;
      let order: "asc" | "desc" = parsed.order;

      if (parsed.cursor !== undefined) {
        try {
          const decoded = decodeCursor(
            JSON.parse(
              Buffer.from(parsed.cursor, "base64url").toString("utf8"),
            ),
          );

          if (decoded.sessionID !== parsed.sessionID) {
            throw new Error(unavailable);
          }

          afterId = decoded.afterId;
          order = decoded.order;
        } catch {
          throw new Error(unavailable);
        }
      }

      const file = await findTranscriptFile(home, parsed.sessionID);

      if (!file) {
        return { entries: [] };
      }

      let raw: string;

      try {
        raw = await readBoundedTranscript(file);
      } catch {
        throw new Error(unavailable);
      }

      signal.throwIfAborted();

      const all = parseTranscriptRecords(raw, parsed.detail);
      const ordered = order === "desc" ? all.toReversed() : all;

      let startIndex = 0;

      if (afterId !== undefined) {
        const found = ordered.findIndex((entry) => entry.id === afterId);

        if (found === -1) {
          throw new Error(unavailable);
        }

        startIndex = found + 1;
      }

      const slice = ordered.slice(startIndex, startIndex + parsed.limit);
      const last = slice.at(-1);
      const hasMore = startIndex + slice.length < ordered.length;

      if (hasMore && last !== undefined) {
        return {
          entries: slice,
          cursor: Buffer.from(
            JSON.stringify({
              sessionID: parsed.sessionID,
              afterId: last.id,
              order,
            }),
            "utf8",
          ).toString("base64url"),
        };
      }

      return { entries: slice };
    },
  };
}
