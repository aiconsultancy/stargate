import { randomUUID } from "node:crypto";
import type { SessionCompactInput } from "@opencode/client";
import { CrewError } from "./state";

type CompactionEvent = {
  type:
    | "session.compaction.started"
    | "session.compaction.ended"
    | "session.compaction.failed";
  data: { sessionID: string; inputID?: string | undefined };
};
export interface CompactionEvents {
  subscribe(options?: {
    types?: readonly CompactionEvent["type"][];
    signal?: AbortSignal;
  }): AsyncIterable<CompactionEvent>;
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
) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const combined = AbortSignal.any([
    signal,
    controller.signal,
    AbortSignal.timeout(120_000),
  ]);
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
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
  })();
  try {
    await Promise.all([
      observed,
      sessions.compact(
        { sessionID, id, delivery: "steer" },
        { signal: combined },
      ),
    ]);
  } finally {
    controller.abort();
    await observed.catch(() => {});
  }
}
