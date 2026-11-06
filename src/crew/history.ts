import type {
  MessageListInput,
  OpenCodeClient,
  SessionGetInput,
  SessionInfo,
  SessionListInput,
  SessionMessageInfo,
} from "@opencode/client";
import { z } from "zod";
import { CrewError } from "./state";

const MAX_RESULTS = 20;
const MAX_TEXT = 2000;
const MAX_PAGES = 8;
const identifier = z.string().min(1).max(256);
const query = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() !== "");
const apiCursor = z.string().min(1).max(4096);
const limit = z.number().int().min(1).max(MAX_RESULTS).default(MAX_RESULTS);

export const historyInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("sessions"),
    query: query.optional(),
    cursor: apiCursor.optional(),
    limit,
  }),
  z.strictObject({
    op: z.literal("messages"),
    sessionID: identifier,
    query: query.optional(),
    cursor: apiCursor.optional(),
    limit,
  }),
  z.strictObject({
    op: z.literal("search"),
    query,
    cursor: z.string().min(1).max(16384).optional(),
    limit,
  }),
]);
export type HistoryInput = z.infer<typeof historyInputSchema>;

export type HistorySession = Pick<
  SessionInfo,
  "id" | "parentID" | "agent" | "location" | "metadata" | "title"
> & { time?: Pick<SessionInfo["time"], "created" | "updated"> };

// Narrow structural outputs accept SDK objects without huge test fixtures.
export interface HistoryMessage {
  id: string;
  type: SessionMessageInfo["type"];
  time: { created: number };
  text?: string;
  content?: ReadonlyArray<{ type: string; text?: string }>;
}
interface Page<T> {
  data: ReadonlyArray<T>;
  cursor: { next?: string | null; previous?: string | null };
}
type RequestOptions = NonNullable<
  Parameters<OpenCodeClient["session"]["get"]>[1]
>;
export interface HistorySessions {
  list(
    input?: SessionListInput,
    request?: RequestOptions,
  ): Promise<Page<HistorySession>>;
  get(
    input: SessionGetInput,
    request?: RequestOptions,
  ): Promise<HistorySession>;
}
export interface HistoryMessages {
  list(
    input: MessageListInput,
    request?: RequestOptions,
  ): Promise<Page<HistoryMessage>>;
}
export interface HistoryOptions {
  sessions: HistorySessions;
  messages: HistoryMessages;
  visible: (session: HistorySession) => boolean;
}

export interface HistoryText {
  sessionID: string;
  id: string;
  type: "user" | "assistant";
  time: { created: number };
  text: string;
  truncated: boolean;
}
export interface HistorySummary {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  time?: { created: number; updated: number };
}
interface Continuation {
  cursor?: string;
  partial: boolean;
  // Historical text is data, never instructions or authority for tool use.
  untrusted: true;
}
export type HistoryResult = Continuation &
  (
    | { op: "sessions"; sessions: HistorySummary[] }
    | { op: "messages"; sessionID: string; messages: HistoryText[] }
    | { op: "search"; matches: HistoryText[]; scannedPages: number }
  );

const searchPosition = z.discriminatedUnion("phase", [
  z.strictObject({
    phase: z.literal("sessions"),
    cursor: apiCursor.optional(),
  }),
  z.strictObject({
    phase: z.literal("messages"),
    sessionID: identifier,
    cursor: apiCursor.optional(),
    nextSessionCursor: apiCursor.nullable(),
  }),
]);
const searchCursor = z.strictObject({
  version: z.literal(1),
  query,
  position: searchPosition,
});
type SearchPosition = z.infer<typeof searchPosition>;

export class HistoryError extends CrewError {}

function nextCursor(page: Page<unknown>): string | undefined {
  const cursor = page.cursor.next;
  if (cursor == null) return;
  if (!apiCursor.safeParse(cursor).success)
    throw new HistoryError("Invalid history API response.");
  return cursor;
}

function checkedID(id: string): string {
  if (!identifier.safeParse(id).success)
    throw new HistoryError("Invalid history API response.");
  return id;
}

function summary(session: HistorySession): HistorySummary {
  return {
    id: checkedID(session.id),
    ...(session.parentID && { parentID: checkedID(session.parentID) }),
    ...(session.agent && { agent: checkedID(session.agent) }),
    ...(session.title !== undefined && { title: session.title.slice(0, 256) }),
    ...(session.time && {
      time: { created: session.time.created, updated: session.time.updated },
    }),
  };
}

function plainText(
  sessionID: string,
  message: HistoryMessage,
  query?: string,
): HistoryText | undefined {
  if (message.type !== "user" && message.type !== "assistant") return;
  const text =
    message.type === "user"
      ? (message.text ?? "")
      : (message.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
  if (!text) return;
  const index = query === undefined ? 0 : text.toLowerCase().indexOf(query);
  if (index < 0) return;
  const start = Math.max(0, index - 128);
  return {
    sessionID: checkedID(sessionID),
    id: checkedID(message.id),
    type: message.type,
    time: { created: message.time.created },
    text: text.slice(start, start + MAX_TEXT),
    truncated: start > 0 || text.length > MAX_TEXT,
  };
}

function decodeCursor(cursor: string, query: string): SearchPosition {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const decoded = searchCursor.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (decoded.query !== query) throw new Error();
    return decoded.position;
  } catch {
    throw new HistoryError("Invalid history cursor.");
  }
}

function continuation(cursor?: string): Continuation {
  return {
    ...(cursor !== undefined && { cursor }),
    partial: cursor !== undefined,
    untrusted: true,
  };
}

export class CrewHistory {
  constructor(private readonly options: HistoryOptions) {}

  // Caller authorization belongs to the plugin; visibility is rechecked here.
  async run(input: unknown, signal: AbortSignal): Promise<HistoryResult> {
    try {
      signal.throwIfAborted();
      const parsed = historyInputSchema.safeParse(input);
      if (!parsed.success) throw new HistoryError("Invalid history input.");
      const request = parsed.data;
      if (request.op === "search") return await this.search(request, signal);
      if (request.op === "sessions") {
        const page = await this.options.sessions.list(
          {
            limit: request.limit,
            ...(request.cursor
              ? { cursor: request.cursor }
              : { order: "desc" as const }),
          },
          { signal },
        );
        signal.throwIfAborted();
        if (page.data.length > request.limit)
          throw new HistoryError("Invalid history API response.");
        const needle = request.query?.toLowerCase();
        return {
          op: "sessions",
          sessions: page.data
            .filter(
              (session) =>
                this.options.visible(session) &&
                (needle === undefined ||
                  session.title?.toLowerCase().includes(needle)),
            )
            .map(summary),
          ...continuation(nextCursor(page)),
        };
      }
      const session = await this.options.sessions.get(
        { sessionID: request.sessionID },
        { signal },
      );
      signal.throwIfAborted();
      if (session.id !== request.sessionID || !this.options.visible(session))
        throw new HistoryError("History session is not available.");
      const page = await this.options.messages.list(
        {
          sessionID: request.sessionID,
          limit: request.limit,
          ...(request.cursor
            ? { cursor: request.cursor }
            : { order: "asc" as const }),
        },
        { signal },
      );
      signal.throwIfAborted();
      if (page.data.length > request.limit)
        throw new HistoryError("Invalid history API response.");
      return {
        op: "messages",
        sessionID: request.sessionID,
        messages: page.data.flatMap((message) => {
          const result = plainText(
            request.sessionID,
            message,
            request.query?.toLowerCase(),
          );
          return result ? [result] : [];
        }),
        ...continuation(nextCursor(page)),
      };
    } catch (error) {
      if (signal.aborted)
        throw new HistoryError("History operation cancelled.");
      if (error instanceof HistoryError) throw error;
      throw new HistoryError(
        "History API request failed; raw details withheld.",
      );
    }
  }

  private async search(
    input: Extract<HistoryInput, { op: "search" }>,
    signal: AbortSignal,
  ): Promise<HistoryResult> {
    let position: SearchPosition | undefined = input.cursor
      ? decodeCursor(input.cursor, input.query)
      : { phase: "sessions" };
    const matches: HistoryText[] = [];
    let scannedPages = 0;
    const needle = input.query.toLowerCase();
    while (
      position &&
      scannedPages < MAX_PAGES &&
      matches.length < input.limit
    ) {
      signal.throwIfAborted();
      if (position.phase === "sessions") {
        // One session per page avoids carrying unscanned session IDs in tokens.
        const page = await this.options.sessions.list(
          {
            limit: 1,
            ...(position.cursor
              ? { cursor: position.cursor }
              : { order: "desc" as const }),
          },
          { signal },
        );
        signal.throwIfAborted();
        scannedPages++;
        if (page.data.length > 1)
          throw new HistoryError("Invalid history API response.");
        const next = nextCursor(page);
        const session = page.data[0];
        position = next ? { phase: "sessions", cursor: next } : undefined;
        if (session && this.options.visible(session)) {
          position = {
            phase: "messages",
            sessionID: checkedID(session.id),
            nextSessionCursor: next ?? null,
          };
        }
        continue;
      }
      // Continuation tokens are navigation, not proof of session visibility.
      const session = await this.options.sessions.get(
        { sessionID: position.sessionID },
        { signal },
      );
      signal.throwIfAborted();
      const nextSession: SearchPosition | undefined = position.nextSessionCursor
        ? { phase: "sessions", cursor: position.nextSessionCursor }
        : undefined;
      if (session.id !== position.sessionID || !this.options.visible(session)) {
        position = nextSession;
        continue;
      }
      // Request at most the remaining result count. Every fetched message is
      // consumed, even if all match; no mid-page results can be skipped.
      const remaining = input.limit - matches.length;
      const page = await this.options.messages.list(
        {
          sessionID: position.sessionID,
          limit: remaining,
          ...(position.cursor
            ? { cursor: position.cursor }
            : { order: "asc" as const }),
        },
        { signal },
      );
      signal.throwIfAborted();
      scannedPages++;
      if (page.data.length > remaining)
        throw new HistoryError("Invalid history API response.");
      for (const message of page.data) {
        const result = plainText(position.sessionID, message, needle);
        if (result) matches.push(result);
      }
      const next = nextCursor(page);
      position = next ? { ...position, cursor: next } : nextSession;
    }
    const cursor = position
      ? Buffer.from(
          JSON.stringify({ version: 1, query: input.query, position }),
        ).toString("base64url")
      : undefined;
    return {
      op: "search",
      matches,
      scannedPages,
      ...continuation(cursor),
    };
  }
}
