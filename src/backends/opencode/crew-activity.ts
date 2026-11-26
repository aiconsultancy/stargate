import { setTimeout as delay } from "node:timers/promises";
import type { OpenCodeClient } from "@opencode/client";
import { Predicate, Schema } from "effect";
import {
  type CrewTurns,
  type CrewTurnsInput,
  type CrewTurnsTask,
  crewTurnsSchema,
} from "../../coordination/crew/reporting/fleet-status";
import { CrewReporting } from "../../coordination/crew/reporting/report-rpc";
import { createReadSlot } from "../../lib/read-deadline";
import type {
  ActivityOutcome,
  CrewTurnRecorder,
  CrewTurnTask,
} from "../backend";
import { ActivityProjector, activityEvents } from "./activity-projector";
import { ExecutionHistory } from "./crew-executions";
import {
  HeldFrames,
  type Peer,
  type Pending,
  type Session,
  SessionMessages,
  type Turn,
  isPending,
  kept,
} from "./crew-messages";
import { owningInput } from "./input-origin";
import type { OpenCodeCrewActivity } from "./opencode";

const settledEvents = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

const startedEvent = "session.execution.started";

const subscribe = (events: OpenCodeClient["event"], signal: AbortSignal) =>
  events.subscribe({
    types: [...activityEvents, ...settledEvents, startedEvent],
    signal,
  });

type Frame =
  ReturnType<typeof subscribe> extends AsyncIterable<infer F> ? F : never;

type Event = Exclude<Frame, { type: "server.connected" }>;

const outcomes: Record<(typeof settledEvents)[number], ActivityOutcome> = {
  "session.execution.succeeded": "completed",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "cancelled",
};

const isSettled = (
  event: Event,
): event is Extract<Event, { type: (typeof settledEvents)[number] }> =>
  Object.hasOwn(outcomes, event.type);

/**
 * A boundary's position in its session's durable log: OpenCode keys
 * session events' durable log by session ID, and `seq` only increases
 * within it. Undefined when the frame carries no such position.
 */
function boundarySeq(event: unknown) {
  const durable: unknown = Predicate.hasProperty(event, "durable")
    ? event.durable
    : undefined;

  const session: unknown = Predicate.hasProperty(event, "data")
    ? Predicate.hasProperty(event.data, "sessionID") && event.data.sessionID
    : undefined;

  return Predicate.hasProperty(durable, "seq") &&
    Predicate.hasProperty(durable, "aggregateID") &&
    durable.aggregateID === session &&
    Number.isSafeInteger(durable.seq)
    ? Number(durable.seq)
    : undefined;
}

const decodeTurns = Schema.decodeUnknownSync(crewTurnsSchema);

/** An older crew plugin that lacks the called RPC method. */
const isMethodNotFound = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "type" in error &&
  error.type === "rpc.method_not_found";

export type CrewActivityOptions = {
  /** Peer and recent task refresh interval. */
  refreshMs: number;
  /** Frames wait at most this long, or `bufferBytes`, for attribution. */
  bufferMs: number;
  bufferBytes: number;
  /**
   * Held frame bytes across every session, as serialized `data` without the
   * small envelope. Past it, the oldest waiting messages open unattributed.
   */
  pendingBytes: number;
  /**
   * Concurrent resolutions: past it, a message opens at once, unattributed,
   * and resolves later.
   */
  resolving: number;
  /** Deadline of one `crewTurns` read. */
  readMs: number;
  /** A plugin without `crewTurns` is asked again after this long. */
  unsupportedRetryMs: number;
};

const defaults: CrewActivityOptions = {
  refreshMs: 15_000,
  bufferMs: 2000,
  bufferBytes: 256 * 1024,
  pendingBytes: 4 * 1024 * 1024,
  resolving: 8,
  readMs: 2000,
  unsupportedRetryMs: 60_000,
};

/** Retained per collector: lookups, misses and fenced sessions. */
const maxRemembered = 256;
const ownershipAttempts = 6;
const ownershipReadMs = 10_000;

export type CrewActivitySource = {
  events: OpenCodeClient["event"];
  /** The crew plugin's `crewTurns`; an older plugin rejects the method. */
  turns(input: CrewTurnsInput, signal: AbortSignal): Promise<unknown>;
  /** The input owning an assistant message; undefined when not provable yet. */
  owner(
    sessionID: string,
    assistantID: string,
    signal: AbortSignal,
  ): Promise<{ input: string | undefined } | undefined>;
};

type TaskRecord = Pick<
  CrewTurnsTask,
  "taskID" | "member" | "project" | "workerSessionID"
>;

/** A failed read (deadline, transport, busy slot) is not an empty answer. */
type TurnsRead = CrewTurns | "unsupported" | "failed";

const remember = <K, V>(map: Map<K, V>, key: K, value: V, limit: number) => {
  map.delete(key);
  map.set(key, value);

  for (const oldest of map.keys()) {
    if (map.size <= limit) {
      break;
    }

    map.delete(oldest);
  }
};

const samePeer = (a: Peer, b: Peer) =>
  a.member === b.member &&
  a.project === b.project &&
  a.namespace === b.namespace;

/**
 * Collects crew worker turns of one OpenCode captain registration from one
 * long-lived event subscription. Only root sessions of this registration's
 * current peers count; a turn is attributed to a task by the input it
 * answers, and only when that task ran in the same session and member.
 */
export class CrewActivityCollector {
  private readonly options: CrewActivityOptions;
  /** Targeted lookups, one at a time; refresh has its own slot. */
  private readonly reads;
  private readonly refreshes;
  private readQueue: Promise<unknown> = Promise.resolve();
  private supported: boolean | undefined;
  private consuming = false;
  private signal: AbortSignal | undefined;
  /** Aborted: nothing late begins, attributes or writes a turn. */
  private closed = false;

  private readonly sessions = new Map<string, Session>();
  /** Sessions whose identity changed: never admitted again. */
  private readonly fenced = new Map<string, true>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly misses = new Map<string, true>();
  private readonly lookups = new Map<string, Promise<void>>();
  /** Unattributed turns by input, for a task a later refresh learns. */
  private readonly unattributed = new Map<string, Turn[]>();
  /** Frames of waiting messages, across sessions. */
  private readonly held: HeldFrames;
  private resolving = 0;
  private readonly deferred: Pending[] = [];
  private readonly resolutions = new Set<Pending>();

  public constructor(
    private readonly recorder: CrewTurnRecorder,
    private readonly source: CrewActivitySource,
    options: Partial<CrewActivityOptions> = {},
  ) {
    this.options = { ...defaults, ...options };
    this.reads = createReadSlot<unknown>(this.options.readMs);
    this.refreshes = createReadSlot<unknown>(this.options.readMs);
    this.held = new HeldFrames(this.options, (pending) => {
      this.force(pending);
    });
  }

  /** False until the crew plugin answers `crewTurns`, and for older plugins. */
  public get collected() {
    return this.supported === true;
  }

  /** Held frame bytes and outstanding resolutions. */
  public get load() {
    return {
      heldBytes: this.held.bytes,
      /** Forced messages the bound let go unplaced; always 0 unless a bug. */
      unplaced: this.held.unplaced,
      resolving: this.resolving,
      deferred: this.deferred.length,
      /** Frames still held by running or deferred resolutions. */
      resolvingFrames: [...this.resolutions, ...this.deferred].reduce(
        (frames, pending) => frames + pending.frames.length,
        0,
      ),
      lookups: this.lookups.size,
      turns: this.references(),
    };
  }

  /** Distinct turns this collector still references. */
  private references() {
    const turns = new Set<Turn>();

    for (const session of this.sessions.values()) {
      for (const turn of [...session.open, ...session.messages.turns()]) {
        turns.add(turn);
      }
    }

    for (const waiting of this.unattributed.values()) {
      for (const turn of waiting) {
        turns.add(turn);
      }
    }

    return turns.size;
  }

  public start(signal: AbortSignal) {
    if (this.signal) {
      return;
    }

    this.signal = signal;

    if (signal.aborted) {
      this.close();

      return;
    }

    signal.addEventListener(
      "abort",
      () => {
        this.close();
      },
      { once: true },
    );
    void this.refreshLoop(signal);
  }

  /** On abort: open turns end cancelled; frames, timers and roster clear. */
  private close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const session of this.sessions.values()) {
      this.drop(session);
    }

    this.held.releaseAll();
    this.deferred.length = 0;
    this.unattributed.clear();
    this.tasks.clear();
    this.misses.clear();
    this.roster(undefined);
  }

  /** Forget evicted turns: as the recorder names them, and at each refresh. */
  private prune(
    sessions: Iterable<Session> = this.sessions.values(),
    gone = (turn: Turn) => !kept(turn),
  ) {
    for (const session of sessions) {
      session.messages.prune(gone);
    }

    for (const [input, waiting] of this.unattributed) {
      const left = waiting.filter((turn) => !gone(turn));

      if (left.length === 0) {
        this.unattributed.delete(input);
      } else {
        this.unattributed.set(input, left);
      }
    }
  }

  private async refreshLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      const turns = await this.readTurns(this.refreshes, {}, signal);
      let wait = this.options.refreshMs;

      if (this.closed) {
        return;
      }

      this.prune();

      if (turns === "unsupported") {
        this.supported = false;
        this.applyPeers([]);
        this.roster(undefined);
        wait = this.options.unsupportedRetryMs;
      } else if (turns !== "failed") {
        this.supported = true;
        this.applyPeers(turns.peers);
        this.addTasks(turns.tasks);
        const members = turns.members ?? [];

        this.roster(
          [
            ...new Set([
              ...turns.peers.map((peer) => peer.member),
              ...members.flatMap((entry) =>
                entry.collected ? [entry.member] : [],
              ),
            ]),
          ],
          members.flatMap((entry) => (entry.collected ? [] : [entry.member])),
        );

        if (!this.consuming) {
          this.consuming = true;
          void this.consume(signal);
        }
      }

      await delay(wait, undefined, { signal, ref: false }).catch(() => {});
    }
  }

  private roster(
    members: readonly string[] | undefined,
    uncollected: readonly string[] = [],
  ) {
    try {
      this.recorder.roster?.(members, uncollected);
    } catch {
      /* The recorder never affects collection. */
    }
  }

  private async readTurns(
    slot: typeof this.reads,
    input: CrewTurnsInput,
    signal: AbortSignal,
  ): Promise<TurnsRead> {
    // An earlier read that ignored its abort still occupies the slot.
    if (signal.aborted || slot.pending) {
      return "failed";
    }

    try {
      return decodeTurns(
        await slot.start(signal, (reading) => this.source.turns(input, reading))
          .result,
      );
    } catch (error) {
      return isMethodNotFound(error) ? "unsupported" : "failed";
    }
  }

  /** Targeted lookups queue behind each other, never behind a refresh. */
  private lookupRead(input: CrewTurnsInput, signal: AbortSignal) {
    const read = this.readQueue.then(() =>
      this.readTurns(this.reads, input, signal),
    );

    this.readQueue = read;

    return read;
  }

  private applyPeers(peers: CrewTurns["peers"]) {
    const counts = new Map<string, number>();

    for (const { workerSessionID } of peers) {
      counts.set(workerSessionID, (counts.get(workerSessionID) ?? 0) + 1);
    }

    // A session claimed twice belongs to no one.
    const next = new Map(
      peers
        .filter(({ workerSessionID }) => counts.get(workerSessionID) === 1)
        .map(({ workerSessionID, member, project, namespace }) => [
          workerSessionID,
          { member, project, namespace },
        ]),
    );

    // A replaced or removed peer session drops out with its open turn.
    for (const [id, session] of this.sessions) {
      const peer = next.get(id);

      if (!peer) {
        this.drop(session);
      } else if (!samePeer(peer, session.peer)) {
        this.drop(session);
        remember(this.fenced, id, true, maxRemembered);
      }
    }

    for (const [id, peer] of next) {
      if (!this.sessions.has(id) && !this.fenced.has(id)) {
        this.sessions.set(id, {
          id,
          peer,
          open: new Set(),
          messages: new SessionMessages(),
          execution: 0,
          boundary: -1,
          history: new ExecutionHistory(),
          arrivals: 0,
          dropped: false,
        });
      }
    }
  }

  private drop(session: Session) {
    session.dropped = true;
    this.sessions.delete(session.id);

    for (const pending of session.messages.waiting()) {
      this.held.release(pending);
    }

    this.endOpen(session, "cancelled");
  }

  private addTasks(tasks: readonly CrewTurnsTask[]) {
    if (this.closed) {
      return;
    }

    for (const task of tasks) {
      for (const input of task.inputIDs) {
        remember(this.tasks, input, task, maxRemembered * 4);
        this.misses.delete(input);
        const waiting = this.unattributed.get(input);
        this.unattributed.delete(input);

        for (const turn of waiting ?? []) {
          const found = turn.session.dropped
            ? undefined
            : this.task(turn.session, input);

          if (found) {
            this.attributeTurn(turn, found);
          }
        }
      }
    }
  }

  private async consume(signal: AbortSignal) {
    let retryMs = 250;
    let connections = 0;

    while (!signal.aborted) {
      try {
        for await (const frame of subscribe(this.source.events, signal)) {
          if (frame.type === "server.connected") {
            if (++connections > 1) {
              this.reconnected();
            }

            retryMs = 250;
            continue;
          }

          this.receive(frame, Date.now());
        }
      } catch {
        /* Reattach below; crew work is unaffected. */
      }

      await delay(retryMs, undefined, { signal, ref: false }).catch(() => {});
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  }

  private reconnected() {
    for (const session of this.sessions.values()) {
      // Boundaries in the gap are unseen: no open interval spans it.
      session.history.reconnected();

      for (const turn of session.open) {
        turn.log.reconnected();
      }
    }
  }

  private receive(event: Event, at: number) {
    const session = this.sessions.get(event.data.sessionID);

    // Not a current root peer session of this registration's own plugin.
    if (!session || this.closed) {
      return;
    }

    if (isSettled(event) || event.type === startedEvent) {
      // A replayed or older boundary changes nothing.
      if (this.stale(session, event)) {
        return;
      }

      const seq = boundarySeq(event);

      if (isSettled(event)) {
        this.settle(session, outcomes[event.type], seq);
      } else {
        this.started(session, seq);
      }

      return;
    }

    const assistant = event.data.assistantMessageID;
    const entry = session.messages.get(assistant);

    if (entry && "log" in entry) {
      if (kept(entry)) {
        entry.projector.apply(entry.log, event, at);
      }

      return;
    }

    if (isPending(entry)) {
      this.held.hold(entry, event, at);

      return;
    }

    // Its turn was evicted.
    if (entry) {
      return;
    }

    // First seen after its execution settled: only its sequence proves it.
    const late = session.history.holding(boundarySeq(event));

    const pending: Pending = {
      session,
      assistant,
      frames: [],
      bytes: 0,
      resolved: false,
      input: undefined,
      task: undefined,
      ready: false,
      forced: false,
      deadline: undefined,
      settled: late?.outcome,
      position: late?.position ?? session.execution,
      arrival: ++session.arrivals,
      timer: setTimeout(() => {
        this.ready(pending);
      }, this.options.bufferMs),
    };

    pending.timer.unref?.();
    this.held.add(pending);
    session.messages.track(pending, (oldest) => {
      this.force(oldest);
    });
    this.held.hold(pending, event, at);

    if (this.resolving < this.options.resolving) {
      void this.resolve(pending);
    } else {
      // Past the bound: start now, and attribute when a place frees.
      this.force(pending);
      this.deferred.push(pending);

      if (this.deferred.length > maxRemembered) {
        this.deferred.shift();
      }
    }
  }

  private settle(session: Session, outcome: ActivityOutcome, seq?: number) {
    session.history.settled(session.execution, seq, outcome);
    session.execution += 1;
    this.endOpen(session, outcome);

    for (const pending of session.messages.waiting()) {
      pending.settled ??= outcome;
    }

    this.prune();
  }

  /**
   * Native boundaries apply in their session's durable order: one at or
   * below the latest applied sequence is a replay or arrived late. One
   * without a durable sequence of this session is applied unfenced.
   */
  private stale(session: Session, event: Event) {
    const seq = boundarySeq(event);

    if (seq === undefined) {
      return false;
    }

    if (seq <= session.boundary) {
      return true;
    }

    session.boundary = seq;

    return false;
  }

  /**
   * A native start while the current execution still has open turns or
   * waiting messages: its settle was missed. It ends cancelled, its waiting
   * messages are stamped so, and the execution advances before the new one
   * is tracked. The settlement is inferred, not witnessed, so it passes no
   * sequence and records no interval: unseen executions may lie between.
   */
  private started(session: Session, seq: number | undefined) {
    if (session.open.size > 0 || session.messages.waits(session.execution)) {
      this.settle(session, "cancelled");
    }

    session.history.started(seq);
  }

  /** Every turn of the running execution ends with its outcome. */
  private endOpen(session: Session, outcome: ActivityOutcome) {
    const open = [...session.open];
    session.open.clear();

    for (const turn of open) {
      if (!turn.ended) {
        turn.ended = true;
        turn.log.end(outcome);
      }
    }
  }

  private async resolve(pending: Pending) {
    this.resolving += 1;
    this.resolutions.add(pending);

    try {
      await this.attribute(pending);
    } finally {
      this.resolving -= 1;
      this.resolutions.delete(pending);

      while (this.resolving < this.options.resolving) {
        const next = this.deferred.shift();

        if (!next) {
          break;
        }

        if (!next.session.dropped) {
          void this.resolve(next);
        }
      }
    }
  }

  private async attribute(pending: Pending) {
    const { session, assistant } = pending;
    const input = await this.owner(session.id, assistant);

    if (session.dropped) {
      return;
    }

    pending.resolved = true;
    pending.input = input;
    let task = input === undefined ? null : this.task(session, input);

    // Opened by a bound before ownership was known.
    const early = session.messages.get(assistant);

    if (
      early &&
      "log" in early &&
      early.opener === assistant &&
      early.input === undefined
    ) {
      early.input = input;
      this.awaitTask(early);
    }

    if (task === undefined && input !== undefined) {
      await this.lookup(session.peer.member, input);

      if (session.dropped) {
        return;
      }

      task = this.task(session, input);
    }

    const entry = session.messages.get(assistant);

    if (entry === pending) {
      pending.task = task ?? null;
      this.ready(pending);
    } else if (entry && "log" in entry) {
      if (entry.opener === assistant) {
        entry.resolving = false;
      }

      if (task && entry.input === input) {
        this.attributeTurn(entry, task);
      }

      // A message held behind this opener is checked again.
      this.flush(session);
    }
  }

  private async owner(
    sessionID: string,
    assistant: string,
  ): Promise<string | undefined> {
    const signal = this.signal;

    if (!signal) {
      return;
    }

    let retryMs = 250;

    for (let attempt = 1; ; attempt++) {
      const owner = await this.source
        .owner(
          sessionID,
          assistant,
          AbortSignal.any([signal, AbortSignal.timeout(ownershipReadMs)]),
        )
        .catch(() => null);

      // Unprovable after the retries: the turn stays unattributed.
      if (owner || attempt >= ownershipAttempts || signal.aborted) {
        return owner?.input;
      }

      await delay(retryMs, undefined, { signal, ref: false }).catch(() => {});
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  }

  /** The task this session's input answers; undefined when not yet known. */
  private task(
    session: Session,
    input: string,
  ): CrewTurnTask | null | undefined {
    const task = this.tasks.get(input);

    if (!task) {
      return this.misses.has(input) ? null : undefined;
    }

    return task.workerSessionID === session.id &&
      task.member === session.peer.member &&
      task.project === session.peer.project
      ? { id: task.taskID, inputId: input, project: task.project }
      : null;
  }

  /**
   * One `crewTurns` lookup per unknown input at a time. Only a successful
   * answer without the input is a miss; a failed read is asked again.
   */
  private lookup(member: string, input: string) {
    let lookup = this.lookups.get(input);

    if (!lookup) {
      const signal = this.signal ?? AbortSignal.abort();

      lookup = this.lookupRead({ member, inputID: input }, signal)
        .then((turns) => {
          if (!this.closed && turns !== "failed" && turns !== "unsupported") {
            this.addTasks(turns.tasks);

            if (!this.tasks.has(input)) {
              remember(this.misses, input, true, maxRemembered);
            }
          }
        })
        .finally(() => {
          this.lookups.delete(input);
        });

      this.lookups.set(input, lookup);
    }

    return lookup;
  }

  private attributeTurn(turn: Turn, task: CrewTurnTask) {
    if (!turn.task) {
      turn.task = task;
      turn.log.attribute(task);
    }
  }

  /** An unattributed turn whose task a later refresh may name. */
  private awaitTask(turn: Turn) {
    if (turn.input === undefined || turn.task) {
      return;
    }

    const waiting = this.unattributed.get(turn.input) ?? [];

    if (!waiting.includes(turn)) {
      waiting.push(turn);
    }

    remember(this.unattributed, turn.input, waiting.slice(-4), maxRemembered);
  }

  private begin(
    pending: Pending,
    input: string | undefined,
    task: CrewTurnTask | null,
  ): Turn {
    const { session } = pending;

    const turn: Turn = {
      session,
      log: this.recorder.begin(
        {
          member: session.peer.member,
          project: session.peer.project,
          session: { id: session.id, parent: null },
          task,
        },
        // It started when its first frame was observed.
        pending.frames[0]?.at,
        () => {
          this.prune([session], (evicting) => evicting === turn);
        },
      ),
      projector: new ActivityProjector(),
      input,
      opener: pending.assistant,
      task,
      ended: false,
      resolving: pending.task === undefined,
      position: pending.position,
      arrival: pending.arrival,
    };

    this.awaitTask(turn);

    return turn;
  }

  /** An execution's turns, in the order their first messages arrived. */
  private turnsOf(session: Session, position: number) {
    const turns = new Set<Turn>();

    for (const turn of [...session.open, ...session.messages.turns()]) {
      if (turn.position === position && kept(turn)) {
        turns.add(turn);
      }
    }

    return [...turns].toSorted((a, b) => a.arrival - b.arrival);
  }

  /** Placeable now: resolved, or past its buffer time. */
  private ready(pending: Pending) {
    pending.ready = true;
    this.flush(pending.session);
  }

  /** A bound places the message now, and every earlier one of its execution. */
  private force(pending: Pending) {
    for (const entry of pending.session.messages.waiting()) {
      if (entry.position === pending.position) {
        entry.ready = true;
        entry.forced = true;
      }

      if (entry === pending) {
        break;
      }
    }

    this.flush(pending.session);
  }

  /**
   * Place each execution's waiting messages in arrival order: a message
   * waits for every earlier one of its execution.
   */
  private flush(session: Session) {
    const blocked = new Set<number>();

    for (const entry of session.messages.waiting()) {
      if (
        !blocked.has(entry.position) &&
        (!entry.ready || !this.place(entry))
      ) {
        blocked.add(entry.position);
      }
    }
  }

  /**
   * Hold a message with a proven task while its execution's latest turn is
   * still resolving its opener: until that resolves or one more
   * `bufferMs`, and never past twice `bufferMs` after its first frame.
   */
  private holds(pending: Pending, turns: readonly Turn[]) {
    if (pending.forced || !pending.task || !turns.at(-1)?.resolving) {
      return false;
    }

    const now = Date.now();
    const { bufferMs } = this.options;
    const first = pending.frames[0]?.at ?? now;
    pending.deadline ??= Math.min(now + bufferMs, first + 2 * bufferMs);

    if (now >= pending.deadline) {
      return false;
    }

    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.forced = true;
      this.flush(pending.session);
    }, pending.deadline - now);
    pending.timer.unref?.();

    return true;
  }

  /**
   * Start or join the message's turn and apply its held frames; false while
   * it is held. A message with a proven task joins only the execution's
   * latest turn of the same input or task, else opens its own; any other
   * message joins the execution's latest turn. A turn is one execution: a
   * message never ends it; only that execution's settlement does. A message
   * of a settled execution with no retained turn opens one that ends at once.
   */
  private place(pending: Pending) {
    const { session, assistant } = pending;

    if (session.dropped || session.messages.get(assistant) !== pending) {
      this.held.release(pending);

      return true;
    }

    const turns = this.turnsOf(session, pending.position);

    if (this.holds(pending, turns)) {
      return false;
    }

    const input = pending.resolved ? pending.input : undefined;
    const task = pending.task ?? null;

    const joined = task
      ? turns.findLast(
          (turn) => turn.input === input || turn.task?.id === task.id,
        )
      : turns.at(-1);

    const running = pending.position === session.execution;
    const turn = joined ?? this.begin(pending, input, task);

    if (running && !turn.ended) {
      session.open.add(turn);
    }

    session.messages.place(assistant, turn);

    for (const { event, at } of pending.frames) {
      turn.projector.apply(turn.log, event, at);
    }

    this.held.release(pending);

    if (task && turn.input === input) {
      this.attributeTurn(turn, task);
    }

    // A settled execution's own turn is over at once.
    if (!running && !joined && !turn.ended) {
      turn.ended = true;
      turn.log.end(pending.settled ?? "completed");
    }

    return true;
  }
}

/** Collect one registration's crew turns into `recorder`. */
export const crewActivityStarter =
  (recorder: CrewTurnRecorder): OpenCodeCrewActivity =>
  (client, directory, signal) => {
    openCodeCrewActivity(client, directory, recorder).start(signal);
  };

/** A registration's crew collector over its OpenCode client and crew plugin. */
export function openCodeCrewActivity(
  client: OpenCodeClient,
  directory: () => string,
  recorder: CrewTurnRecorder,
) {
  return new CrewActivityCollector(recorder, {
    events: client.event,
    turns: (input, signal) =>
      client.rpc(CrewReporting).crewTurns(input, {
        location: { directory: directory() },
        signal,
      }),
    owner: (sessionID, assistant, signal) =>
      owningInput(client, sessionID, signal, assistant),
  });
}
