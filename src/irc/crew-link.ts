import { OpenCode } from "@opencode/client";
import { Schema } from "effect";
import { type BackendConfig, secret } from "../config";
import {
  CrewIrc,
  type OutboxPage,
  outboxPageSchema,
} from "../crew/messaging/irc-rpc";

/**
 * Stargate's IRC ship → its team's crew plugin, through the OpenCode server at
 * the captain location (the plugin accepts these RPCs nowhere else).
 * Errors are generic: they never carry URLs, headers or plugin details.
 */
export interface CrewLink {
  /** Bind a crew IRC session to its member, for stargate_dm and stargate_mail. */
  bind(sessionID: string, crewID: string, signal: AbortSignal): Promise<void>;
  /** Stored stargate_dm sends after `after`; without it, only the latest. */
  outbox(
    input: { after?: number; limit: number },
    signal: AbortSignal,
  ): Promise<OutboxPage>;
}

type OpenCodeBackend = Extract<BackendConfig, { type: "opencode" }>;

/** A link through the captain's OpenCode backend; none for other backends. */
export function crewLink(
  captain: BackendConfig,
  env: NodeJS.ProcessEnv,
): CrewLink | undefined {
  if (captain.type !== "opencode") return;

  return new OpenCodeCrewLink(captain, env);
}

class OpenCodeCrewLink implements CrewLink {
  private readonly client;
  constructor(
    private readonly captain: OpenCodeBackend,
    env: NodeJS.ProcessEnv,
  ) {
    this.client = OpenCode.make({
      baseUrl: captain.url,
      headers: Object.fromEntries(
        Object.entries(captain.headersEnv).map(([header, name]) => [
          header,
          secret(name, env),
        ]),
      ),
    });
  }

  async bind(sessionID: string, crewID: string, signal: AbortSignal) {
    try {
      await this.client
        .rpc(CrewIrc)
        .bind(
          { sessionID, crewID },
          { location: { directory: this.captain.directory }, signal },
        );
    } catch {
      signal.throwIfAborted();
      throw new Error("Crew IRC session binding failed");
    }
  }

  async outbox(input: { after?: number; limit: number }, signal: AbortSignal) {
    try {
      return Schema.decodeUnknownSync(outboxPageSchema)(
        await this.client.rpc(CrewIrc).outbox(input, {
          location: { directory: this.captain.directory },
          signal,
        }),
      );
    } catch {
      signal.throwIfAborted();
      throw new Error("Crew stargate_dm outbox unavailable");
    }
  }
}
