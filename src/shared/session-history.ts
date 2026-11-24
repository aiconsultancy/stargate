import { Effect, Predicate, Schema, SchemaIssue } from "effect";

/** Bounds apply at every boundary: backend, plugin RPC and HTTP. */
export const HISTORY_PAGE = 50;
export const HISTORY_TEXT = 20_000;
export const HISTORY_PARTS = 100;

/**
 * Struct that rejects unknown keys without caller parse options. OpenCode RPC
 * decodes input and encodes output with default options, which strip keys.
 * This checks the raw object at its own node on both sides, so nested objects
 * and union branches stay exact. `flip` places a check on the encoded side,
 * as `Schema.annotateEncoded` does for annotations.
 */
export function exactStruct<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
) {
  const keys = new Set(Object.keys(fields));

  const exact = Schema.makeFilter<unknown>((input, ast) => {
    if (!Predicate.isObject(input)) {
      return "Expected an object";
    }

    // For...in, as Zod 4 strict objects did: inherited enumerable keys count.
    const issues: Schema.FilterIssue[] = [];

    for (const key in input) {
      if (!keys.has(key)) {
        issues.push({
          path: [key],
          issue: new SchemaIssue.UnexpectedKey(ast, input[key]),
        });
      }
    }

    return issues.length > 0 ? issues : undefined;
  });

  return Schema.flip(
    Schema.flip(Schema.Struct(fields).check(exact)).check(exact),
  );
}

// Zod's string bounds counted code points; keep that unit at every boundary.
const codePoints = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isBetweenCodePoints(minimum, maximum));

const id = codePoints(1, 512);
const time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const body = codePoints(0, HISTORY_TEXT);
const truncated = Schema.optional(Schema.Literal(true));

/** Opaque within one backend. Pi crew sessions served by the plugin use `pi:`. */
export const piHistoryPrefix = "pi:";

export const historySessionSchema = exactStruct({
  id,
  harness: Schema.Literals(["opencode", "pi-durable"]),
  kind: Schema.Literals(["captain", "crew", "subagent", "conversation"]),
  /** Short Stargate member ID for captain and crew roots. */
  member: Schema.optional(codePoints(0, 64)),
  parentID: Schema.optional(id),
  title: Schema.optional(codePoints(0, 300)),
  agent: Schema.optional(codePoints(0, 200)),
  model: Schema.optional(codePoints(0, 200)),
  createdAt: Schema.optional(time),
  updatedAt: Schema.optional(time),
});

export type HistorySession = typeof historySessionSchema.Type;

/**
 * `summary` detail keeps structure only: reasoning has no text and tools have
 * no input or output. `full` adds them, clipped to HISTORY_TEXT characters.
 */
export const historyPartSchema = Schema.Union([
  exactStruct({ type: Schema.Literal("text"), text: body, truncated }),
  exactStruct({
    type: Schema.Literal("reasoning"),
    text: Schema.optional(body),
    truncated,
  }),
  exactStruct({
    type: Schema.Literal("tool"),
    name: codePoints(0, 200),
    status: Schema.optional(
      Schema.Literals(["pending", "running", "completed", "error"]),
    ),
    input: Schema.optional(body),
    output: Schema.optional(body),
    truncated,
    /** Child session started by this call, when the harness records it. */
    sessionID: Schema.optional(id),
  }),
  /** Non-message events: compaction, model or agent switches, shell runs. */
  exactStruct({ type: Schema.Literal("notice"), label: codePoints(0, 300) }),
]);

export type HistoryPart = typeof historyPartSchema.Type;

// Mapping fills role, time and model while reading a record; keep them mutable.
export const historyEntrySchema = exactStruct({
  id,
  role: Schema.mutableKey(
    Schema.Literals(["user", "assistant", "system", "tool"]),
  ),
  createdAt: Schema.mutableKey(Schema.optional(time)),
  model: Schema.mutableKey(Schema.optional(codePoints(0, 200))),
  parts: Schema.Array(historyPartSchema).check(
    Schema.isMaxLength(HISTORY_PARTS),
  ),
  /** Parts beyond HISTORY_PARTS; they are counted, never silently dropped. */
  omittedParts: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});

export type HistoryEntry = typeof historyEntrySchema.Type;

const cursor = Schema.optional(codePoints(1, 4096));

const limit = (fallback: number) =>
  Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: HISTORY_PAGE }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(fallback)));

export const historyDescribeInputSchema = exactStruct({
  ids: Schema.Array(id).check(Schema.isBetweenLength(1, HISTORY_PAGE)),
});

// Callers collect and return these lists as mutable arrays.
const sessions = Schema.mutable(Schema.Array(historySessionSchema)).check(
  Schema.isMaxLength(HISTORY_PAGE),
);

export const historySessionsSchema = exactStruct({ sessions });

export const historyChildrenInputSchema = exactStruct({
  parentID: id,
  cursor,
  limit: limit(HISTORY_PAGE),
  /** Internal recent-child lookup for the Fleet API. */
  updatedSince: Schema.optional(time),
});

export type HistoryChildrenInput = typeof historyChildrenInputSchema.Type;

export const historySessionPageSchema = exactStruct({ sessions, cursor });

export type HistorySessionPage = typeof historySessionPageSchema.Type;

export const historyEntriesInputSchema = exactStruct({
  sessionID: id,
  cursor,
  limit: limit(30),
  /** First page only; a returned cursor keeps its original order. */
  order: Schema.Literals(["asc", "desc"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("desc" as const)),
  ),
  detail: Schema.Literals(["summary", "full"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("summary" as const)),
  ),
});

export type HistoryEntriesInput = typeof historyEntriesInputSchema.Type;

export const historyEntryPageSchema = exactStruct({
  entries: Schema.Array(historyEntrySchema).check(
    Schema.isMaxLength(HISTORY_PAGE),
  ),
  cursor,
});

export type HistoryEntryPage = typeof historyEntryPageSchema.Type;

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
