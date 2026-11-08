import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open } from "node:fs/promises";
import { join } from "node:path";
import { type AgentBackend, createBackend } from "./backend";
import { loadConfig } from "./config";
import { transcriptReply } from "./gateway";
import {
  backendFingerprint,
  conversationKey,
  transcriptChunks,
} from "./routing";
import { loadEnvironment } from "./runtime";
import { Store } from "./store";

export type TranscriptRepair = {
  session: string;
  cursor: string;
  delivered: string[];
  missing: { id: string; created: string; characters: number }[];
  /** Failed outbox rows in scope that `apply` retries with their stored text. */
  requeued: string[];
  /** Missing replies whose outbox row already exists; `apply` refuses them. */
  conflicts: string[];
  queued: number;
};

// Chunking can close and reopen fences; compare prose, not Markdown framing.
const comparable = (text: string) =>
  text
    .replace(/^[ \t]*(?:```|~~~).*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Find settled public replies after `since` that no stored Slack reply
 * contains, and optionally queue them through normal gateway delivery. Failed
 * outbox rows in scope are retried, never rewritten or re-run. This seeds or
 * advances the thread cursor to the repaired head.
 */
export async function repairTranscript(input: {
  store: Store;
  backend: AgentBackend;
  botKey: string;
  channel: string;
  thread: string;
  /** Native message ID; only later messages are considered. */
  since: string;
  /** Restrict repair to these native assistant message IDs. */
  only?: readonly string[];
  apply?: boolean;
  limit?: number;
  signal?: AbortSignal;
}): Promise<TranscriptRepair> {
  if (input.backend.sessionID)
    throw new Error("Captain-scoped transcript repair unsupported");
  if (!input.backend.transcript)
    throw new Error("Backend has no transcript support");
  const conversation = conversationKey(
    input.botKey,
    input.channel,
    input.thread,
  );
  const target = input.store.transcriptTarget(input.botKey, conversation);
  if (!target) throw new Error("No mapped conversation for this bot thread");
  const read = await input.backend
    .transcript(
      target.session,
      input.since,
      input.signal ?? AbortSignal.timeout(300_000),
    )
    .catch(() => {
      throw new Error("since is not readable in the mapped session");
    });
  const entries = input.only
    ? read.entries.filter((entry) => input.only?.includes(entry.id))
    : read.entries;
  if (input.only && entries.length !== new Set(input.only).size)
    throw new Error("Some requested messages are not settled public replies");
  const rows = input.store.transcriptRows(input.botKey, conversation);
  const scope = new Set(entries.map((entry) => `transcript:${entry.id}`));
  const requeue = rows.filter(
    (row) => row.status === "failed" && scope.has(row.eventId),
  );
  // Requeued rows deliver their stored text, so that text counts as sent.
  const sent = comparable(
    [
      ...input.store.replies(input.botKey, conversation),
      ...requeue.map((row) => row.response),
    ]
      .map((reply) => reply.join("\n"))
      .join("\n"),
  );
  const delivered: string[] = [];
  const missing: { id: string; created: number; text: string }[] = [];
  for (const entry of entries) {
    const text = transcriptReply([entry]);
    if (!text) continue;
    if (sent.includes(comparable(text))) delivered.push(entry.id);
    else missing.push({ id: entry.id, created: entry.created, text });
  }
  const limit = input.limit ?? 20;
  if (missing.length > limit)
    throw new Error(`Found ${missing.length} missing replies; limit ${limit}`);
  const existing = new Set(rows.map((row) => row.eventId));
  const conflicts = missing
    .filter((entry) => existing.has(`transcript:${entry.id}`))
    .map((entry) => entry.id);
  let queued = 0;
  if (input.apply) {
    if (conflicts.length)
      throw new Error(
        `Outbox rows conflict with missing replies: ${conflicts.join(", ")}`,
      );
    const result = input.store.appendTranscript({
      botKey: input.botKey,
      conversation,
      from: target.cursor,
      cursor: read.cursor,
      // Slack cannot insert older replies; label their original time instead.
      replies: missing.map((entry) => ({
        eventId: `transcript:${entry.id}`,
        chunks: transcriptChunks(
          `_Delayed update, originally written ${time(entry.created)}._\n\n${entry.text}`,
        ),
      })),
      requeue: requeue.map((row) => row.eventId),
    });
    if (result === undefined)
      throw new Error("Thread is busy or changed; run the repair again");
    queued = result;
  }
  return {
    session: target.session,
    cursor: read.cursor,
    delivered,
    missing: missing.map((entry) => ({
      id: entry.id,
      created: time(entry.created),
      characters: entry.text.length,
    })),
    requeued: requeue.map((row) => row.eventId),
    conflicts,
    queued,
  };
}

function time(ms: number) {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Operator helper: resolve one bot's exact thread namespace from Pogo config
 * and state, then run `repairTranscript`. Dry run unless `apply` is true.
 */
export async function repairThread(input: {
  config: string;
  bot: string;
  channel: string;
  thread: string;
  since: string;
  only?: readonly string[];
  apply?: boolean;
  limit?: number;
}) {
  await loadEnvironment(input.config);
  const config = await loadConfig(input.config);
  const bot = config.bots.find((candidate) => candidate.id === input.bot);
  if (!bot) throw new Error("Unknown bot ID");
  // Harden existing state before SQLite creates WAL/SHM. Never create a
  // replacement database or follow a database symlink during repair.
  await chmod(config.dataDirectory, 0o700);
  const path = join(config.dataDirectory, "pogo.sqlite");
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Invalid gateway database");
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
  const store = new Store(path);
  try {
    const keys = store.threadBots(input.channel, input.thread).filter((key) => {
      const parts: unknown = JSON.parse(key);
      return (
        Array.isArray(parts) &&
        parts[0] === bot.id &&
        parts[1] === bot.slack.appId &&
        parts[4] === backendFingerprint(bot)
      );
    });
    const [botKey] = keys;
    if (!botKey || keys.length !== 1)
      throw new Error("Expected one current bot namespace for this thread");
    const backend = await createBackend(bot.backend, {
      dataDirectory: join(
        config.dataDirectory,
        bot.id,
        createHash("sha256").update(botKey).digest("hex"),
      ),
    });
    try {
      return await repairTranscript({ ...input, store, backend, botKey });
    } finally {
      await backend.close();
    }
  } finally {
    store.close();
  }
}
