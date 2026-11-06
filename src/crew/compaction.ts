import { randomUUID } from "node:crypto";
import type { SessionCompactInput } from "@opencode/client";
import { connectHistoryAPI } from "./api";
import type { CrewSessions } from "./engine";
import { CrewError } from "./state";
import type { Team } from "./team";

type CompactionType =
  | "session.compaction.started"
  | "session.compaction.ended"
  | "session.compaction.failed";
type CompactionEvent =
  | {
      type: CompactionType;
      data: { sessionID: string; inputID?: string | undefined };
    }
  | { type: "server.connected"; data: unknown };
export interface CompactionEvents {
  subscribe(options?: {
    types?: readonly CompactionType[];
    signal?: AbortSignal;
  }): AsyncIterable<CompactionEvent>;
}

/** Native plugin events are location-scoped; workers live elsewhere. */
export async function compactOnServer(
  team: Team,
  sessions: Pick<CrewSessions, "get">,
  sessionID: string,
  signal: AbortSignal,
) {
  const target = await sessions.get({ sessionID }, { signal });
  const client = await connectHistoryAPI(team, target, signal);
  await compactAndWait(client.session, client.event, sessionID, signal, true);
}

/** Admission alone does not prove that a usable summary was written. */
export async function compactAndWait(
  sessions: {
    compact(
      input: SessionCompactInput,
      request?: { signal: AbortSignal },
    ): Promise<unknown>;
  },
  events: CompactionEvents,
  sessionID: string,
  signal: AbortSignal,
  waitForConnection = false,
) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const combined = AbortSignal.any([
    signal,
    controller.signal,
    AbortSignal.timeout(120_000),
  ]);
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const connected = Promise.withResolvers<void>();
  if (!waitForConnection) connected.resolve();
  const observed = (async () => {
    let started = false;
    for await (const event of events.subscribe({
      types: [
        "session.compaction.started",
        "session.compaction.ended",
        "session.compaction.failed",
      ],
      signal: combined,
    })) {
      if (event.type === "server.connected") {
        connected.resolve();
        continue;
      }
      if (event.data.sessionID !== sessionID) continue;
      if (event.type === "session.compaction.started") {
        started = event.data.inputID === id;
      } else if (
        event.type === "session.compaction.failed" &&
        (started || event.data.inputID === id)
      ) {
        throw new CrewError("Compaction was not confirmed; model unchanged.");
      } else if (event.type === "session.compaction.ended" && started) return;
    }
    throw new CrewError("Compaction was not confirmed; model unchanged.");
  })().catch((error) => {
    connected.reject(error);
    throw error;
  });
  try {
    await Promise.all([
      observed,
      (async () => {
        await connected.promise;
        combined.throwIfAborted();
        await sessions.compact(
          { sessionID, id, delivery: "steer" },
          { signal: combined },
        );
      })(),
    ]);
  } finally {
    controller.abort();
    await observed.catch(() => {});
  }
}
