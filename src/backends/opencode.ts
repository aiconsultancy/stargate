import { OpenCode } from "@opencode/client";
import type { AgentBackend } from "../backend";
import { type BackendConfig, secret } from "../config";

type Config = Extract<BackendConfig, { type: "opencode" }>;

export class OpenCodeBackend implements AgentBackend {
  private readonly client;
  constructor(private readonly config: Config) {
    this.client = OpenCode.make({
      baseUrl: config.url,
      headers: Object.fromEntries(
        Object.entries(config.headersEnv).map(([header, env]) => [
          header,
          secret(env),
        ]),
      ),
    });
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

  async prompt(sessionId: string, text: string, signal: AbortSignal) {
    try {
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
    }
  }

  async close() {
    // Attached OpenCode service belongs to its operator, not Pogo.
  }

  async interrupt(sessionId: string, signal: AbortSignal) {
    await this.client.session.interrupt({ sessionID: sessionId }, { signal });
  }
}
