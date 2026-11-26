import type { SessionLogItem } from "@opencode/client";
import type { ActivityOutcome, TurnActivityLog } from "../backend";
import { boundarySeq } from "./crew-executions";

export type GapSlot = { order: number; at: number; type: string; seq: number };

export const maxActivityGapSlots = 256;
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
