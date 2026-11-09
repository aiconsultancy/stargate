import { setTimeout as delay } from "node:timers/promises";
import {
  isSessionNotFoundError,
  OpenCode,
  type SessionMessageInfo,
} from "@opencode/client";
import { SessionMessage } from "@opencode/schema";
import { z } from "zod";
import { type ActivityWatch, activitySnapshotSchema } from "../activity";
import { type Attachment, checkAttachments } from "../attachments";
import {
  type AgentBackend,
  latestInput,
  type PromptSourceContext,
  type TextSink,
  type Transcript,
  type TranscriptEntry,
  TranscriptUnavailable,
} from "../backend";
import { type BackendConfig, secret } from "../config";
import { CrewReporting } from "../crew/report-rpc";
import { type CrewStatusInput, crewStatusSchema } from "../crew-status";
import {
  boundaryRecord,
  closesBoundaryContext,
  InputBoundaryFold,
  type InputBoundaryRecord,
  resolveBoundaryContext,
} from "../input-boundary";
import {
  MaintenanceRPC,
  type MaintenanceWatch,
  maintenanceNoticeSchema,
} from "../maintenance";

type Config = Extract<BackendConfig, { type: "opencode" }>;
const pinnedSessionSchema = z.object({
  id: z.string(),
  parentID: z.string().optional(),
  fork: z.unknown().optional(),
  agent: z.string().optional(),
  location: z.object({ directory: z.string() }),
});
const pairingCode = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
  expires_in: z.number().int().positive().max(86_400),
});
const settledEvents = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

function publicEntry(message: SessionMessageInfo): TranscriptEntry | undefined {
  if (message.type !== "assistant") return;
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text
    ? { id: message.id, text, created: message.time.created }
    : undefined;
}

export class OpenCodeBackend implements AgentBackend {
  readonly supportsAttachments = true;
  private readonly client;
  private readonly pairingClient;
  /** Each session's latest submitted input; re-anchors a lost cursor. */
  private readonly inputs = new Map<string, string>();
  constructor(private readonly config: Config) {
    const options = {
      baseUrl: config.url,
      headers: Object.fromEntries(
        Object.entries(config.headersEnv).map(([header, env]) => [
          header,
          secret(env),
        ]),
      ),
    };
    this.client = OpenCode.make(options);
    // Same endpoint and authentication; never follow a pairing redirect.
    this.pairingClient = OpenCode.make({
      ...options,
      fetch: Object.assign(
        (url: URL | RequestInfo, init?: RequestInit) =>
          fetch(url, { ...init, redirect: "error" }),
        { preconnect: fetch.preconnect },
      ),
    });
  }

  async pair(signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const result = pairingCode.parse(
        await this.pairingClient.server.pair({ signal }),
      );
      signal.throwIfAborted();
      return { code: result.code, expiresIn: result.expires_in };
    } catch {
      // SDK failures and validation errors can contain credentials or codes.
      throw new Error("OpenCode pairing failed; outcome may be unknown");
    }
  }

  async crewStatus(input: CrewStatusInput, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const result = crewStatusSchema.parse(
        await this.client.rpc(CrewReporting).status(input, {
          location: { directory: this.config.directory },
          signal,
        }),
      );
      signal.throwIfAborted();
      return result;
    } catch {
      throw new Error(
        "Crew status unavailable; check the captain location and crew plugin.",
      );
    }
  }

  async createSession({
    title,
    signal,
  }: Parameters<AgentBackend["createSession"]>[0]) {
    if (this.sessionID !== undefined) {
      signal.throwIfAborted();
      try {
        const session = pinnedSessionSchema.parse(
          await this.client.session.get(
            { sessionID: this.sessionID },
            { signal },
          ),
        );
        signal.throwIfAborted();
        if (
          session.id !== this.sessionID ||
          session.parentID !== undefined ||
          session.fork !== undefined ||
          session.location.directory !== this.config.directory ||
          (this.config.agent !== undefined &&
            session.agent !== this.config.agent)
        ) {
          throw new Error("Incompatible pinned session");
        }
        // Operator-selected roots retain their stored model and permissions.
        return this.sessionID;
      } catch {
        signal.throwIfAborted();
        throw new Error("Pinned OpenCode session unavailable or incompatible");
      }
    }
    const session = await this.client.session.create(
      {
        title,
        location: { directory: this.config.directory },
        agent: this.config.agent,
        model: this.config.model,
        permissions: this.config.permissions,
      },
      { signal },
    );
    return session.id;
  }

  get sessionID(): string | undefined {
    return this.config.sessionID;
  }

  async prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
    onInput?: (id: string) => void,
    files: readonly Attachment[] = [],
    context?: PromptSourceContext,
  ) {
    checkAttachments(files);
    this.inputs.delete(sessionId);
    signal.throwIfAborted();
    const stop = new AbortController();
    const timer = new AbortController();
    const connected = Promise.withResolvers<void>();
    type Phase =
      | { type: "attaching" }
      | { type: "submitting"; input: string }
      | { type: "submitted"; input: string }
      | { type: "settled" };
    let phase: Phase = { type: "attaching" };
    const currentPhase = (): Phase => phase;
    const messages = new Map<string, Map<number, string>>();
    const ownership = new Map<string, "checking" | "owned" | "foreign">();
    const checks: Promise<void>[] = [];
    const publish = () => {
      if (phase.type !== "submitted" || !onText) return;
      const text = [...messages]
        .filter(([id]) => ownership.get(id) === "owned")
        .map(([, parts]) =>
          [...parts]
            .sort(([a], [b]) => a - b)
            .map(([, text]) => text)
            .join("\n"),
        )
        .join("\n\n");
      if (text) onText(text);
    };
    // Consume promptly: slow Slack writes must not block the shared event source.
    const events = onText
      ? (async () => {
          for await (const event of this.client.event.subscribe({
            types: ["session.text.delta", "session.text.ended"],
            signal: AbortSignal.any([signal, stop.signal]),
          })) {
            if (event.type === "server.connected") {
              connected.resolve();
              continue;
            }
            const current = currentPhase();
            if (
              current.type !== "submitted" ||
              event.data.sessionID !== sessionId
            )
              continue;
            const { assistantMessageID, ordinal } = event.data;
            if (ownership.get(assistantMessageID) === "foreign") continue;
            let parts = messages.get(assistantMessageID);
            if (!parts) {
              parts = new Map();
              messages.set(assistantMessageID, parts);
            }
            parts.set(
              ordinal,
              event.type === "session.text.delta"
                ? (parts.get(ordinal) ?? "") + event.data.delta
                : event.data.text,
            );
            if (ownership.get(assistantMessageID) === "owned") publish();
            else if (!ownership.has(assistantMessageID)) {
              ownership.set(assistantMessageID, "checking");
              // Events identify the session and assistant, not its input.
              // Only transcript placement proves this is not a queued prior turn.
              checks.push(
                this.followsInput(
                  sessionId,
                  current.input,
                  AbortSignal.any([signal, stop.signal]),
                  assistantMessageID,
                )
                  .then((owned) => {
                    ownership.set(
                      assistantMessageID,
                      owned ? "owned" : "foreign",
                    );
                    if (owned) publish();
                    else messages.delete(assistantMessageID);
                  })
                  .catch(() => {
                    // Uncertain previews stay private; final history still wins.
                  }),
              );
            }
          }
        })().catch(() => {
          // Live-only events are best effort; history remains authoritative.
          connected.resolve();
        })
      : Promise.resolve();
    try {
      if (onText) {
        await Promise.race([
          connected.promise,
          delay(2000, undefined, { signal: timer.signal }),
        ]);
        timer.abort();
      }
      signal.throwIfAborted();
      const id = SessionMessage.ID.create();
      onInput?.(id);
      signal.throwIfAborted();
      phase = { type: "submitting", input: id };
      this.inputs.set(sessionId, id);
      const input = await this.client.session.prompt(
        {
          sessionID: sessionId,
          id,
          text: context
            ? `s=slack;c=${encodeURIComponent(context.source.channel)};t=${encodeURIComponent(context.source.thread)};m=${encodeURIComponent(context.source.message)};u=${encodeURIComponent(context.source.user)}\n\n${text}`
            : text,
          delivery: "queue",
          ...(files.length
            ? {
                files: files.map((file) => ({
                  name: file.name,
                  uri: `data:${file.mime};base64,${Buffer.from(file.data).toString("base64")}`,
                  source: { type: "inline" as const },
                })),
              }
            : {}),
        },
        { signal },
      );
      if (input.id !== id) throw new Error("OpenCode input identity changed");
      phase = { type: "submitted", input: id };
      await this.client.experimental.session.wait(
        { sessionID: sessionId },
        { signal },
      );
      phase = { type: "settled" };
      // Read backwards to the submitted input; do not resend earlier replies.
      const history: (InputBoundaryRecord & {
        reply?: { text: string; failed: boolean };
      })[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        // A continuation cursor carries the first page's order.
        const page = await this.client.message.list(
          cursor
            ? { sessionID: sessionId, limit: 100, cursor }
            : { sessionID: sessionId, order: "desc", limit: 100 },
          { signal },
        );
        for (const message of page.data) {
          history.push({
            ...boundaryRecord(message, sessionId),
            ...(message.type === "assistant"
              ? {
                  reply: {
                    failed: message.error !== undefined,
                    text: message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n"),
                  },
                }
              : {}),
          });
          if (message.id === input.id) {
            const fold = new InputBoundaryFold();
            let owner: string | undefined;
            const replies: { text: string; failed: boolean }[] = [];
            for (const record of history.reverse()) {
              owner = fold.next(record) ?? owner;
              if (record.reply && owner === input.id)
                replies.push(record.reply);
            }
            if (replies.some((reply) => reply.failed))
              throw new Error("OpenCode generation failed");
            return replies.map((reply) => reply.text).join("\n\n");
          }
        }
        cursor = page.cursor.next ?? undefined;
        if (cursor && cursors.has(cursor))
          throw new Error("OpenCode history cursor repeated");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      throw new Error("OpenCode input was not found in session history");
    } catch (error) {
      // Correlate a lost admission response without submitting again. A known
      // ID permits withdrawal, but only readable placement permits interruption.
      if (phase.type === "submitting" || phase.type === "submitted") {
        const input = phase.input;
        const cleanup = AbortSignal.timeout(5000);
        await this.interruptInput(sessionId, input, cleanup).catch(() => {});
      }
      throw error;
    } finally {
      phase = { type: "settled" };
      timer.abort();
      stop.abort();
      await events;
      await Promise.all(checks);
    }
  }

  /** Descending history places an assistant strictly after our delivered input.
   * Missing/unreadable placement suppresses previews; never infer from event time.
   */
  private async followsInput(
    sessionID: string,
    input: string,
    signal: AbortSignal,
    assistant?: string,
  ) {
    if (assistant !== undefined) {
      // Inbox list is unpaginated in this SDK. Presence proves we still queue;
      // absence proves nothing, so delivered candidates still need history.
      const inbox = await this.client.session.inbox.list(
        { sessionID },
        { signal },
      );
      if (inbox.some((item) => item.id === input)) return false;
    }
    let found = assistant === undefined;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const chain: InputBoundaryRecord[] = [];
    do {
      const page = await this.client.message.list(
        cursor
          ? { sessionID, limit: 100, cursor }
          : { sessionID, order: "desc", limit: 100 },
        { signal },
      );
      for (const message of page.data) {
        if (!found) {
          if (message.id === input) return false;
          if (message.id === assistant && message.type === "assistant")
            found = true;
          continue;
        }
        const record = boundaryRecord(message, sessionID);
        if (chain.length && closesBoundaryContext(record)) {
          chain.push(record);
          return resolveBoundaryContext(chain) === input;
        }
        if (record.input === undefined) continue;
        if (!chain.length && record.type !== "synthetic")
          return record.input === input;
        chain.push(record);
      }
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new Error("OpenCode history cursor repeated");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return resolveBoundaryContext(chain) === input;
  }

  async close() {
    // Attached OpenCode service belongs to its operator, not Pogo.
  }

  async interrupt(sessionId: string, signal: AbortSignal) {
    try {
      await this.client.session.interrupt({ sessionID: sessionId }, { signal });
    } catch (error) {
      // A deleted session has no work left to stop; startup recovery proceeds.
      // Typed SDK error only; never parse raw messages.
      if (!isSessionNotFoundError(error)) throw error;
    }
  }

  async interruptInput(
    sessionId: string,
    inputId: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    // Exact withdrawal cannot cancel another queued input. Placement can race
    // it, so only the latest raw input, not a settled transcript, permits stop.
    await this.client.session.inbox
      .cancel({ sessionID: sessionId, inboxID: inputId }, { signal })
      .catch(() => {});
    signal.throwIfAborted();
    if (await this.followsInput(sessionId, inputId, signal))
      await this.interrupt(sessionId, signal);
  }

  async startMaintenance(
    sessionID: string,
    requestID: string,
    signal: AbortSignal,
  ): Promise<MaintenanceWatch> {
    const rpc = this.client.rpc(MaintenanceRPC);
    const owner = { sessionID, id: requestID };
    const options = (signal: AbortSignal) => ({
      location: { directory: this.config.directory },
      signal,
    });
    if (!(await rpc.open(owner, options(signal))))
      throw new Error("Maintenance gateway registration failed");
    return {
      read: async (signal) =>
        maintenanceNoticeSchema
          .nullable()
          .parse(await rpc.read(owner, options(signal))),
      delivered: async (noticeID, signal) => {
        if (!(await rpc.delivered({ ...owner, noticeID }, options(signal))))
          throw new Error("Maintenance delivery unconfirmed");
      },
      close: async (signal) => {
        await rpc.close(owner, options(signal));
      },
    };
  }

  async transcript(
    sessionID: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<Transcript> {
    const after = cursor === latestInput ? this.inputs.get(sessionID) : cursor;
    if (cursor === latestInput && after === undefined)
      throw new TranscriptUnavailable("cursor");
    try {
      return await this.readTranscript(sessionID, after, signal);
    } catch (error) {
      // Typed SDK error only; never parse raw messages.
      if (isSessionNotFoundError(error))
        throw new TranscriptUnavailable("session");
      throw error;
    }
  }

  private async readTranscript(
    sessionID: string,
    after: string | undefined,
    signal: AbortSignal,
  ): Promise<Transcript> {
    // Quiet threads: one small page proves nothing follows the cursor.
    if (after) {
      const newest = await this.client.message.list(
        { sessionID, order: "desc", limit: 1 },
        { signal },
      );
      if (newest.data[0]?.id === after) return { cursor: after, entries: [] };
    }
    // Read idle state first: later text cannot belong to an earlier execution.
    const { time } = await this.client.session.get({ sessionID }, { signal });
    const idle =
      time.idle !== undefined && time.idle >= (time.busy ?? 0)
        ? time.idle
        : undefined;
    // An idle session has finished every earlier message, even without a mark.
    const settled = (message: SessionMessageInfo) =>
      message.type !== "assistant" ||
      message.time.completed !== undefined ||
      message.error !== undefined ||
      (idle !== undefined && message.time.created <= idle);
    // Keep compact records; long gaps must not retain tool payloads.
    const newer: (InputBoundaryRecord & {
      settled: boolean;
      entry?: TranscriptEntry;
    })[] = [];
    const context: InputBoundaryRecord[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let reached = false;
    let selected = false;
    let needContext = false;
    const startsWithCrew = () => {
      const oldest = newer.findLast(
        (message) =>
          message.input !== undefined || message.type === "assistant",
      );
      return oldest?.type === "synthetic" && oldest.input !== undefined;
    };
    // Every page up to the cursor; the caller's signal bounds the work.
    for (;;) {
      signal.throwIfAborted();
      const result = await this.client.message.list(
        cursor
          ? { sessionID, limit: 100, cursor }
          : { sessionID, order: "desc", limit: 20 },
        { signal },
      );
      for (const message of result.data) {
        const record = boundaryRecord(message, sessionID);
        if (selected) {
          if (record.input !== undefined || record.type === "assistant")
            context.push(record);
          if (closesBoundaryContext(record)) {
            needContext = false;
            break;
          }
          continue;
        }
        if (message.id === after) {
          reached = true;
          selected = true;
          context.push(record);
          needContext =
            record.type === "synthetic" ||
            (!closesBoundaryContext(record) && startsWithCrew());
          if (!needContext) break;
          continue;
        }
        const entry = publicEntry(message);
        newer.push({
          ...record,
          settled: settled(message),
          ...(entry ? { entry } : {}),
        });
      }
      if (after === undefined && !selected) {
        selected = true;
        needContext = startsWithCrew();
      }
      cursor = result.cursor.next ?? undefined;
      if ((selected && !needContext) || !cursor) break;
      if (cursors.has(cursor))
        throw new Error("OpenCode history cursor repeated");
      cursors.add(cursor);
    }
    // Keep the stored cursor; skipping unread history would lose replies.
    if (after && !reached) throw new TranscriptUnavailable("cursor");
    const chronological = newer.reverse();
    const open = chronological.findIndex((message) => !message.settled);
    const done = open < 0 ? chronological : chronological.slice(0, open);
    const head = done.at(-1)?.id;
    const fold = new InputBoundaryFold();
    let input: string | undefined;
    const reanchor =
      context[0]?.id === after && context[0]?.type === "synthetic";
    for (const message of context.reverse()) {
      const boundary = fold.next(message);
      // Ordinary synthetic cursors can also sit inside an undelivered crew batch.
      if (reanchor) input = boundary ?? input;
    }
    const entries: TranscriptEntry[] = [];
    for (const message of done) {
      input = fold.next(message) ?? input;
      if (message.entry)
        entries.push({
          ...message.entry,
          ...(input !== undefined ? { input } : {}),
        });
    }
    if (after !== undefined)
      return {
        cursor: head ?? after,
        entries,
        ...(input !== undefined ? { input } : {}),
        ...(open < 0 ? {} : { pending: true as const }),
      };
    // A baseline never delivers earlier history.
    if (head === undefined && cursor)
      throw new Error("OpenCode transcript baseline unavailable");
    return {
      cursor: head ?? "",
      entries: [],
      ...(input !== undefined ? { input } : {}),
    };
  }

  async watch(
    onSettled: (sessionId?: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let wait = 1000;
    while (!signal.aborted) {
      try {
        for await (const event of this.client.event.subscribe({
          types: settledEvents,
          signal,
        })) {
          if (event.type === "server.connected") {
            wait = 1000;
            onSettled();
          } else if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"
          )
            onSettled(event.data.sessionID);
        }
      } catch {
        // Reconnect below; SDK errors can contain request details.
      }
      await delay(wait, undefined, { signal }).catch(() => {});
      wait = Math.min(30_000, wait * 2);
    }
  }

  async startActivity(
    sessionID: string,
    requestID: string,
    reporter: string | undefined,
    signal: AbortSignal,
  ): Promise<ActivityWatch> {
    const rpc = this.client.rpc(CrewReporting);
    const options = (signal: AbortSignal) => ({
      location: { directory: this.config.directory },
      signal,
    });
    const capture = activitySnapshotSchema.parse(
      await rpc.start(
        { sessionID, requestID, ...(reporter ? { reporter } : {}) },
        options(signal),
      ),
    );
    return this.resumeActivity(sessionID, capture.id);
  }

  resumeActivity(sessionID: string, capture: string): ActivityWatch {
    const rpc = this.client.rpc(CrewReporting);
    const options = (signal: AbortSignal) => ({
      location: { directory: this.config.directory },
      signal,
    });
    const owner = { sessionID, id: capture };
    const snapshot = async (request: Promise<unknown>) => {
      const value = activitySnapshotSchema.parse(await request);
      if (value.id !== capture)
        throw new Error("Crew activity capture changed");
      return value;
    };
    return {
      id: capture,
      read: (signal, passive) =>
        snapshot(
          rpc.read(
            { ...owner, ...(passive ? { passive } : {}) },
            options(signal),
          ),
        ),
      finish: (signal) => snapshot(rpc.finish(owner, options(signal))),
      cancel: async (signal) => {
        await rpc.cancel(owner, options(signal));
      },
    };
  }
}
