import { setTimeout as delay } from "node:timers/promises";
import {
  isSessionNotFoundError,
  OpenCode,
  type SessionMessageInfo,
} from "@opencode/client";
import { z } from "zod";
import { type ActivityWatch, activitySnapshotSchema } from "../activity";
import {
  type AgentBackend,
  latestInput,
  type TextSink,
  type Transcript,
  type TranscriptEntry,
  TranscriptUnavailable,
} from "../backend";
import { type BackendConfig, secret } from "../config";
import { CrewReporting } from "../crew/report-rpc";
import { type CrewStatusInput, crewStatusSchema } from "../crew-status";

type Config = Extract<BackendConfig, { type: "opencode" }>;
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

  async prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
  ) {
    this.inputs.delete(sessionId);
    const stop = new AbortController();
    const timer = new AbortController();
    const connected = Promise.withResolvers<void>();
    let armed = false;
    const messages = new Map<string, Map<number, string>>();
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
            if (!armed || event.data.sessionID !== sessionId) continue;
            const { assistantMessageID, ordinal } = event.data;
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
            onText(
              [...messages.values()]
                .map((parts) =>
                  [...parts]
                    .sort(([a], [b]) => a - b)
                    .map(([, text]) => text)
                    .join("\n"),
                )
                .join("\n\n"),
            );
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
      armed = true;
      const input = await this.client.session.prompt(
        { sessionID: sessionId, text, delivery: "queue" },
        { signal },
      );
      this.inputs.set(sessionId, input.id);
      await this.client.experimental.session.wait(
        { sessionID: sessionId },
        { signal },
      );
      // Read backwards to the submitted input; do not resend earlier replies.
      const replies: string[] = [];
      let cursor: string | undefined;
      do {
        // A continuation cursor carries the first page's order.
        const page = await this.client.message.list(
          cursor
            ? { sessionID: sessionId, limit: 100, cursor }
            : { sessionID: sessionId, order: "desc", limit: 100 },
          { signal },
        );
        for (const message of page.data) {
          if (message.id === input.id) return replies.reverse().join("\n\n");
          if (message.type !== "assistant") continue;
          if (message.error) throw new Error("OpenCode generation failed");
          replies.push(
            message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          );
        }
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      throw new Error("OpenCode input was not found in session history");
    } catch (error) {
      // Aborting HTTP does not stop server-side tools. Interrupt explicitly.
      await this.client.session
        .interrupt(
          { sessionID: sessionId },
          { signal: AbortSignal.timeout(5000) },
        )
        .catch(() => {});
      throw error;
    } finally {
      timer.abort();
      stop.abort();
      await events;
    }
  }

  async close() {
    // Attached OpenCode service belongs to its operator, not Pogo.
  }

  async interrupt(sessionId: string, signal: AbortSignal) {
    await this.client.session.interrupt({ sessionID: sessionId }, { signal });
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
    const newer: { id: string; settled: boolean; entry?: TranscriptEntry }[] =
      [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let reached = false;
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
        if (message.id === after) {
          reached = true;
          break;
        }
        const entry = publicEntry(message);
        newer.push({
          id: message.id,
          settled: settled(message),
          ...(entry ? { entry } : {}),
        });
      }
      cursor = result.cursor.next ?? undefined;
      if (reached || !cursor || after === undefined) break;
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
    if (after !== undefined)
      return {
        cursor: head ?? after,
        entries: done.flatMap((message) =>
          message.entry ? [message.entry] : [],
        ),
        ...(open < 0 ? {} : { pending: true as const }),
      };
    // A baseline never delivers earlier history.
    if (head === undefined && cursor)
      throw new Error("OpenCode transcript baseline unavailable");
    return { cursor: head ?? "", entries: [] };
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
    reporter: string,
    signal: AbortSignal,
  ): Promise<ActivityWatch> {
    const rpc = this.client.rpc(CrewReporting);
    const options = (signal: AbortSignal) => ({
      location: { directory: this.config.directory },
      signal,
    });
    const capture = activitySnapshotSchema.parse(
      await rpc.start({ sessionID, requestID, reporter }, options(signal)),
    );
    const owner = { sessionID, id: capture.id };
    const snapshot = async (request: Promise<unknown>) => {
      const value = activitySnapshotSchema.parse(await request);
      if (value.id !== capture.id)
        throw new Error("Crew activity capture changed");
      return value;
    };
    return {
      read: (signal) => snapshot(rpc.read(owner, options(signal))),
      finish: (signal) => snapshot(rpc.finish(owner, options(signal))),
      cancel: async (signal) => {
        await rpc.cancel(owner, options(signal));
      },
    };
  }
}
