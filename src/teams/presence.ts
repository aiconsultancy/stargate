import { setTimeout as delay } from "node:timers/promises";
import type { TurnProgress } from "../turn-progress";
import { isDefiniteRefusal, type OutgoingActivity } from "./connector";

type Send = (
  activity: OutgoingActivity,
  signal: AbortSignal,
) => Promise<{ id?: string }>;
type Slot = { anchor: string; id?: string; expires: number };
function label(progress?: TurnProgress) {
  if (progress && "disconnected" in progress && progress.disconnected === true)
    return "Connection interrupted";
  const stage: string | undefined = progress?.stage;
  switch (stage) {
    case "reasoning":
      return "Thinking";
    case "tool":
      return "Using a tool";
    case "reply":
      return "Writing a reply";
    case "queued":
      return "Queued";
    case "submitting":
      return "Waiting for confirmation";
    case "retry":
      return "Waiting to retry";
    case "waiting":
      return "Waiting for an answer";
    default:
      return "Working";
  }
}

/** Short-lived UI state. The durable reply stays with the gateway. */
export class TeamsPresence {
  private readonly slots = new Map<string, Slot>();
  constructor(private readonly refreshMs = 3000) {}
  async working(
    channel: string,
    anchor: string,
    signal: AbortSignal,
    allowed: () => boolean,
    read: () => TurnProgress | undefined,
    send: Send,
  ) {
    if (signal.aborted || !allowed()) return;
    const now = Date.now();
    for (const [key, item] of this.slots)
      if (item.expires <= now) this.slots.delete(key);
    const slot =
      !this.slots.has(channel) && this.slots.size < 200
        ? ({ anchor, expires: now + 600_000 } as Slot)
        : undefined;
    if (slot) this.slots.set(channel, slot);
    let sequence = 0,
      previous = "",
      informative = !!slot;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
    while (!deadline.aborted && allowed()) {
      const text = label(read());
      if (informative && text !== previous && slot) {
        try {
          const response = await send(
            {
              type: "typing",
              text,
              replyToId: anchor,
              entities: [
                {
                  type: "streamInfo",
                  streamType: "informative",
                  streamSequence: ++sequence,
                  ...(slot.id ? { streamId: slot.id } : {}),
                },
              ],
            },
            deadline,
          );
          if (sequence === 1) {
            if (
              !response.id ||
              response.id.length > 512 ||
              /[\p{Cc}\p{Cf}]/u.test(response.id)
            )
              throw new Error("Stream ID unavailable");
            slot.id = response.id;
          }
          previous = text;
        } catch {
          informative = false;
        }
      }
      if (
        !deadline.aborted &&
        allowed() &&
        ![
          "Queued",
          "Waiting for confirmation",
          "Waiting for an answer",
          "Waiting to retry",
          "Connection interrupted",
        ].includes(text)
      )
        await send({ type: "typing", replyToId: anchor }, deadline).catch(
          () => {},
        );
      await delay(this.refreshMs, undefined, { signal: deadline }).catch(
        () => {},
      );
    }
  }

  /** The ordinary first text reply closes its own stream. A definite refusal
   * permits ordinary delivery. An uncertain send follows normal gateway recovery. */
  async final(
    channel: string,
    anchor: string,
    activity: OutgoingActivity,
    signal: AbortSignal,
    send: Send,
  ) {
    const slot = this.slots.get(channel);
    if (!slot?.id || slot.anchor !== anchor || slot.expires <= Date.now())
      return;
    this.slots.delete(channel);
    try {
      return await send(
        {
          ...activity,
          replyToId: anchor,
          entities: [
            { type: "streamInfo", streamType: "final", streamId: slot.id },
          ],
        },
        signal,
      );
    } catch (error) {
      if (!isDefiniteRefusal(error)) throw error;
      return;
    }
  }
}
