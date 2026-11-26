import type { TurnActivityLog } from "../backend";
import type {
  ActivityCallEvidence,
  ActivityIncarnation,
  CallTiming,
} from "./activity-call-evidence";
import { childAttributionMarker } from "./activity-projector";
import type {
  ActivityRecoveryQueues,
  NamingProof,
  PendingActivity,
} from "./activity-recovery-queue";
import { markActivityGap } from "./activity-replay-gap";

type History = {
  needsFreshness(id: string, created: number | undefined): boolean;
  mayHaveCompacted(id: string): boolean;
};

type Creation = { created?: number; creationTime?: number | undefined };

type AttributedChild = {
  parent: TurnActivityLog;
  log: TurnActivityLog;
  start: number;
  nativeStart?: number | undefined;
  callId: string | null;
  ambiguousCall?: true;
  callFloor: number;
};

type Attribution = {
  owner: TurnActivityLog | undefined;
  detached: boolean;
  callId: string | null;
};

export function detachedAttribution(owner: TurnActivityLog) {
  return {
    owner,
    detached: true,
    callId: null,
    ambiguous: false,
    proof: undefined,
  };
}

export function resolveAttribution(
  calls: ActivityCallEvidence,
  { id, parent }: { id: string; parent: string },
  inferred: TurnActivityLog | undefined,
  naming: ReturnType<ActivityRecoveryQueues<never>["naming"]>,
  window: { after: number; through: number },
  lineage: WeakMap<TurnActivityLog, ActivityIncarnation>,
) {
  const proof = naming.first ?? naming.witness;

  const competing =
    proof !== undefined &&
    calls.competing(parent, lineage.get(proof.log), id, {
      ...window,
      except: proof.order,
    });

  const ambiguous = naming.ambiguous || competing;

  return {
    owner: proof?.log ?? inferred,
    ambiguous,
    detached: naming.detached || competing,
    callId: ambiguous ? null : (naming.first?.callId ?? null),
    proof,
  };
}

export function markDiscardedContinuation<
  Event extends { type: string; data: { sessionID: string } },
>(
  log: TurnActivityLog | undefined,
  pending: PendingActivity<Event>,
  isActivity: (event: Event) => boolean,
  headOnly = false,
) {
  if (!log || log.retained?.() === false) {
    return;
  }

  const discarded = pending.segments.find(
    ({ gap, frames }, index) =>
      (headOnly ? index === 0 : !pending.draining || index > 0) &&
      (gap !== undefined || frames.some(({ event }) => isActivity(event))),
  );

  if (discarded) {
    markActivityGap(log, discarded.first.at);
  }
}

export const childSessionID = (value: unknown): value is string =>
  typeof value === "string" && /^ses[A-Za-z0-9_-]{1,253}$/.test(value);

export function recordChildName(
  calls: ActivityCallEvidence,
  session: string,
  scope: ActivityIncarnation | undefined,
  log: TurnActivityLog,
  {
    assistantMessageID,
    id: callId,
  }: { assistantMessageID: string; id: string },
  id: string,
): NamingProof | undefined {
  const key = `${assistantMessageID}:${callId}`;
  const timing = calls.timing(scope, log, key);
  const order = calls.name(session, scope, log, key, id);

  if (order === null || !timing) {
    return;
  }

  return {
    session,
    log,
    callId,
    order,
    timing,
    markAttribution: childAttributionMarker(log, assistantMessageID, callId),
    ...(scope && { scope }),
  };
}

export function linkExistingChild(
  calls: ActivityCallEvidence,
  scope: ActivityIncarnation | undefined,
  id: string,
  child: AttributedChild,
  startOrder: number | undefined,
  { session, log, order, callId, timing }: NamingProof,
) {
  if (
    child.parent === log &&
    child.callFloor < order &&
    (timing.created === undefined ||
      child.nativeStart === undefined ||
      timing.created <= child.nativeStart) &&
    child.callId === null &&
    !child.ambiguousCall
  ) {
    if (
      calls.competing(session, scope, id, {
        except: order,
        after: child.callFloor,
        through: child.start,
      })
    ) {
      child.ambiguousCall = true;
    } else {
      child.callId = callId;
      child.log.link?.(callId);
    }
  }

  if (
    (child.callId !== null || child.ambiguousCall) &&
    child.start === startOrder
  ) {
    calls.retire(session, scope, id, child.start);
  }
}

export function openChild(
  { owner, detached, callId }: Attribution,
  id: string,
  at: number,
  unproven: boolean,
  fenced: (owner: TurnActivityLog) => boolean,
) {
  return owner && !fenced(owner)
    ? owner.child?.(
        unproven ? null : callId,
        id,
        at,
        unproven || detached || undefined,
      )
    : undefined;
}

export function freshChild(
  history: History,
  id: string,
  first: {
    type: string;
    seq: number | undefined;
    created: number | undefined;
    late?: true;
  },
  pending: Creation,
  timing: CallTiming | undefined,
) {
  const needsProof = history.needsFreshness(id, pending.creationTime);

  if (first.type !== "session.execution.started") {
    return !needsProof;
  }

  // Only durable frames must carry a native time; transient live frames need not.
  if (first.seq !== undefined && first.created === undefined) {
    return false;
  }

  const callTime = timing?.created;

  if (callTime !== undefined && first.created !== undefined) {
    return first.created >= callTime;
  }

  return !needsProof && !first.late && timing?.launch !== "resumes";
}

export function compactedHistory(
  history: History,
  id: string,
  pending: Creation,
  timing: CallTiming | undefined,
) {
  return history.mayHaveCompacted(id) &&
    timing?.launch !== "new" &&
    (pending.created === undefined ||
      timing?.launch === "resumes" ||
      history.needsFreshness(id, pending.creationTime))
    ? { uncertainHistory: true as const }
    : {};
}
