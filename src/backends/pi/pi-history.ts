import { Database } from "bun:sqlite";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type ConversationId,
  type EntryRecord,
  Harness,
  createRegistry,
} from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Result, Schema, SchemaTransformation } from "effect";
import {
  HISTORY_PARTS,
  HISTORY_TEXT,
  type HistoryEntriesInput,
  type HistoryEntry,
  type HistoryPart,
  type HistorySession,
  type SessionHistory,
  clipHistory,
  exactStruct,
  historyChildrenInputSchema,
  historyDescribeInputSchema,
  historyEntriesInputSchema,
} from "../../shared/session-history";

const safe = async <T>(signal: AbortSignal, read: () => Promise<T>) => {
  try {
    signal.throwIfAborted();
    const result = await read();
    signal.throwIfAborted();

    return result;
  } catch {
    throw new Error(unavailable);
  }
};

const unavailable = "Pi history unavailable or cancelled.";
const decodeDescribe = Schema.decodeUnknownSync(historyDescribeInputSchema);
const decodeChildren = Schema.decodeUnknownSync(historyChildrenInputSchema);
const decodeEntries = Schema.decodeUnknownSync(historyEntriesInputSchema);

// Canonical decimal only; Pi Durable's backend accepts leading zeros.
const numericID = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)$/)).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    SchemaTransformation.transform({ decode: Number, encode: String }),
  ),
);

const decodeNumericID = Schema.decodeUnknownSync(numericID);
const checkNumericID = Schema.decodeUnknownResult(numericID);

const decodeCursor = Schema.decodeUnknownSync(
  exactStruct({
    sessionID: Schema.String,
    page: Schema.Record(Schema.String, Schema.MutableJson),
  }),
);

function clipBody(text: string): ReturnType<typeof clipHistory> {
  const clipped = clipHistory(text);

  // Also cap UTF-16 units; do not split a surrogate pair.
  return clipped.text.length > HISTORY_TEXT
    ? {
        text: clipped.text
          .slice(0, HISTORY_TEXT)
          .replace(/[\uD800-\uDBFF]$/, ""),
        truncated: true,
      }
    : clipped;
}

function textPart(text: string): HistoryPart {
  return { type: "text", ...clipBody(text) };
}

/** Pair only unique, ordered call/result IDs within this page. Across page
 * boundaries results stay separate tool entries; no speculative history scan.
 */
export function mapPiHistory(
  records: readonly EntryRecord[],
  detail: HistoryEntriesInput["detail"],
): HistoryEntry[] {
  type ToolPart = Extract<HistoryPart, { type: "tool" }>;

  const calls = new Map<
    string,
    { part: ToolPart; entryID: number; visible: boolean }[]
  >();

  const results = new Map<string, { part: ToolPart; entryID: number }[]>();

  const entries = records.map((record): HistoryEntry => {
    const parts: HistoryPart[] = [];

    const entry: HistoryEntry = {
      id: String(record.id),
      role: "system",
      parts,
    };

    if (!["pi.user", "pi.assistant", "pi.tool-result"].includes(record.kind)) {
      parts.push({ type: "notice", label: record.kind.slice(0, 300) });

      return entry;
    }

    entry.role = piRole(record.kind);

    for (const message of record.model ?? []) {
      if (Number.isSafeInteger(message.timestamp) && message.timestamp >= 0) {
        entry.createdAt ??= message.timestamp;
      }

      if (message.role === "assistant") {
        entry.model ??= `${message.provider}/${message.model}`.slice(0, 200);

        for (const block of message.content) {
          if (block.type === "text") {
            parts.push(textPart(block.text));
          } else if (block.type === "thinking") {
            parts.push({
              type: "reasoning",
              ...(detail === "full" && clipBody(block.thinking)),
            });
          } else {
            const input =
              detail === "full"
                ? clipBody(JSON.stringify(block.arguments))
                : undefined;

            const part: ToolPart = {
              type: "tool",
              name: block.name.slice(0, 200),
              status: "pending",
              ...(input && {
                input: input.text,
                ...(input.truncated && { truncated: true }),
              }),
            };

            parts.push(part);
            const matches = calls.get(block.id) ?? [];
            matches.push({
              part,
              entryID: record.id,
              visible: parts.length <= HISTORY_PARTS,
            });
            calls.set(block.id, matches);
          }
        }
      } else if (message.role === "toolResult") {
        const output =
          detail === "full"
            ? clipBody(
                message.content
                  .flatMap((block) =>
                    block.type === "text" ? [block.text] : [],
                  )
                  .join("\n"),
              )
            : undefined;

        const part: ToolPart = {
          type: "tool",
          name: message.toolName.slice(0, 200),
          status: message.isError ? "error" : "completed",
          ...(output && {
            output: output.text,
            ...(output.truncated && { truncated: true }),
          }),
        };

        parts.push(part);
        const matches = results.get(message.toolCallId) ?? [];
        matches.push({ part, entryID: record.id });
        results.set(message.toolCallId, matches);
      } else if (typeof message.content === "string") {
        parts.push(textPart(message.content));
      } else {
        for (const block of message.content) {
          parts.push(
            block.type === "text"
              ? textPart(block.text)
              : { type: "notice", label: "Image" },
          );
        }
      }
    }

    return entry;
  });

  const paired = new Set<HistoryPart>();

  for (const [id, matches] of calls) {
    const outputs = results.get(id);
    const call = matches[0];
    const result = outputs?.[0];

    if (
      matches.length !== 1 ||
      outputs?.length !== 1 ||
      !call ||
      !result ||
      !call.visible ||
      call.entryID >= result.entryID ||
      call.part.name !== result.part.name
    ) {
      continue;
    }

    Object.assign(call.part, result.part);
    paired.add(result.part);
  }

  return entries.flatMap((entry) => {
    const parts = entry.parts.filter((part) => !paired.has(part));

    if (entry.role === "tool" && parts.length === 0) {
      return [];
    }

    return [
      {
        ...entry,
        parts: parts.slice(0, HISTORY_PARTS),
        ...(parts.length > HISTORY_PARTS && {
          omittedParts: parts.length - HISTORY_PARTS,
        }),
      },
    ];
  });
}

/** Conversation lookup and entries() read the Session line, never resume(). */
export function piSessionHistory(
  harness: Pick<Harness, "conversation">,
): SessionHistory {
  const conversation = (id: string, signal: AbortSignal) => {
    signal.throwIfAborted();

    return harness.conversation(
      decodeNumericID(id) as ConversationId,
      withAbortSignal(signal, BACKGROUND_CONTEXT),
    );
  };

  return {
    roots: (signal) => safe(signal, async () => []),
    describe: (ids, signal) =>
      safe(signal, async () => {
        decodeDescribe({ ids });
        const sessions: HistorySession[] = [];

        for (const id of ids) {
          if (Result.isFailure(checkNumericID(id))) {
            continue;
          }

          try {
            if (await conversation(id, signal)) {
              sessions.push({
                id,
                harness: "pi-durable",
                kind: "conversation",
              });
            }
          } catch {
            signal.throwIfAborted();
            // Unreadable IDs are omitted; never expose native storage failures.
          }
        }

        return sessions;
      }),
    children: (input, signal) =>
      safe(signal, async () => {
        decodeChildren(input);

        if (!(await conversation(input.parentID, signal)) || input.cursor) {
          throw new Error(unavailable);
        }

        // Greybeard: no fork scan on this surface; crew owns recorded children.
        return { sessions: [] };
      }),
    entries: (raw, signal) =>
      safe(signal, async () => {
        const input = decodeEntries(raw);
        const native = await conversation(input.sessionID, signal);

        if (!native) {
          throw new Error(unavailable);
        }

        const cursor = input.cursor
          ? decodeCursor(
              JSON.parse(
                Buffer.from(input.cursor, "base64url").toString("utf8"),
              ),
            )
          : undefined;

        if (cursor && cursor.sessionID !== input.sessionID) {
          throw new Error(unavailable);
        }

        // Native cursors retain order; do not override it on continuation.
        const page = await native.entries(
          cursor
            ? {}
            : {
                order: input.order === "asc" ? "ascending" : "descending",
              },
          input.limit,
          cursor?.page,
          withAbortSignal(signal, BACKGROUND_CONTEXT),
        );

        return {
          entries: mapPiHistory(page.items, input.detail),
          ...(page.next && {
            cursor: Buffer.from(
              JSON.stringify({
                sessionID: input.sessionID,
                page: page.next,
              }),
            ).toString("base64url"),
          }),
        };
      }),
  };
}

/** Like receipt recovery: no providers, extensions, or scheduling runtime.
 * readOnly makes scheduler.open() skip recovery writes and wake/reconcile;
 * resume() rejects. Entries use storage.scanEntries() on the read line.
 */
export async function readPiHistory<T>(
  dataDirectory: string,
  signal: AbortSignal,
  read: (history: SessionHistory) => Promise<T>,
): Promise<T> {
  let harness: Harness | undefined;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;

  try {
    try {
      signal.throwIfAborted();
      const path = join(dataDirectory, "pi.sqlite");
      await access(path);
      signal.throwIfAborted();
      // Storage.open() applies migrations. Viewing must not upgrade a store;
      // Fail closed unless its existing schema already matches this SDK.
      const probe = new Database(path, { readonly: true });

      try {
        const schema = probe
          .query<{ version: number }, []>(
            "SELECT version FROM durable_schema WHERE singleton=1",
          )
          .get();

        if (schema?.version !== CURRENT_SQLITE_SCHEMA_VERSION) {
          throw new Error(unavailable);
        }
      } finally {
        probe.close();
      }

      storage = await openNodeSqliteStorage(path);
      harness = await Harness.open(
        storage,
        {
          models: createModels(),
          registry: createRegistry(),
          readOnly: true,
        },
        withAbortSignal(signal, BACKGROUND_CONTEXT),
      );
      signal.throwIfAborted();
      const result = await read(piSessionHistory(harness));
      signal.throwIfAborted();

      return result;
    } finally {
      if (harness) {
        await harness.close(BACKGROUND_CONTEXT);
      } else {
        await storage?.close(BACKGROUND_CONTEXT);
      }
    }
  } catch {
    throw new Error(unavailable);
  }
}

function piRole(kind: string) {
  switch (kind) {
    case "pi.user":
      return "user";
    case "pi.assistant":
      return "assistant";
    default:
      return "tool";
  }
}
