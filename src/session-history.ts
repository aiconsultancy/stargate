import { z } from "zod";

/** Bounds apply at every boundary: backend, plugin RPC and HTTP. */
export const HISTORY_PAGE = 50;
export const HISTORY_TEXT = 20_000;
export const HISTORY_PARTS = 100;

const id = z.string().min(1).max(512);
const time = z.number().int().nonnegative();
const body = z.string().max(HISTORY_TEXT);
const truncated = z.literal(true).optional();

/** Opaque within one backend. Pi crew sessions served by the plugin use `pi:`. */
export const piHistoryPrefix = "pi:";

export const historySessionSchema = z.strictObject({
  id,
  harness: z.enum(["opencode", "pi-durable"]),
  kind: z.enum(["captain", "crew", "subagent", "conversation"]),
  /** Short Stargate member ID for captain and crew roots. */
  member: z.string().max(64).optional(),
  parentID: id.optional(),
  title: z.string().max(300).optional(),
  agent: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  createdAt: time.optional(),
  updatedAt: time.optional(),
});
export type HistorySession = z.infer<typeof historySessionSchema>;

/**
 * `summary` detail keeps structure only: reasoning has no text and tools have
 * no input or output. `full` adds them, clipped to HISTORY_TEXT characters.
 */
export const historyPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: body, truncated }),
  z.strictObject({
    type: z.literal("reasoning"),
    text: body.optional(),
    truncated,
  }),
  z.strictObject({
    type: z.literal("tool"),
    name: z.string().max(200),
    status: z.enum(["pending", "running", "completed", "error"]).optional(),
    input: body.optional(),
    output: body.optional(),
    truncated,
    /** Child session started by this call, when the harness records it. */
    sessionID: id.optional(),
  }),
  /** Non-message events: compaction, model or agent switches, shell runs. */
  z.strictObject({ type: z.literal("notice"), label: z.string().max(300) }),
]);
export type HistoryPart = z.infer<typeof historyPartSchema>;

export const historyEntrySchema = z.strictObject({
  id,
  role: z.enum(["user", "assistant", "system", "tool"]),
  createdAt: time.optional(),
  model: z.string().max(200).optional(),
  parts: z.array(historyPartSchema).max(HISTORY_PARTS),
  /** Parts beyond HISTORY_PARTS; they are counted, never silently dropped. */
  omittedParts: z.number().int().positive().optional(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

const cursor = z.string().min(1).max(4096).optional();
const limit = z.number().int().min(1).max(HISTORY_PAGE);

export const historyDescribeInputSchema = z.strictObject({
  ids: z.array(id).min(1).max(HISTORY_PAGE),
});
export const historySessionsSchema = z.strictObject({
  sessions: z.array(historySessionSchema).max(HISTORY_PAGE),
});
export const historyChildrenInputSchema = z.strictObject({
  parentID: id,
  cursor,
  limit: limit.default(HISTORY_PAGE),
});
export type HistoryChildrenInput = z.infer<typeof historyChildrenInputSchema>;
export const historySessionPageSchema = historySessionsSchema.extend({
  cursor,
});
export type HistorySessionPage = z.infer<typeof historySessionPageSchema>;

export const historyEntriesInputSchema = z.strictObject({
  sessionID: id,
  cursor,
  limit: limit.default(30),
  /** First page only; a returned cursor keeps its original order. */
  order: z.enum(["asc", "desc"]).default("desc"),
  detail: z.enum(["summary", "full"]).default("summary"),
});
export type HistoryEntriesInput = z.infer<typeof historyEntriesInputSchema>;
export const historyEntryPageSchema = z.strictObject({
  entries: z.array(historyEntrySchema).max(HISTORY_PAGE),
  cursor,
});
export type HistoryEntryPage = z.infer<typeof historyEntryPageSchema>;

/**
 * Read-only transcript access for one backend. Implementations never prompt,
 * fork, schedule or change a session, and never log transcript content.
 * Callers decide which sessions a viewer may read; see `dashboard-source.ts`.
 */
export interface SessionHistory {
  /** Crew roots known to this backend's coordination layer; often empty. */
  roots(signal: AbortSignal): Promise<HistorySession[]>;
  /** Metadata for known IDs. Unknown or unreadable IDs are omitted. */
  describe(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<HistorySession[]>;
  children(
    input: HistoryChildrenInput,
    signal: AbortSignal,
  ): Promise<HistorySessionPage>;
  entries(
    input: HistoryEntriesInput,
    signal: AbortSignal,
  ): Promise<HistoryEntryPage>;
}

/** Clip one part body; the flag tells the viewer that text was cut. */
export function clipHistory(text: string): {
  text: string;
  truncated?: true;
} {
  const characters = Array.from(text);
  return characters.length > HISTORY_TEXT
    ? { text: characters.slice(0, HISTORY_TEXT).join(""), truncated: true }
    : { text };
}
