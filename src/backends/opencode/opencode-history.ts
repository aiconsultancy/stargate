import {
  type MessageListInput,
  type ModelRef,
  type SessionGetInput,
  type SessionInfo,
  type SessionListInput,
  type SessionMessageAssistantTool,
  type SessionMessageInfo,
  isSessionNotFoundError,
} from "@opencode/client";
import { Schema } from "effect";
import { CrewReporting } from "../../crew/reporting/report-rpc";
import {
  HISTORY_PARTS,
  type HistoryChildrenInput,
  type HistoryEntriesInput,
  type HistoryEntry,
  type HistoryPart,
  type HistorySession,
  type SessionHistory,
  clipHistory,
  historyChildrenInputSchema,
  historyDescribeInputSchema,
  historyEntriesInputSchema,
  historyEntryPageSchema,
  historySessionPageSchema,
  historySessionsSchema,
  piHistoryPrefix,
} from "../../shared/session-history";

type Session = Pick<
  SessionInfo,
  "id" | "parentID" | "title" | "agent" | "model" | "time"
>;

interface Page<T> {
  data: readonly T[];
  cursor: { next?: string | null; previous?: string | null };
}

interface Request {
  signal: AbortSignal;
}

interface ReportingRequest extends Request {
  location: { directory: string };
}

export interface OpenCodeHistoryReporting {
  historyRoots(
    input: Record<string, never>,
    request: ReportingRequest,
  ): Promise<unknown>;
  historyDescribe(
    input: { ids: string[] },
    request: ReportingRequest,
  ): Promise<unknown>;
  historyChildren(
    input: HistoryChildrenInput,
    request: ReportingRequest,
  ): Promise<unknown>;
  historyEntries(
    input: HistoryEntriesInput,
    request: ReportingRequest,
  ): Promise<unknown>;
}

/** Read-only structural subset; fixtures need neither an SDK nor a server. */
export interface OpenCodeHistoryClient {
  session: {
    get(input: SessionGetInput, request: Request): Promise<Session>;
    list(input: SessionListInput, request: Request): Promise<Page<Session>>;
  };
  message: {
    list(
      input: MessageListInput,
      request: Request,
    ): Promise<Page<SessionMessageInfo>>;
  };
  rpc(definition: typeof CrewReporting): OpenCodeHistoryReporting;
}

const decodeDescribe = Schema.decodeUnknownSync(historyDescribeInputSchema);
const decodeChildren = Schema.decodeUnknownSync(historyChildrenInputSchema);
const decodeEntries = Schema.decodeUnknownSync(historyEntriesInputSchema);
const decodeSessions = Schema.decodeUnknownSync(historySessionsSchema);
const decodeSessionPage = Schema.decodeUnknownSync(historySessionPageSchema);
const decodeEntryPage = Schema.decodeUnknownSync(historyEntryPageSchema);

const FAILURE =
  "Session history unavailable or cancelled; raw details withheld.";

const DESCRIBE_CONCURRENCY = 5;

function modelName(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant !== undefined ? `#${model.variant}` : ""}`.slice(
    0,
    200,
  );
}

function sessionInfo(session: Session): HistorySession {
  return {
    id: session.id,
    harness: "opencode",
    kind: session.parentID !== undefined ? "subagent" : "conversation",
    ...(session.parentID !== undefined && { parentID: session.parentID }),
    ...(session.title !== undefined && { title: session.title.slice(0, 300) }),
    ...(session.agent !== undefined && { agent: session.agent.slice(0, 200) }),
    ...(session.model !== undefined && { model: modelName(session.model) }),
    createdAt: session.time.created,
    updatedAt: session.time.updated,
  };
}

function notice(label: string): HistoryPart {
  return { type: "notice", label: label.slice(0, 300) };
}

function toolBody(value: unknown): ReturnType<typeof clipHistory> {
  return clipHistory(typeof value === "string" ? value : JSON.stringify(value));
}

function toolPart(
  tool: SessionMessageAssistantTool,
  full: boolean,
): HistoryPart {
  const state = tool.state;
  // Installed OpenCode subagent renderer reads these two metadata keys.
  // Do not infer a child from input.sessionID: a failed call may never start it.
  const metadata = "metadata" in state ? state.metadata : undefined;
  const child = metadata?.["sessionID"] ?? metadata?.["sessionId"];
  const input = full ? toolBody(state.input) : undefined;

  const output =
    full && "content" in state && state.content !== undefined
      ? toolBody(state.content)
      : full && state.status === "error"
        ? toolBody(state.error.message)
        : undefined;

  return {
    type: "tool",
    name: tool.name.slice(0, 200),
    status: state.status === "streaming" ? "pending" : state.status,
    ...(typeof child === "string" && { sessionID: child }),
    ...(input && { input: input.text }),
    ...(output && { output: output.text }),
    ...((input?.truncated ?? output?.truncated) && { truncated: true }),
  };
}

function entry(
  message: SessionMessageInfo,
  full: boolean,
): HistoryEntry | undefined {
  let role: HistoryEntry["role"] = "system";
  let parts: HistoryPart[];

  switch (message.type) {
    case "idle":
      return;
    case "user":
      role = "user";
      parts = [
        { type: "text", ...clipHistory(message.text) },
        ...(message.files ?? []).map((file) =>
          notice(`Attachment: ${file.name ?? file.mime}`),
        ),
        ...(message.agents ?? []).map((agent) =>
          notice(`Agent: ${agent.name}`),
        ),
        ...(message.skills ?? []).map((skill) =>
          notice(`Skill: ${skill.name}`),
        ),
      ];
      break;
    case "assistant":
      role = "assistant";
      parts = message.content.map((part): HistoryPart => {
        if (part.type === "text")
          return { type: "text", ...clipHistory(part.text) };

        if (part.type === "reasoning")
          return { type: "reasoning", ...(full && clipHistory(part.text)) };

        return toolPart(part, full);
      });
      break;
    case "synthetic":
    case "system":
      parts = [{ type: "text", ...clipHistory(message.text) }];
      break;
    case "shell": {
      role = "tool";
      const input = full ? clipHistory(message.command) : undefined;

      const output =
        full && message.output ? clipHistory(message.output.output) : undefined;

      parts = [
        {
          type: "tool",
          name: "shell",
          status:
            message.status === "running"
              ? "running"
              : message.status === "exited" &&
                  (message.exit === undefined || message.exit === 0)
                ? "completed"
                : "error",
          ...(input && { input: input.text }),
          ...(output && { output: output.text }),
          ...((input?.truncated ??
            output?.truncated ??
            (full && message.output?.truncated)) && { truncated: true }),
        },
      ];
      break;
    }

    case "skill":
      parts = [notice(`Skill: ${message.name}`)];
      break;
    case "compaction":
      parts = [notice(`Compaction: ${message.status}`)];
      break;
    case "agent-switched":
      parts = [notice(`Agent: ${message.agent}`)];
      break;
    case "model-switched":
      parts = [notice(`Model: ${modelName(message.model)}`)];
      break;
    case "location-switched":
      parts = [notice(`Location: ${message.location.directory}`)];
      break;
  }

  return {
    id: message.id,
    role,
    createdAt: message.time.created,
    ...("model" in message &&
      message.model && { model: modelName(message.model) }),
    parts: parts.slice(0, HISTORY_PARTS),
    ...(parts.length > HISTORY_PARTS && {
      omittedParts: parts.length - HISTORY_PARTS,
    }),
  };
}

export class OpenCodeHistory implements SessionHistory {
  public constructor(
    private readonly client: OpenCodeHistoryClient,
    private readonly directory: string,
  ) {}

  private async read<T>(
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      signal.throwIfAborted();
      const result = await run();
      signal.throwIfAborted();

      return result;
    } catch {
      throw new Error(FAILURE);
    }
  }

  private request(signal: AbortSignal): ReportingRequest {
    return { location: { directory: this.directory }, signal };
  }

  public roots(signal: AbortSignal): Promise<HistorySession[]> {
    return this.read(
      signal,
      async () =>
        decodeSessions(
          await this.client
            .rpc(CrewReporting)
            .historyRoots({}, this.request(signal)),
        ).sessions,
    );
  }

  public describe(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<HistorySession[]> {
    return this.read(signal, async () => {
      const input = decodeDescribe({ ids });
      const piIDs = input.ids.filter((id) => id.startsWith(piHistoryPrefix));

      const sessions =
        piIDs.length > 0
          ? decodeSessions(
              await this.client
                .rpc(CrewReporting)
                .historyDescribe({ ids: piIDs }, this.request(signal)),
            ).sessions
          : [];

      const nativeIDs = input.ids.filter(
        (id) => !id.startsWith(piHistoryPrefix),
      );

      for (
        let index = 0;
        index < nativeIDs.length;
        index += DESCRIBE_CONCURRENCY
      ) {
        signal.throwIfAborted();

        const batch = await Promise.all(
          nativeIDs
            .slice(index, index + DESCRIBE_CONCURRENCY)
            .map(async (id) => {
              try {
                const session = await this.client.session.get(
                  { sessionID: id },
                  { signal },
                );

                signal.throwIfAborted();

                if (session.id !== id) throw new Error(FAILURE);

                return sessionInfo(session);
              } catch (error) {
                signal.throwIfAborted();

                if (isSessionNotFoundError(error)) return;
                throw error;
              }
            }),
        );

        sessions.push(...batch.filter((session) => session !== undefined));
      }

      const found = new Map(sessions.map((session) => [session.id, session]));

      return decodeSessions({
        sessions: input.ids.flatMap((id) => {
          const session = found.get(id);

          return session ? [session] : [];
        }),
      }).sessions;
    });
  }

  public children(input: HistoryChildrenInput, signal: AbortSignal) {
    return this.read(signal, async () => {
      const request = decodeChildren(input);

      if (request.parentID.startsWith(piHistoryPrefix))
        return decodeSessionPage(
          await this.client
            .rpc(CrewReporting)
            .historyChildren(request, this.request(signal)),
        );

      const page = await this.client.session.list(
        {
          limit: request.limit,
          // Native cursors retain filters and order; do not combine them.
          // Omit archived on the first page to include both archive states.
          ...(request.cursor
            ? { cursor: request.cursor }
            : { parentID: request.parentID, order: "desc" }),
        },
        { signal },
      );

      if (page.data.length > request.limit) throw new Error(FAILURE);

      return decodeSessionPage({
        sessions: page.data.map(sessionInfo),
        ...(page.cursor.next !== null &&
          page.cursor.next !== undefined && { cursor: page.cursor.next }),
      });
    });
  }

  public entries(input: HistoryEntriesInput, signal: AbortSignal) {
    return this.read(signal, async () => {
      const request = decodeEntries(input);

      if (request.sessionID.startsWith(piHistoryPrefix))
        return decodeEntryPage(
          await this.client
            .rpc(CrewReporting)
            .historyEntries(request, this.request(signal)),
        );

      const page = await this.client.message.list(
        {
          sessionID: request.sessionID,
          limit: request.limit,
          ...(request.cursor
            ? { cursor: request.cursor }
            : { order: request.order }),
        },
        { signal },
      );

      if (page.data.length > request.limit) throw new Error(FAILURE);

      return decodeEntryPage({
        entries: page.data.flatMap((message) => {
          const result = entry(message, request.detail === "full");

          return result ? [result] : [];
        }),
        ...(page.cursor.next !== null &&
          page.cursor.next !== undefined && { cursor: page.cursor.next }),
      });
    });
  }
}
