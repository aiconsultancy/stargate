import type { OpenCodeClient, SessionLogItem } from "@opencode/client";
import type { ActivityOutcome, TurnActivityLog } from "../backend";
import { boundarySeq } from "./crew-executions";

export type GapSlot = { order: number; at: number; type: string; seq: number };

export const maxActivityGapSlots = 256;
export const activityReadMs = 2000;
export const activityMaxReads = 8;
const maxLogFrames = 4096;
const maxLifecycleFrames = 64;

/** A full lifecycle queue invalidates ownership, not just transcript completeness. */
export class ActivityLifecycleBuffer {
  private count = 0;

  public get lost() {
    return this.count > maxLifecycleFrames;
  }

  public retain() {
    this.count += 1;

    return !this.lost;
  }
}

const outcomes = {
  "session.execution.succeeded": "completed",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "cancelled",
} as const satisfies Record<string, ActivityOutcome>;

export const isSettled = (type: string): type is keyof typeof outcomes =>
  Object.hasOwn(outcomes, type);

export const activityOutcome = (type: string) =>
  isSettled(type) ? outcomes[type] : undefined;

export type Boundary =
  | { kind: "start"; seq: number }
  | { kind: "settled"; seq: number; outcome: ActivityOutcome };

type Freshness = { cursor?: number; reading?: true; attempted?: number | null };

/** Read a native checkpoint; a start observed above it can establish a new period. */
export class ActivityFreshness<Candidate extends object> {
  private readonly checks = new WeakMap<Candidate, Freshness>();
  private active = 0;

  public constructor(private readonly limit: number) {}

  public check(
    candidate: Candidate,
    id: string,
    seq: number | undefined,
    read: (after: number, signal: AbortSignal) => AsyncIterable<SessionLogItem>,
    signal: AbortSignal,
    ready: () => void,
  ) {
    const state = this.checks.get(candidate) ?? {};

    if (state.reading) {
      return "waiting";
    }

    if (state.cursor !== undefined) {
      return seq !== undefined && seq > state.cursor ? "fresh" : "uncertain";
    }

    if ((seq ?? null) === state.attempted || this.active >= this.limit) {
      return "uncertain";
    }

    state.attempted = seq ?? null;
    state.reading = true;
    this.checks.set(candidate, state);
    this.active += 1;
    void this.checkpoint(id, seq, read, signal).then((cursor) => {
      if (cursor !== undefined) {
        state.cursor = cursor;
      }

      delete state.reading;
      this.active -= 1;
      ready();
    });

    return "waiting";
  }

  private async checkpoint(
    id: string,
    observed: number | undefined,
    read: (after: number, signal: AbortSignal) => AsyncIterable<SessionLogItem>,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    let count = 0;

    try {
      // OpenCode still emits its actual watermark if `after` is beyond the log.
      for await (const frame of read(Number.MAX_SAFE_INTEGER, signal)) {
        if (signal.aborted || ++count > maxActivityGapSlots) {
          break;
        }

        if (frame.type === "log.synced") {
          return frame.aggregateID === id &&
            frame.seq !== undefined &&
            frame.seq >= (observed ?? 0)
            ? frame.seq
            : undefined;
        }
      }
    } catch {
      // A failed read cannot prove freshness.
    }

    return;
  }
}

/** Reconnect only inspects lifecycle; it does not replay gaps in the stream. */
export async function readActivityBoundary(
  log: (
    id: string,
    after: number,
    signal: AbortSignal,
  ) => AsyncIterable<SessionLogItem>,
  { id, cursor }: { id: string; cursor: number | undefined },
  signal: AbortSignal,
): Promise<Boundary | "synced" | undefined> {
  if (cursor === undefined) {
    return;
  }

  let frames = 0;

  try {
    for await (const frame of log(id, cursor, signal)) {
      if (signal.aborted || ++frames > maxActivityGapSlots) {
        return;
      }

      if (frame.type === "log.synced") {
        return frame.aggregateID === id &&
          frame.seq !== undefined &&
          frame.seq >= cursor
          ? "synced"
          : undefined;
      }

      const seq = boundarySeq(frame);

      if (
        frame.durable.aggregateID !== id ||
        seq === undefined ||
        seq <= cursor
      ) {
        continue;
      }

      if (frame.type === "session.execution.started") {
        return { kind: "start", seq };
      }

      if (isSettled(frame.type)) {
        return { kind: "settled", seq, outcome: outcomes[frame.type] };
      }
    }
  } catch {
    // No verified terminal outcome or continuation across the gap.
  }

  return;
}

export type NativeActivityObservation = {
  parent(sessionID: string, signal: AbortSignal): Promise<string | undefined>;
  active(signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  log(
    sessionID: string,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionLogItem>;
};

export function nativeActivityReads(
  client: OpenCodeClient,
): NativeActivityObservation {
  return {
    parent: async (id, signal) =>
      (await client.session.get({ sessionID: id }, { signal })).parentID,
    active: (signal) => client.session.active({ signal }),
    log: (sessionID, after, signal) =>
      client.experimental.session.log(
        { sessionID, after, follow: false },
        { signal },
      ),
  };
}

export async function reconcileActivity(
  source: NativeActivityObservation,
  sessions: readonly { id: string; cursor: number | undefined }[],
  lifetime: AbortSignal,
) {
  // Sample activity first. A later log read checks whether that sample is stale.
  const active: Readonly<Record<string, unknown>> = await source
    .active(AbortSignal.any([lifetime, AbortSignal.timeout(activityReadMs)]))
    .catch(() => ({}));

  const boundaries: Awaited<ReturnType<typeof readActivityBoundary>>[] = [];

  // Page across all tracked sessions, limiting concurrent reads per page.
  for (
    let at = 0;
    at < sessions.length && !lifetime.aborted;
    at += activityMaxReads
  ) {
    const signal = AbortSignal.any([
      lifetime,
      AbortSignal.timeout(activityReadMs),
    ]);

    const page = await Promise.all(
      sessions
        .slice(at, at + activityMaxReads)
        .map((session) =>
          readActivityBoundary(
            (...args) => source.log(...args),
            session,
            signal,
          ),
        ),
    );

    boundaries.push(...page);
  }

  return boundaries.map((result, index) => {
    if (result !== "synced") {
      return result;
    }

    const id = sessions[index]?.id;

    const status =
      id !== undefined && Object.hasOwn(active, id) ? active[id] : undefined;

    return typeof status === "object" &&
      status !== null &&
      "type" in status &&
      status.type === "running"
      ? ("running" as const)
      : undefined;
  });
}

/** Only keep enough metadata to recover omitted durable frames, never their payloads. */
export class ActivityReplayGap {
  public readonly slots = new Map<number, GapSlot>();
  public incomplete = false;

  public omit(slot: Omit<GapSlot, "seq">, seq: number | undefined) {
    if (seq === undefined || this.slots.size >= maxActivityGapSlots) {
      this.incomplete = true;
    } else if (!this.slots.has(seq)) {
      this.slots.set(seq, { ...slot, seq });
    }
  }

  /** Read only the missing slots and hand off each payload before loading another. */
  public async recover(
    read: (after: number) => AsyncIterable<SessionLogItem>,
    signal: AbortSignal,
    apply: (event: SessionLogItem, slot: GapSlot) => boolean,
  ) {
    if (this.slots.size === 0) {
      return !this.incomplete;
    }

    const after = Math.min(...this.slots.keys()) - 1;
    let count = 0;

    try {
      for await (const frame of read(after)) {
        if (
          signal.aborted ||
          frame.type === "log.synced" ||
          ++count > maxLogFrames
        ) {
          break;
        }

        const slot = this.slots.get(frame.durable.seq);

        if (slot && frame.type === slot.type && apply(frame, slot)) {
          this.slots.delete(slot.seq);

          if (this.slots.size === 0) {
            break;
          }
        }
      }
    } catch {
      return false;
    }

    return !signal.aborted && !this.incomplete && this.slots.size === 0;
  }
}

export function beforeActivityBoundary(
  cursor: number | undefined,
  event: unknown,
) {
  const seq = boundarySeq(event);

  return seq !== undefined && cursor !== undefined && seq <= cursor;
}

export function markActivityGap(
  log: TurnActivityLog,
  at: number,
  text = "Some early activity frames could not be recovered.",
) {
  log.update(`activity:unavailable:${text}`, at, () => ({
    kind: "text",
    status: "completed",
    text,
    unavailable: ["activity.frames"],
  }));
}

/** Merge each recovered payload before later live packets without retaining the payload. */
export async function recoverFrames<Packet extends { order: number }>(
  frames: readonly Packet[],
  gap: ActivityReplayGap,
  read: (after: number) => AsyncIterable<SessionLogItem>,
  signal: AbortSignal,
  restore: (event: SessionLogItem, slot: GapSlot) => Packet | undefined,
  replay: (packet: Packet) => void,
) {
  let index = 0;
  let through = 0;

  const complete = await gap.recover(read, signal, (event, slot) => {
    const packet = slot.order > through ? restore(event, slot) : undefined;

    if (!packet) {
      return false;
    }

    for (const live of frames.slice(index)) {
      if (live.order >= slot.order) {
        break;
      }

      replay(live);
      index += 1;
    }

    replay(packet);
    through = slot.order;

    return true;
  });

  return { complete, index };
}
