import { setTimeout as delay } from "node:timers/promises";
import { Result, Schema } from "effect";
import type { AgentBackend } from "../../backends/backend";
import { type ReplyChunk, replyText } from "../../shared/slack-format";
import type { Job, Store } from "../../gateway/store";
import type { FleetControl, FleetControlOptions } from "./control";
import { fleetRequestAction } from "./permissions";
import {
  type FleetCompletion,
  FleetError,
  type FleetOrigin,
  type VerifiedSource,
  nativeMakerSchema,
  peerMessageInputSchema,
} from "./protocol";

/** Resolve by immutable ingress identity and native input, never latest chat. */
export function fleetOrigin(
  store: Store,
  sessionID: string,
  source: VerifiedSource,
): FleetOrigin | undefined {
  if (!source.origin) {
    return;
  }

  const job = store.jobByEvent(source.origin.botKey, source.origin.eventId);

  if (!job?.input) {
    return;
  }

  return { ...source.origin, sessionID, inputID: job.input };
}

const normalisePeerInput = Schema.decodeUnknownSync(peerMessageInputSchema, {
  onExcessProperty: "error",
});

/** Shown to the caller: names the cause and a workaround, never internals. */
export const fleetChatTurnRequired =
  "Fleet tools, including stargate_dm with via, work only in a turn that Stargate runs for an IRC or linked Teams conversation: a chat request to this captain, a fleet result to report, or a Teams follow-up timer. This turn is not one, for example because a crew DM, crew completion or notice woke it. Ask in your ship channel or tag the other captain on IRC instead.";

/** Bind fleet calls to an executing native input and matching tool payload. */
export function fleetAuthorizer(
  store: Pick<Store, "permissionCandidates">,
  backend: Pick<AgentBackend, "toolBelongsToInput">,
  pin: string,
  keys: readonly string[],
): FleetControlOptions["authorize"] {
  return async (caller, signal, request) => {
    const { action } = fleetRequestAction(request);
    const peerMessage = request.operation === "peer-message";

    const toolAliases: Partial<Record<typeof request.operation, string>> = {
      "peer-message": "stargate_dm",
      timer: "stargate_timer",
    };

    const expected = {
      agent: caller.agent,
      id: caller.id,
      tool: toolAliases[request.operation] ?? action,
      input: request.input,
      ...(peerMessage && { normaliseInput: normalisePeerInput }),
    };

    for (const key of keys) {
      for (const job of store.permissionCandidates(key)) {
        if (
          job.input &&
          (await backend.toolBelongsToInput?.(
            pin,
            caller.messageID,
            job.input,
            signal,
            expected,
          ))
        ) {
          return {
            botKey: job.botKey,
            eventId: job.eventId,
            sessionID: pin,
            inputID: job.input,
          };
        }
      }
    }

    throw new FleetError(fleetChatTurnRequired);
  };
}

/** Trusted gateway recovery only. No IPC operation can manufacture completion. */
export class FleetResults {
  private readonly nextDeferredRead = new Map<number, number>();
  public constructor(
    private readonly options: {
      control: FleetControl;
      store: Store;
      botKey: string;
      sessionID: string;
      account: string;
      backend: AgentBackend;
    },
  ) {}

  private async recoverMakers(job: Job, signal: AbortSignal) {
    const { backend, sessionID, store } = this.options;

    let makers: NonNullable<Job["makers"]> = [];

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

    store.fleet.saveMakers(job.id, makers);

    return makers;
  }

  public async poll(signal: AbortSignal) {
    const { control, store, botKey, sessionID, account } = this.options;

    if (!control.resultsEnabled) {
      return;
    }

    for (const job of store.fleet.pendingFleetJobs(botKey)) {
      signal.throwIfAborted();

      if (job.fleet?.kind !== "assignment") {
        continue;
      }

      if (job.input) {
        control.bindInput(
          job.botKey,
          job.eventId,
          job.fleet.dispatchID,
          job.input,
        );
      }

      if (job.status === "queued" || job.status === "running") {
        continue;
      }

      const delegation = control.delegation(job.fleet.dispatchID);

      if (!delegation) {
        throw new Error("Fleet completion delegation unavailable");
      }

      const deferred = job.failure ? null : store.fleet.deferredResult(job.id);
      const expired = deferred !== null && deferred.expires <= Date.now();

      const followUp =
        deferred && !expired && job.input
          ? await this.readDeferred(job, job.input, deferred.task, signal)
          : undefined;

      if (deferred && !expired && !followUp) {
        continue;
      }

      this.nextDeferredRead.delete(job.id);

      const makers =
        followUp?.makers ??
        job.makers ??
        (await this.recoverMakers(job, signal));

      const output = JSON.parse(job.response ?? "[]") as ReplyChunk[];

      const completion: FleetCompletion = {
        dispatchID: job.fleet.dispatchID,
        sourceReference: delegation.sourceReference,
        actor: account,
        sessionID,
        inputID: job.input ?? null,
        channel: delegation.target.channel,
        outcome:
          !expired && !job.failure && job.input && makers.length > 0
            ? "completed"
            : "uncertain",
        text: (
          followUp?.resultText ??
          (expired
            ? "The deferred result was not confirmed before its deadline."
            : output.map((item) => replyText(item)).join("\n\n"))
        ).slice(0, 12_000),
        makers,
        humanApproval: false,
      };

      control.complete(job.botKey, job.eventId, completion);
      store.fleet.fleetPublished(job.id);
    }

    for (const { origin, completion } of control.pendingResults()) {
      signal.throwIfAborted();

      if (origin.sessionID !== sessionID) {
        throw new Error("Fleet result owner pin changed");
      }

      const original = store.jobByEvent(origin.botKey, origin.eventId);

      if (!original || original.input !== origin.inputID) {
        continue;
      }

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
        ...(original.replyParent && { replyParent: original.replyParent }),
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
      ) {
        throw new Error("Fleet result continuation could not be retained");
      }

      // Queue before acknowledgement: restart deduplicates the retained input.
      control.acknowledgeResult(completion.dispatchID);
    }

    await control.pollReviews(signal);
  }

  private async readDeferred(
    job: Job,
    inputID: string,
    taskID: string,
    signal: AbortSignal,
  ) {
    const now = Date.now();

    if ((this.nextDeferredRead.get(job.id) ?? 0) > now) {
      return null;
    }

    this.nextDeferredRead.set(job.id, now + 5000);

    const { backend, sessionID } = this.options;

    try {
      return await backend.readCrewCompletion?.(
        sessionID,
        inputID,
        taskID,
        AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      );
    } catch {
      signal.throwIfAborted();

      return null;
    }
  }

  public async work(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.poll(signal);
      } catch (error) {
        if (signal.aborted) {
          return;
        }

        throw error;
      }

      await delay(200, undefined, { signal }).catch(() => {});
    }
  }
}
