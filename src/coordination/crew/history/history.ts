import type {
  MessageListInput,
  OpenCodeClient,
  SessionGetInput,
  SessionInfo,
  SessionListInput,
  SessionMessageInfo,
} from "@opencode/client";
import { Result, Schema } from "effect";
import { decodeSettings } from "../../../config/settings-errors";
import {
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsStruct,
} from "../../../config/settings-schema";
import { CrewError } from "../execution/state";

const MAX_RESULTS = 20;
const MAX_TEXT = 2000;
const MAX_PAGES = 32;
const SESSION_BATCH = 20;
const MESSAGE_BATCH = 100;

const identifier = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(256),
);

const query = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(200),
  Schema.makeFilter((value) => value.trim() !== ""),
);

const apiCursor = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(4096),
);

const limit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_RESULTS }),
).pipe(settingsDefault(MAX_RESULTS));

export const historyInputBranches = Schema.Union([
  settingsStruct({
    op: Schema.Literal("sessions"),
    query: Schema.optional(query),
    cursor: Schema.optional(apiCursor),
    limit,
  }),
  settingsStruct({
    op: Schema.Literal("messages"),
    sessionID: identifier,
    order: Schema.Literals(["asc", "desc"]).pipe(settingsDefault("asc")),
    query: Schema.optional(query),
    cursor: Schema.optional(apiCursor),
    limit,
  }),
  settingsStruct({
    op: Schema.Literal("search"),
    query,
    cursor: Schema.optional(
      Schema.String.check(
        Schema.isMinCodePoints(1),
        Schema.isMaxCodePoints(32_768),
      ),
    ),
    limit,
  }),
]);

export const historyInputSchema = settingsDiscriminatedUnion(
  "op",
  historyInputBranches.members,
);

export type HistoryInput = typeof historyInputSchema.Type;

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
  content?: readonly { type: string; text?: string }[];
}

interface Page<T> {
  data: readonly T[];
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

const sessionPosition = settingsStruct({
  phase: Schema.Literal("sessions"),
  cursor: Schema.optional(apiCursor),
});

const messagePosition = settingsStruct({
  phase: Schema.Literal("messages"),
  sessionID: identifier,
  cursor: Schema.optional(apiCursor),
  nextSessionCursor: Schema.NullOr(apiCursor),
  pendingSessionIDs: Schema.mutable(Schema.Array(identifier)).check(
    Schema.isMaxLength(SESSION_BATCH - 1),
  ),
  offset: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MESSAGE_BATCH - 1 }),
  ).pipe(settingsDefault(0)),
});

const searchPosition = settingsDiscriminatedUnion("phase", [
  sessionPosition,
  messagePosition,
]);

const searchCursor = settingsDiscriminatedUnion("version", [
  settingsStruct({
    version: Schema.Literal(1),
    query,
    position: settingsDiscriminatedUnion("phase", [
      sessionPosition,
      settingsStruct({
        phase: messagePosition.fields.phase,
        sessionID: identifier,
        cursor: Schema.optional(apiCursor),
        nextSessionCursor: Schema.NullOr(apiCursor),
      }),
    ]),
  }),
  settingsStruct({
    version: Schema.Literal(2),
    query,
    position: searchPosition,
  }),
]);

type SearchPosition = typeof searchPosition.Type;

export class HistoryError extends CrewError {}

function nextCursor(page: Page<unknown>): string | undefined {
  const cursor = page.cursor.next;

  if (cursor === null || cursor === undefined) {
    return;
  }

  if (Result.isFailure(Schema.decodeUnknownResult(apiCursor)(cursor))) {
    throw new HistoryError("Invalid history API response.");
  }

  return cursor;
}

function checkedID(id: string): string {
  if (Result.isFailure(Schema.decodeUnknownResult(identifier)(id))) {
    throw new HistoryError("Invalid history API response.");
  }

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
  if (message.type !== "user" && message.type !== "assistant") {
    return;
  }

  const text =
    message.type === "user"
      ? (message.text ?? "")
      : (message.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");

  if (!text) {
    return;
  }

  const index = query === undefined ? 0 : text.toLowerCase().indexOf(query);

  if (index < 0) {
    return;
  }

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
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error("History cursor is not base64url");
    }

    const decoded = decodeSettings(
      searchCursor,
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );

    if (decoded.query !== query) {
      throw new Error("History cursor belongs to another query");
    }

    const position = decoded.position;

    return position.phase === "messages" && !("pendingSessionIDs" in position)
      ? { ...position, pendingSessionIDs: [], offset: 0 }
      : position;
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
  public constructor(private readonly options: HistoryOptions) {}

  // Caller authorization belongs to the plugin; visibility is rechecked here.
  public async run(
    input: unknown,
    signal: AbortSignal,
  ): Promise<HistoryResult> {
    try {
      signal.throwIfAborted();
      const parsed = Schema.decodeUnknownResult(historyInputSchema)(input);

      if (Result.isFailure(parsed)) {
        throw new HistoryError("Invalid history input.");
      }

      const request = parsed.success;

      if (request.op === "search") {
        return await this.search(request, signal);
      }

      if (request.op === "sessions") {
        const page = await this.options.sessions.list(
          {
            limit: request.limit,
            ...(request.cursor
              ? { cursor: request.cursor }
              : {
                  order: "desc" as const,
                  ...(request.query !== undefined && { search: request.query }),
                }),
          },
          { signal },
        );

        signal.throwIfAborted();

        if (page.data.length > request.limit) {
          throw new HistoryError("Invalid history API response.");
        }

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
            .map((item) => summary(item)),
          ...continuation(nextCursor(page)),
        };
      }

      const session = await this.options.sessions.get(
        { sessionID: request.sessionID },
        { signal },
      );

      signal.throwIfAborted();

      if (session.id !== request.sessionID || !this.options.visible(session)) {
        throw new HistoryError("History session is not available.");
      }

      const page = await this.options.messages.list(
        {
          sessionID: request.sessionID,
          limit: request.limit,
          ...(request.cursor
            ? { cursor: request.cursor }
            : { order: request.order }),
        },
        { signal },
      );

      signal.throwIfAborted();

      if (page.data.length > request.limit) {
        throw new HistoryError("Invalid history API response.");
      }

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
      if (signal.aborted) {
        throw new HistoryError("History operation cancelled.");
      }

      if (error instanceof HistoryError) {
        throw error;
      }

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
    let verifiedSessionID: string | undefined;
    const needle = input.query.toLowerCase();

    while (
      position &&
      scannedPages < MAX_PAGES &&
      matches.length < input.limit
    ) {
      signal.throwIfAborted();

      if (position.phase === "sessions") {
        // Carry only pending IDs, never transcripts, between bounded scans.
        const page = await this.options.sessions.list(
          {
            limit: SESSION_BATCH,
            ...(position.cursor
              ? { cursor: position.cursor }
              : { order: "desc" as const }),
          },
          { signal },
        );

        signal.throwIfAborted();
        scannedPages++;

        if (page.data.length > SESSION_BATCH) {
          throw new HistoryError("Invalid history API response.");
        }

        const next = nextCursor(page);

        const [sessionID, ...pendingSessionIDs] = page.data
          .filter(this.options.visible)
          .map((session) => checkedID(session.id));

        position = next ? { phase: "sessions", cursor: next } : undefined;

        if (sessionID) {
          position = {
            phase: "messages",
            sessionID,
            pendingSessionIDs,
            offset: 0,
            nextSessionCursor: next ?? null,
          };
        }

        continue;
      }

      // Continuation tokens are navigation, not proof of session visibility.
      const [nextID, ...pendingSessionIDs] = position.pendingSessionIDs;

      const nextSession: SearchPosition | undefined = nextID
        ? {
            phase: "messages",
            sessionID: nextID,
            pendingSessionIDs,
            offset: 0,
            nextSessionCursor: position.nextSessionCursor,
          }
        : position.nextSessionCursor
          ? { phase: "sessions", cursor: position.nextSessionCursor }
          : undefined;

      if (verifiedSessionID !== position.sessionID) {
        const session = await this.options.sessions.get(
          { sessionID: position.sessionID },
          { signal },
        );

        signal.throwIfAborted();

        if (
          session.id !== position.sessionID ||
          !this.options.visible(session)
        ) {
          position = nextSession;
          continue;
        }

        verifiedSessionID = position.sessionID;
      }

      // Scan independently of the result limit. An offset replays only a
      // Partially consumed page, without putting message text in the cursor.
      const page = await this.options.messages.list(
        {
          sessionID: position.sessionID,
          limit: MESSAGE_BATCH,
          ...(position.cursor
            ? { cursor: position.cursor }
            : { order: "asc" as const }),
        },
        { signal },
      );

      signal.throwIfAborted();
      scannedPages++;

      if (page.data.length > MESSAGE_BATCH) {
        throw new HistoryError("Invalid history API response.");
      }

      if (position.offset > page.data.length) {
        throw new HistoryError("Invalid history cursor.");
      }

      let consumed = position.offset;

      for (const message of page.data.slice(position.offset)) {
        consumed++;
        const result = plainText(position.sessionID, message, needle);

        if (result) {
          matches.push(result);
        }

        if (matches.length === input.limit) {
          break;
        }
      }

      const next = nextCursor(page);
      position =
        consumed < page.data.length
          ? { ...position, offset: consumed }
          : next
            ? { ...position, cursor: next, offset: 0 }
            : nextSession;
    }

    const cursor = position
      ? Buffer.from(
          JSON.stringify({ version: 2, query: input.query, position }),
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
