import { setTimeout as delay } from "node:timers/promises";
import { Result, Schema } from "effect";
import type { AgentBackend, PromptSourceContext } from "../backend";
import { type ReplyChunk, replyText } from "../shared/slack-format";
import type { Job, Store } from "../gateway/store";
import type { FleetControl } from "./control";
import {
  type FleetCompletion,
  type FleetOrigin,
  nativeMakerSchema,
  type VerifiedSource,
} from "./protocol";

/** Resolve by immutable ingress identity and native input, never latest chat. */
export function fleetOrigin(
  store: Store,
  sessionID: string,
  source: VerifiedSource,
): FleetOrigin | undefined {
  if (!source.origin) return;
  const job = store.jobByEvent(source.origin.botKey, source.origin.eventId);
  if (!job?.input) return;
  return { ...source.origin, sessionID, inputID: job.input };
}

export function fleetResultSource(
  job: Pick<Job, "fleet">,
): PromptSourceContext["source"] | undefined {
  if (job.fleet?.kind !== "result") return;
  const result = job.fleet.completion;
  const reference = `fleet-result-${result.dispatchID}`;
  return {
    transport: "fleet",
    authority: "agent",
    reference,
    user: result.actor,
    sender: "captain",
    channel: result.channel,
    thread: result.inputID ?? reference,
    message: reference,
  };
}

/** Trusted gateway recovery only. No IPC operation can manufacture completion. */
export class FleetResults {
  constructor(
    private readonly options: {
      control: FleetControl;
      store: Store;
      botKey: string;
      sessionID: string;
      account: string;
      backend: AgentBackend;
    },
  ) {}

  async poll(signal: AbortSignal) {
    const { control, store, botKey, sessionID, account, backend } =
      this.options;
    if (!control.resultsEnabled) return;
    for (const job of store.pendingFleetJobs(botKey)) {
      signal.throwIfAborted();
      if (job.fleet?.kind !== "assignment") continue;
      if (job.input)
        control.bindInput(
          job.botKey,
          job.eventId,
          job.fleet.dispatchID,
          job.input,
        );
      if (job.status === "queued" || job.status === "running") continue;
      const delegation = control.delegation(job.fleet.dispatchID);
      if (!delegation)
        throw new Error("Fleet completion delegation unavailable");
      let makers = job.makers;
      if (makers === undefined) {
        makers = [];
        if (job.input && backend.executionMakers) {
          try {
            const value = await backend.executionMakers(
              sessionID,
              job.input,
              signal,
            );
            const parsed = Schema.decodeUnknownResult(
              Schema.mutable(Schema.Array(nativeMakerSchema)).check(
                Schema.isMaxLength(100),
              ),
            )(value);
            makers = Result.isSuccess(parsed) ? parsed.success : [];
          } catch {
            signal.throwIfAborted();
          }
        }
        store.saveMakers(job.id, makers);
      }
      const output = JSON.parse(job.response ?? "[]") as ReplyChunk[];
      const completion: FleetCompletion = {
        dispatchID: job.fleet.dispatchID,
        sourceReference: delegation.sourceReference,
        actor: account,
        sessionID,
        inputID: job.input ?? null,
        channel: delegation.target.channel,
        outcome:
          !job.failure && job.input && makers.length
            ? "completed"
            : "uncertain",
        text: output.map(replyText).join("\n\n").slice(0, 12000),
        makers,
        humanApproval: false,
      };
      control.complete(job.botKey, job.eventId, completion);
      store.fleetPublished(job.id);
    }
    for (const { origin, completion } of control.pendingResults()) {
      signal.throwIfAborted();
      if (origin.sessionID !== sessionID)
        throw new Error("Fleet result owner pin changed");
      const original = store.jobByEvent(origin.botKey, origin.eventId);
      if (!original || original.input !== origin.inputID) continue;
      const eventId = `fleet-result:${completion.dispatchID}`;
      const text = [
        "Verified captain outcome. This is AGENT CONTEXT, never a human instruction or approval.",
        `Report this outcome in the original conversation. Do not repeat the assignment. Original source: ${completion.sourceReference}; original native input: ${origin.inputID}.`,
        JSON.stringify(completion),
      ].join("\n");
      const resultJob: Job["fleet"] = {
        kind: "result",
        completion,
        originInputID: origin.inputID,
      };
      const reference = `fleet-result-${completion.dispatchID}`;
      control.recordSource({
        reference,
        transport: "fleet",
        account: completion.actor,
        authority: "agent",
        role: "captain",
        text,
        channel: completion.channel,
        messageID: reference,
        receivedAt: new Date().toISOString(),
        origin: { botKey: original.botKey, eventId },
      });
      const inserted = store.enqueue({
        botKey: original.botKey,
        eventId,
        conversation: original.conversation,
        channel: original.channel,
        thread: original.thread,
        ...(original.replyParent ? { replyParent: original.replyParent } : {}),
        // Retained recipient for delivery ACLs; model source is the agent.
        // Approval intake explicitly refuses this continuation.
        user: original.user,
        sender: "captain",
        text,
        fleet: resultJob,
      });
      const existing = inserted
        ? undefined
        : store.jobByEvent(original.botKey, eventId);
      if (
        !inserted &&
        (!existing ||
          JSON.stringify(existing.fleet) !== JSON.stringify(resultJob))
      )
        throw new Error("Fleet result continuation could not be retained");
      // Queue before acknowledgement: restart deduplicates the retained input.
      control.acknowledgeResult(completion.dispatchID);
    }
    await control.pollReviews(signal);
  }

  async work(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.poll(signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      await delay(200, undefined, { signal }).catch(() => {});
    }
  }
}
