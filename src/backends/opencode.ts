import { setTimeout as delay } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { type ActivityWatch, activitySnapshotSchema } from "../activity";
import type { AgentBackend, TextSink } from "../backend";
import { type BackendConfig, secret } from "../config";
import { CrewReporting } from "../crew/report-rpc";
import { type CrewStatusInput, crewStatusSchema } from "../crew-status";

type Config = Extract<BackendConfig, { type: "opencode" }>;
const pairingCode = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
  expires_in: z.number().int().positive().max(86_400),
});

export class OpenCodeBackend implements AgentBackend {
  private readonly client;
  private readonly pairingClient;
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
      await this.client.experimental.session.wait(
        { sessionID: sessionId },
        { signal },
      );
      // Read backwards to the submitted input; do not resend earlier replies.
      const replies: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.client.message.list(
          { sessionID: sessionId, order: "desc", limit: 100, cursor },
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
