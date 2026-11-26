import type {
  ActivityOutcome,
  CrewTurnActivityLog,
  CrewTurnTask,
} from "../backend";
import type { ActivityEvent, ActivityProjector } from "./activity-projector";
import type { ExecutionHistory } from "./crew-executions";

/** A worker session's identity; a change fences the session for good. */
export type Peer = {
  member: string;
  project: string | null;
  namespace: string;
};

export type Turn = {
  session: Session;
  log: CrewTurnActivityLog;
  projector: ActivityProjector;
  input: string | undefined;
  /** The assistant message that opened it: only its input names the turn. */
  opener: string;
  task: CrewTurnTask | null;
  ended: boolean;
  /** Its opener's owner and task are still being resolved. */
  resolving: boolean;
  /** The execution and arrival of the message that opened it. */
  position: number;
  arrival: number;
};

export type HeldFrame = { event: ActivityEvent; at: number };

/** Frames of one assistant message, waiting for ownership and attribution. */
export type Pending = {
  session: Session;
  assistant: string;
  frames: HeldFrame[];
  /** UTF-8 bytes of the held frames' serialized `data`. */
  bytes: number;
  /** Its owner is known. */
  resolved: boolean;
  input: string | undefined;
  /** Its task once owner and task are known; null when it answers none. */
  task: CrewTurnTask | null | undefined;
  /** It may be placed: resolved, past `bufferMs` or forced by a bound. */
  ready: boolean;
  /** Forced by a bound: placed at once, never held. */
  forced: boolean;
  /** When a hold behind a resolving opener ends. */
  deadline: number | undefined;
  /** The execution settled while this message waited. */
  settled: ActivityOutcome | undefined;
  /** The session's execution when the message's first frame arrived. */
  position: number;
  arrival: number;
  timer: ReturnType<typeof setTimeout>;
};

export type Session = {
  id: string;
  peer: Peer;
  /** Turns of the running execution; its settlement ends them all. */
  open: Set<Turn>;
  messages: SessionMessages;
  /** Bumped by each settlement. */
  execution: number;
  /** The durable sequence of the latest native boundary applied. */
  boundary: number;
  /** Recently settled executions with both durable bounds witnessed. */
  history: ExecutionHistory;
  arrivals: number;
  /** No longer a peer: late resolutions change nothing. */
  dropped: boolean;
};

/**
 * A message whose turn the recorder evicted, or that a bound let go
 * unplaced: its later frames are dropped.
 */
type Evicted = { evicted: true; position: number };

type Placed = Turn | Evicted;

type Entry = Pending | Placed;

export const isPending = (entry: Entry | undefined): entry is Pending =>
  entry !== undefined && "frames" in entry;

/** Running turns are never evicted; an older recorder keeps every turn. */
export const kept = (turn: Turn) =>
  !turn.ended || (turn.log.retained?.() ?? true);

/** Per worker session: waiting messages, which hold frames. */
const maxMessages = 64;

/** Per worker session: messages no longer known, whose frames are dropped. */
const maxEvicted = 1024;

/** Per worker session: a safety ceiling on messages still known. */
const maxKnown = 16_384;

/**
 * One worker session's assistant messages, and the only writer of their
 * placement: each waits with its frames held, has joined a turn, or was
 * dropped with its evicted turn. A message whose turn is running or
 * retained stays known, so its later frames continue it; only messages no
 * longer known count against their bound. An unknown message's first
 * frame always opens it.
 */
export class SessionMessages {
  /** Waiting messages in arrival order, bounded by `maxMessages`. */
  private readonly pending = new Map<string, Pending>();
  /** Messages whose turn is kept, in placement order, up to `maxKnown`. */
  private readonly known = new Map<string, Turn>();
  /** Messages no longer known, oldest first, bounded by `maxEvicted`. */
  private readonly evicted = new Map<string, Evicted>();

  public constructor(
    /** Counts a still-known message forgotten past `maxKnown`. */
    private readonly forget: () => void,
  ) {}

  public get(assistant: string): Entry | undefined {
    return (
      this.pending.get(assistant) ??
      this.known.get(assistant) ??
      this.evicted.get(assistant)
    );
  }

  /** Waiting messages in arrival order. */
  public *waiting() {
    yield* this.pending.values();
  }

  /** Whether a message of execution `position` still waits. */
  public waits(position: number) {
    return [...this.pending.values()].some(
      (entry) => entry.position === position,
    );
  }

  /** Turns that placed messages joined. */
  public *turns() {
    yield* this.known.values();
  }

  /** Remember a waiting message; past the bound, the oldest is forced. */
  public track(pending: Pending, force: (oldest: Pending) => void) {
    this.pending.set(pending.assistant, pending);

    for (const oldest of this.pending.values()) {
      if (this.pending.size <= maxMessages) {
        break;
      }

      force(oldest);
      // Placement moved it; one still here is let go unplaced.
      this.pending.delete(oldest.assistant);
    }
  }

  public place(assistant: string, turn: Turn) {
    this.unset(assistant);
    this.known.set(assistant, turn);

    if (this.known.size <= maxKnown) {
      return;
    }

    // Before the ceiling forgets a known message, drop those gone since.
    this.prune((entry) => !kept(entry));

    for (const oldest of this.known.keys()) {
      if (this.known.size <= maxKnown) {
        break;
      }

      // Its later output opens a new message.
      this.known.delete(oldest);
      this.forget();
    }
  }

  /** Its later frames are dropped. */
  public evict(pending: Pending) {
    this.remove(pending.assistant, pending.position);
  }

  /** Forget turns the recorder evicted: their messages' frames are dropped. */
  public prune(gone: (turn: Turn) => boolean) {
    for (const [key, entry] of this.known) {
      if (gone(entry)) {
        this.remove(key, entry.position);
      }
    }
  }

  private unset(assistant: string) {
    this.pending.delete(assistant);
    this.known.delete(assistant);
    this.evicted.delete(assistant);
  }

  /** No longer known: past the bound, the oldest such is forgotten. */
  private remove(assistant: string, position: number) {
    this.unset(assistant);
    this.evicted.set(assistant, { evicted: true, position });

    for (const oldest of this.evicted.keys()) {
      if (this.evicted.size <= maxEvicted) {
        break;
      }

      this.evicted.delete(oldest);
    }
  }
}

/**
 * Frames held for waiting messages across a collector's sessions, counted
 * in arrival order against the per-message and total byte bounds.
 */
export class HeldFrames {
  private readonly pendings = new Set<Pending>();
  private held = 0;
  /** Forced messages the bound let go unplaced; always 0 unless a bug. */
  public unplaced = 0;

  public constructor(
    private readonly bounds: { bufferBytes: number; pendingBytes: number },
    /** Places the message now, and every earlier one of its execution. */
    private readonly force: (pending: Pending) => void,
  ) {}

  public get bytes() {
    return this.held;
  }

  public add(pending: Pending) {
    this.pendings.add(pending);
  }

  public hold(pending: Pending, event: ActivityEvent, at: number) {
    const bytes = Buffer.byteLength(JSON.stringify(event.data));
    pending.frames.push({ event, at });
    pending.bytes += bytes;

    if (this.pendings.has(pending)) {
      this.held += bytes;
    }

    // The bound: the turn starts unattributed, and a late lookup updates it.
    if (pending.bytes > this.bounds.bufferBytes) {
      this.force(pending);
    }

    while (this.held > this.bounds.pendingBytes) {
      const [oldest] = this.pendings;

      if (!oldest) {
        break;
      }

      this.force(oldest);

      // Placement owns the count; one still counted is let go and counted.
      if (this.pendings.has(oldest)) {
        this.unplaced += 1;
        this.release(oldest);
        // Its later frames are dropped rather than held uncounted.
        oldest.session.messages.evict(oldest);
      }
    }
  }

  /** Placed or dropped: uncounted, and its frames go; attribution needs none. */
  public release(pending: Pending) {
    clearTimeout(pending.timer);

    if (this.pendings.delete(pending)) {
      this.held -= pending.bytes;
    }

    pending.frames = [];
    pending.bytes = 0;
  }

  public releaseAll() {
    for (const pending of this.pendings) {
      this.release(pending);
    }
  }
}
