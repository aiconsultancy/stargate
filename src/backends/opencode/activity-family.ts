import type { OpenCodeClient, SessionLogItem } from "@opencode/client";
import type { ActivityOutcome, TurnActivityLog } from "../backend";
import {
  childSessionID,
  compactedHistory,
  detachedAttribution,
  freshChild,
  linkExistingChild,
  markDiscardedContinuation,
  openChild,
  recordChildName,
} from "./activity-attribution";
import {
  ActivityCallEvidence,
  type ActivityIncarnation,
} from "./activity-call-evidence";
import {
  ChildExecutions,
  type ChildReplayState,
} from "./activity-child-executions";
import {
  type ActivityEvent,
  ActivityProjector,
  activityEvents,
} from "./activity-projector";
import {
  ActivityRecoveryQueues,
  type PendingActivity,
  type QueuedPacket,
  activityQueueDefaults as defaults,
} from "./activity-recovery-queue";
import {
  type Boundary,
  type NativeActivityObservation,
  activityOutcome,
  beforeActivityBoundary,
  markActivityGap,
  activityMaxReads as maxReads,
  nativeActivityTime,
  activityReadMs as readMs,
  reconcileActivity,
} from "./activity-replay-gap";
import { boundarySeq } from "./crew-executions";

export { activityOutcome, nativeActivityReads } from "./activity-replay-gap";

export type { ActivityIncarnation } from "./activity-call-evidence";

export const activityFamilyEvents = [
  ...activityEvents,
  "session.created",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

export const subscribeActivityFamily = (
  events: OpenCodeClient["event"],
  signal: AbortSignal,
) => events.subscribe({ types: activityFamilyEvents, signal });

type Frame =
  ReturnType<typeof subscribeActivityFamily> extends AsyncIterable<infer F>
    ? F
    : never;

export type ActivityFamilyEvent = Exclude<Frame, { type: "server.connected" }>;

export type ActivityPacket = {
  event: ActivityEvent;
  at: number;
  order: number;
};

type Packet = QueuedPacket<ActivityFamilyEvent>;

type Pending = PendingActivity<ActivityFamilyEvent>;

type Child = ChildReplayState & {
  parent: TurnActivityLog;
  parentSession: string;
  log: TurnActivityLog;
  projector: ActivityProjector;
  start: number;
  nativeStart?: number | undefined;
  latest: number;
  lower?: number;
  reused?: true;
  uncertainHistory?: true;
  unproven?: true;
  continuation?: true;
  callId: string | null;
  ambiguousCall?: true;
  callFloor: number;
};

type Ancestry = {
  parent?: string;
  lookup?: number;
  created?: number;
  creationTime?: number | undefined;
  deferredInference?: number;
  inferred?: TurnActivityLog;
  continuation?: Child;
};

type Root = { uniqueSince: number; observed?: number };

export type ActivityFamilyReads = NativeActivityObservation & {
  parent(sessionID: string, signal: AbortSignal): Promise<string | undefined>;
};

type Source = ActivityFamilyReads & { signal: AbortSignal };

type ObservedRoot = {
  id: string;
  startSeq?: number;
  dropped: boolean;
  open: ReadonlySet<{ log: TurnActivityLog }>;
};

const itemEvents = new Set<string>(activityEvents);
const familyEvents = new Set<string>(activityFamilyEvents);

const isFamilyLogItem = (
  event: SessionLogItem,
): event is Extract<SessionLogItem, ActivityFamilyEvent> =>
  familyEvents.has(event.type);

export const isActivityEvent = (
  event: ActivityFamilyEvent,
): event is ActivityEvent => itemEvents.has(event.type);

/** Correlates native ancestry with collector-owned turns, never wall-clock proximity. */
export class OpenCodeActivityFamilies {
  private readonly roots = new Map<string, Map<TurnActivityLog, Root>>();
  private readonly peers = new Set<string>();
  private readonly rootProof = new WeakMap<TurnActivityLog, Root>();
  private readonly lineage = new WeakMap<
    TurnActivityLog,
    ActivityIncarnation
  >();
  private readonly children = new Map<string, Child>();
  private readonly executions: ChildExecutions<Child>;
  private readonly queue: ActivityRecoveryQueues<ActivityFamilyEvent>;
  private readonly ancestry = new WeakMap<Pending, Ancestry>();
  private readonly calls: ActivityCallEvidence;
  private readonly reads = new Map<string, Pending>();
  private order = 0;
  private reconciliation = 0;
  private proofFloor = 0;

  public constructor(
    private readonly source: Source,
    limits: Partial<typeof defaults> = {},
    private readonly now: () => number = Date.now,
  ) {
    const bounds = { ...defaults, ...limits };
    this.executions = new ChildExecutions(bounds.pending * 4);
    this.calls = new ActivityCallEvidence(bounds.pending);
    this.queue = new ActivityRecoveryQueues(
      bounds,
      now,
      maxReads,
      (id) => this.executions.needsStart(id),
      (id) => {
        this.admit(id);
      },
      {
        start: (id, through) => {
          const latest = this.executions.get(id)?.latest;

          // A retained execution may still accept a late name for its start.
          if (latest?.callId !== null || latest.ambiguousCall) {
            this.calls.discardStart(id, through);
          }
        },
        candidate: (id, queued, headOnly) => {
          markDiscardedContinuation(
            this.facts(queued).continuation?.log,
            queued,
            isActivityEvent,
            headOnly,
          );
          const child = this.children.get(id);

          if (!headOnly && child?.unproven && !child.continuation) {
            this.finish(id, child, "cancelled", true);
          }
        },
      },
    );
    source.signal.addEventListener(
      "abort",
      () => {
        this.close();
      },
      { once: true },
    );
  }

  public track(
    session: string,
    log: TurnActivityLog,
    scope?: ActivityIncarnation,
    running = true,
  ) {
    const root = { uniqueSince: ++this.order };
    this.rootProof.set(log, root);

    if (running) {
      const roots = this.roots.get(session) ?? new Map<TurnActivityLog, Root>();
      roots.set(log, root);
      this.roots.set(session, roots);
    }

    if (scope) {
      this.lineage.set(log, scope);
    }
  }

  public peer(session: string) {
    const child = this.children.get(session);

    if (child) {
      this.finish(session, child, "cancelled", true);
    }

    this.peers.add(session);
    this.queue.discard(session);
  }

  /** Revisit native creation once all earlier root messages are placed. */
  public placed(
    session: string,
    execution: number,
    turns: readonly TurnActivityLog[],
  ) {
    const root = turns.length === 1 ? turns[0] : undefined;

    for (const [id, queued] of this.queue.entries()) {
      const pending = this.facts(queued);

      if (
        pending.parent !== session ||
        pending.deferredInference !== execution
      ) {
        continue;
      }

      delete pending.deferredInference;

      if (root) {
        pending.inferred ??= root;
        this.queue.schedule(id);
      }
    }
  }

  /** A peer incarnation ended; neither retained handles nor in-flight reads can adopt descendants. */
  public fence(session: string, scope: ActivityIncarnation) {
    scope.active = false;
    this.calls.fence(scope);
    this.queue.fence(scope);
    this.roots.delete(session);
    this.peers.delete(session);

    const waiting = this.queue
      .entries()
      .map(([id]) => id)
      .filter((id) => this.waitsFor(id, session, scope))
      .toArray();

    for (const id of waiting) {
      this.queue.discard(id);
    }

    for (const [id, child] of this.children) {
      if (this.lineage.get(child.log) === scope) {
        this.finish(id, child, "cancelled", true);
      }
    }
  }

  private waitsFor(id: string, session: string, scope: ActivityIncarnation) {
    const visited = new Set<string>();
    let ancestorID = id;

    while (!visited.has(ancestorID)) {
      visited.add(ancestorID);
      const queued = this.queue.peek(ancestorID);

      if (!queued) {
        const ancestor = this.children.get(ancestorID);

        return (
          ancestor !== undefined && this.lineage.get(ancestor.log) === scope
        );
      }

      const pending = this.facts(queued);

      if (
        pending.parent === session ||
        this.queue.hasProofFrom(queued, session) ||
        (pending.inferred && this.lineage.get(pending.inferred) === scope)
      ) {
        return true;
      }

      if (!pending.parent) {
        return false;
      }

      ancestorID = pending.parent;
    }

    return false;
  }

  private fenced(log: TurnActivityLog) {
    return this.lineage.get(log)?.active === false;
  }

  public settled(session: string, log: TurnActivityLog) {
    const roots = this.roots.get(session);

    if (!roots?.delete(log)) {
      return;
    }

    if (roots.size === 0) {
      this.roots.delete(session);
    } else if (roots.size === 1) {
      const remaining = roots.values().next().value;

      if (remaining) {
        remaining.uniqueSince = ++this.order;
      }
    }
  }

  /** Called by the root collector only after assistant placement is proven. */
  public owned(log: TurnActivityLog, event: ActivityEvent, order: number) {
    if (
      this.source.signal.aborted ||
      order <= this.proofFloor ||
      this.fenced(log)
    ) {
      return;
    }

    this.observeRoot(log, order);
    const { sessionID: session, assistantMessageID } = event.data;
    const scope = this.lineage.get(log);

    if (event.type === "session.tool.input.started") {
      this.calls.open(
        session,
        scope,
        log,
        `${assistantMessageID}:${event.data.id}`,
        order,
        {
          created: nativeActivityTime(event),
          subagent: event.data.name === "subagent",
        },
      );

      return;
    }

    if (event.type === "session.tool.called") {
      const { input } = event.data;
      this.calls.input(
        session,
        scope,
        log,
        `${assistantMessageID}:${event.data.id}`,
        {
          order,
          created: nativeActivityTime(event),
          input,
          mayLaunch:
            event.data.native?.["name"] === "subagent" ||
            typeof input["agent"] === "string",
        },
      );

      return;
    }

    if (
      event.type !== "session.tool.progress" &&
      event.type !== "session.tool.success" &&
      event.type !== "session.tool.failed"
    ) {
      return;
    }

    const id = event.data.metadata?.["sessionID"];

    if (!childSessionID(id) || id === session) {
      return;
    }

    const proof = recordChildName(
      this.calls,
      session,
      scope,
      log,
      event.data,
      id,
    );

    if (!proof) {
      return;
    }

    this.queue.expire();
    const child = this.executions.get(id)?.latest;

    // A call opened after this start can name the next execution while this child is still live.
    if (child && proof.order <= child.start) {
      linkExistingChild(
        this.calls,
        scope,
        id,
        child,
        this.executions.startOrder(id),
        proof,
      );

      return;
    }

    const queued = this.queue.candidate(id, this.executions.startOrder(id));
    const pending = this.facts(queued);

    if (pending.parent !== undefined && pending.parent !== session) {
      return;
    }

    this.queue.offerProof(queued, proof);
    this.queue.schedule(id);

    if (pending.parent === undefined && this.reads.get(id) !== queued) {
      pending.lookup = order;
      this.readParents();
    }
  }

  private attribution(
    id: string,
    queued: Pending,
    ancestry: Ancestry,
    parent: string,
  ) {
    const segment = queued.segments[0];

    if (!segment) {
      return;
    }

    const { first } = segment;

    const inferred =
      !this.executions.get(id)?.admitted && !queued.advanced
        ? this.inferredOwner(ancestry, first.order)
        : undefined;

    const naming = this.queue.naming(
      queued,
      ({ session, log }) => session === parent && !this.fenced(log),
      inferred && this.lineage.get(inferred),
    );

    const proof = naming.first ?? naming.witness;

    const competing =
      proof !== undefined &&
      this.calls.competing(parent, this.lineage.get(proof.log), id, {
        except: proof.order,
        after: segment.floor,
        through: first.order,
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

  private observeRoot(log: TurnActivityLog, order: number) {
    const root = this.rootProof.get(log);

    if (root && (root.observed === undefined || root.observed > order)) {
      root.observed = order;

      for (const [id, queued] of this.queue.entries()) {
        if (this.facts(queued).inferred === log) {
          this.queue.schedule(id);
        }
      }
    }
  }

  private ignoreChildFrame(id: string, seq: number | undefined) {
    // Possible replay must not reserve a segment or bind a name.
    return this.peers.has(id) || this.executions.possiblyReplayed(id, seq);
  }

  /** Observe the shared V2 stream once; return its arrival order for ownership callbacks. */
  public receive(
    event: ActivityFamilyEvent,
    at = this.now(),
    deferredExecution?: number,
  ): number {
    const order = ++this.order;

    if (this.source.signal.aborted) {
      return order;
    }

    this.executions.observeNativeTime(nativeActivityTime(event));
    this.queue.expire();
    const id = event.data.sessionID;
    const seq = boundarySeq(event);

    if (this.ignoreChildFrame(id, seq)) {
      return order;
    }

    const reused =
      event.type === "session.execution.started" &&
      this.executions.needsStart(id);

    const packet: Packet = {
      event,
      at,
      order,
      ...(reused && { reused: true }),
    };

    if (event.type === "session.created") {
      const parent = event.data.parentID;

      if (
        parent &&
        parent !== id &&
        !this.children.has(id) &&
        !this.roots.has(id) &&
        !this.executions.get(id)?.admitted
      ) {
        const queued = this.queue.candidate(id);
        const candidate = this.facts(queued);

        if (candidate.created !== undefined) {
          return order;
        }

        candidate.parent = parent;
        candidate.created = order;
        candidate.creationTime = nativeActivityTime(event);

        if (deferredExecution !== undefined) {
          candidate.deferredInference = deferredExecution;
        }

        const roots = this.roots.get(parent);

        const root =
          roots?.size === 1 ? roots.entries().next().value : undefined;

        const earliest = queued.segments[0]?.first.order ?? order;
        const ancestor = this.children.get(parent);

        const owner =
          deferredExecution === undefined &&
          root &&
          root[1].uniqueSince <= earliest
            ? root[0]
            : ancestor && !ancestor.unproven && ancestor.start <= earliest
              ? ancestor.log
              : undefined;

        if (!candidate.inferred && owner) {
          candidate.inferred = owner;
        }

        this.queue.schedule(id);
      }

      return order;
    }

    const child = this.children.get(id);
    const history = this.executions.get(id);

    const recovering = this.queue.active(id);

    if (!recovering && this.lateItem(id, child, packet)) {
      return order;
    }

    if (beforeActivityBoundary(history?.cursor, event)) {
      return order;
    }

    const previousStart = this.executions.startOrder(id);

    if (
      event.type === "session.execution.started" &&
      this.executions.staleStart(id, seq, order)
    ) {
      return order;
    }

    if (recovering) {
      this.queue.enqueue(id, packet, recovering);
    } else if (child && event.type !== "session.execution.started") {
      this.apply(id, child, packet);
    } else if (!this.roots.has(id)) {
      if (child) {
        // A new durable start without an observed end is not the same period.
        this.finish(id, child, "cancelled", true);
      }

      this.enqueueChild(id, packet, previousStart);
    }

    return order;
  }

  private enqueueChild(id: string, packet: Packet, previousStart?: number) {
    const queued = this.queue.candidate(id, previousStart);
    const ancestry = this.facts(queued);
    const continuation = this.executions.get(id)?.continuation;

    if (continuation) {
      ancestry.parent = continuation.parentSession;
      ancestry.continuation = continuation;
      queued.postLoss = true;
      queued.needsStart = false;
    }

    this.queue.enqueue(id, packet, queued);

    if (
      queued.segments[0]?.first.late &&
      ancestry.parent === undefined &&
      !this.reads.has(id)
    ) {
      ancestry.lookup = packet.order;
      this.readParents();
    }
  }

  public async reconnected() {
    const token = ++this.reconciliation;
    this.proofFloor = this.order;
    this.calls.clear();

    await this.queue.settleReads();

    const observed: { id: string; child: Child; latest: number }[] = [];

    for (const [id, child] of this.children) {
      child.log.reconnected();
      delete child.lower;

      if (child.unproven) {
        this.loseAcrossReconnect(id, child);
      } else {
        observed.push({ id, child, latest: child.latest });
      }
    }

    // Unadmitted frames and launch candidates cannot cross a gap in execution order.
    for (const [id, queued] of this.queue.entries()) {
      if (queued.draining) {
        continue;
      }

      this.queue.discard(id);
    }

    this.queue.resetDiscardedProofs();

    if (observed.length === 0) {
      return;
    }

    const boundaries = await reconcileActivity(
      this.source,
      observed.map(({ id, child }) => ({ id, cursor: child.cursor })),
      this.source.signal,
    );

    if (this.source.signal.aborted || token !== this.reconciliation) {
      return;
    }

    for (const [index, { id, child, latest }] of observed.entries()) {
      if (this.children.get(id) !== child || child.latest !== latest) {
        continue;
      }

      const result = boundaries[index];

      if (result === "running") {
        continue;
      }

      if (result?.kind === "settled") {
        this.executions.advance(id, child, result.seq);
        this.finish(id, child, result.outcome);
      } else {
        // A log-only start proves loss of the old period, not live admission.
        this.loseAcrossReconnect(id, child);
      }
    }
  }

  private loseAcrossReconnect(id: string, child: Child) {
    this.executions.lostAcrossReconnect(id, child);
    this.finish(id, child, "cancelled", true);
  }

  /** Reconcile roots and descendants before consuming the new connection's frames. */
  public async reconcileRoots<RootSession extends ObservedRoot>(
    roots: readonly RootSession[],
    lost: (session: RootSession, result: Boundary | undefined) => void,
  ) {
    for (const { open } of roots) {
      for (const { log } of open) {
        log.reconnected();
      }
    }

    const signal = this.source.signal;

    const [results] = await Promise.all([
      roots.length > 0
        ? reconcileActivity(
            this.source,
            roots.map(({ id, startSeq: cursor }) => ({ id, cursor })),
            signal,
          )
        : [],
      this.reconnected(),
    ]);

    for (const [index, session] of roots.entries()) {
      const result = results[index];

      if (signal.aborted || session.dropped || result === "running") {
        continue;
      }

      lost(session, result);
    }
  }

  private close() {
    for (const [id, child] of this.children) {
      this.finish(id, child, "cancelled", true);
    }

    this.queue.close();
    this.executions.clear();
    this.calls.clear();
    this.roots.clear();
    this.peers.clear();
  }

  private readSignal() {
    return AbortSignal.any([this.source.signal, AbortSignal.timeout(readMs)]);
  }

  private readParents() {
    if (this.source.signal.aborted || this.reads.size >= maxReads) {
      return;
    }

    const now = this.now();

    for (const [id, queued] of this.queue.entries()) {
      const ancestry = this.facts(queued);

      if (
        (ancestry.lookup ?? -Infinity) <= this.proofFloor ||
        ancestry.parent !== undefined ||
        this.queue.deadline(queued) <= now ||
        this.reads.has(id)
      ) {
        continue;
      }

      delete ancestry.lookup;
      this.reads.set(id, queued);
      void this.readParent(id, queued);

      if (this.reads.size >= maxReads) {
        break;
      }
    }
  }

  private async readParent(id: string, pending: Pending) {
    try {
      const parent = await this.source.parent(id, this.readSignal());

      if (
        !this.source.signal.aborted &&
        this.queue.peek(id) === pending &&
        this.queue.deadline(pending) > this.now() &&
        parent &&
        parent !== id
      ) {
        this.facts(pending).parent ??= parent;
        this.queue.schedule(id);
      }
    } catch {
      // An unavailable read cannot prove a link.
    } finally {
      this.reads.delete(id);
      queueMicrotask(() => {
        this.readParents();
      });
    }
  }

  private facts(queued: Pending) {
    const facts = this.ancestry.get(queued) ?? {};
    this.ancestry.set(queued, facts);

    return facts;
  }

  private admit(id: string) {
    const queued = this.queue.peek(id);
    const segment = queued?.segments[0];
    const pending = queued && this.facts(queued);

    if (
      !queued ||
      !pending?.parent ||
      !segment ||
      this.children.has(id) ||
      this.queue.active(id) ||
      this.roots.has(id)
    ) {
      return;
    }

    const { first } = segment;
    const previous = this.executions.get(id);

    if (this.executions.possiblyReplayed(id, first.seq, previous?.cursor)) {
      this.queue.skip(id, queued, true);

      return;
    }

    const opened = this.openTurn(id, queued, segment, pending, pending.parent);

    if (!opened) {
      return;
    }

    const { owner, log, callId, ambiguous, proof, scope, unproven, started } =
      opened;

    const startSeq = started ? first.seq : undefined;

    const child: Child = {
      parent: owner,
      parentSession: pending.parent,
      log,
      callId,
      callFloor: segment.floor,
      ...(ambiguous && { ambiguousCall: true }),
      ...(unproven && { unproven: true }),
      ...(pending.continuation && unproven && { continuation: true }),
      projector: new ActivityProjector(),
      start: first.order,
      nativeStart: started ? first.created : undefined,
      latest: first.order,
      ...(startSeq !== undefined && { lower: startSeq }),
      ...((previous?.admitted ?? first.reused) && { reused: true }),
      ...compactedHistory(this.executions, id, pending, proof?.timing),
    };

    this.children.set(id, child);

    if (previous) {
      delete previous.continuation;
    }

    if (scope) {
      this.lineage.set(log, scope);
    }

    if (unproven || callId !== null) {
      proof?.markAttribution?.(first.at, unproven);
    }

    if (!unproven) {
      this.executions.admitted(id, child);
      this.executions.advance(id, child, startSeq, first.created);

      if (started) {
        // A child still awaiting a late name needs its own attribution window.
        this.calls.retire(
          pending.parent,
          scope,
          id,
          callId !== null || ambiguous ? first.order : segment.floor,
        );
      }

      this.inferDescendants(id, child, first.order, segment.boundaryOrder);
    }

    const signal = this.readSignal();
    this.queue.drain(id, queued, {
      signal,
      ...(unproven && { preserveProofs: true }),
      read: (after, readSignal) => this.source.log(id, after, readSignal),
      accepts: isFamilyLogItem,
      owned: () =>
        !this.peers.has(id) &&
        !this.fenced(child.log) &&
        !this.source.signal.aborted,
      replay: (frames) => {
        this.replay(id, child, frames);
      },
      gap: () => {
        markActivityGap(child.log, first.at);
      },
      lost: () => {
        this.loseBoundary(id, child);
      },
      superseded: () => {
        if (this.children.get(id) === child) {
          this.finish(id, child, "cancelled", true);
        }
      },
    });
  }

  private openTurn(
    id: string,
    queued: Pending,
    segment: Pending["segments"][number],
    pending: Ancestry,
    parent: string,
  ) {
    const { first } = segment;
    const started = first.type === "session.execution.started";
    const continuation = pending.continuation;

    const anchor =
      continuation?.log.retained?.() === false ? undefined : continuation;

    const normal =
      !anchor || (started && !queued.lifecycle.lost)
        ? this.attribution(id, queued, pending, parent)
        : undefined;

    const fallback = anchor !== undefined && !normal?.owner;

    if (fallback && started && !this.queue.closed(queued) && !segment.gap) {
      return;
    }

    const attribution = fallback ? detachedAttribution(anchor.parent) : normal;

    if (!attribution) {
      return;
    }

    const { owner, callId, ambiguous, proof } = attribution;
    const scope = owner && this.lineage.get(owner);

    // Reuse requires a start for attribution, but not for detached output.
    if (!fallback && scope && pending.created === undefined && !started) {
      return;
    }

    const unproven =
      fallback ||
      !freshChild(this.executions, id, first, pending, proof?.timing);

    const log = openChild(attribution, id, first.at, unproven, (writer) =>
      this.fenced(writer),
    );

    if (owner && log) {
      return { owner, log, callId, ambiguous, proof, scope, unproven, started };
    }

    if (queued.segments.length > 1) {
      markDiscardedContinuation(anchor?.log, queued, isActivityEvent, true);
    }

    this.queue.skip(id, queued);

    return;
  }

  private loseBoundary(id: string, child: Child) {
    this.executions.block(id);
    this.queue.discard(id);

    if (this.children.get(id) === child) {
      this.finish(id, child, "cancelled", true);
    }
  }

  private inferDescendants(
    id: string,
    child: Child,
    first: number,
    boundary: number | undefined,
  ) {
    for (const [descendant, queued] of this.queue.entries()) {
      const waiting = this.facts(queued);

      if (
        waiting.parent === id &&
        waiting.created !== undefined &&
        Math.min(
          waiting.created,
          queued.segments[0]?.first.order ?? waiting.created,
        ) >= first &&
        (boundary === undefined || waiting.created < boundary)
      ) {
        waiting.inferred ??= child.log;
        this.queue.schedule(descendant, true);
      }
    }
  }

  private replay(id: string, admitted: Child, frames: Packet[]) {
    for (const frame of frames) {
      const child = this.children.get(id);

      if (
        this.lateItem(id, child, frame) ||
        beforeActivityBoundary(this.executions.get(id)?.cursor, frame.event)
      ) {
        continue;
      }

      if (child === admitted) {
        this.apply(id, child, frame);
      }
    }
  }

  private inferredOwner(pending: Ancestry, first: number) {
    const inferred = pending.inferred;
    const root = inferred && this.rootProof.get(inferred);
    const earliest = Math.min(first, pending.created ?? first);

    if (
      inferred &&
      (!root || (root.observed !== undefined && root.observed <= earliest))
    ) {
      return inferred;
    }

    const ancestor =
      pending.parent === undefined
        ? undefined
        : this.children.get(pending.parent);

    return ancestor &&
      !ancestor.unproven &&
      pending.created !== undefined &&
      ancestor.start <= earliest
      ? ancestor.log
      : undefined;
  }

  private apply(id: string, child: Child, packet: Packet) {
    const { event, order } = packet;
    const seq = boundarySeq(event);
    const outcome = activityOutcome(event.type);
    child.latest = order;

    if (child.unproven && outcome !== undefined) {
      if (child.continuation) {
        this.executions.advance(id, child, seq, nativeActivityTime(event));
      }

      this.finish(id, child, "cancelled", true);
    } else if (outcome !== undefined) {
      this.executions.advance(id, child, seq, nativeActivityTime(event));
      this.executions.settled(id, child, seq);
      this.finish(id, child, outcome);
    } else if (event.type === "session.execution.started" && !child.unproven) {
      this.executions.advance(id, child, seq, nativeActivityTime(event));
    } else if (isActivityEvent(event)) {
      if (seq !== undefined) {
        child.cursor = Math.max(child.cursor ?? -1, seq);
      }

      this.project(id, child, event, packet);
    }
  }

  private lateItem(id: string, active: Child | undefined, packet: Packet) {
    const { event } = packet;
    const history = this.executions.get(id);

    if (
      !isActivityEvent(event) ||
      history?.blocked ||
      history?.continuation ||
      active?.continuation
    ) {
      return false;
    }

    const seq = boundarySeq(event);
    const known = this.executions.owner(id, event.data.assistantMessageID, seq);

    if (known === null) {
      return true;
    }

    if (!known) {
      return (
        seq === undefined &&
        !active?.unproven &&
        (active?.uncertainHistory === true ||
          (active?.reused === true && event.type.endsWith(".delta")))
      );
    }

    if (known === active) {
      return false;
    }

    if (
      !known.reconnectLost &&
      known.log.retained?.() !== false &&
      !this.fenced(known.log)
    ) {
      this.project(id, known, event, packet);
    }

    return true;
  }

  private project(
    id: string,
    child: Child,
    event: ActivityEvent,
    packet: Packet,
  ) {
    const result = this.executions.record(child, event);

    if (result !== "duplicate") {
      child.projector.apply(child.log, event, packet.at);

      if (!child.unproven) {
        this.executions.advance(
          id,
          child,
          undefined,
          nativeActivityTime(event),
        );
        this.executions.remember(id, child, event.data.assistantMessageID);
        this.owned(child.log, event, packet.order);
      }
    }

    if (result === "untracked") {
      markActivityGap(
        child.log,
        packet.at,
        "Some activity frames could not be checked for replay.",
      );
    }
  }

  private finish(
    id: string,
    child: Child,
    outcome: ActivityOutcome,
    lost?: true,
  ) {
    this.children.delete(id);
    this.executions.finish(child);
    child.log.end(outcome, lost);
  }
}
