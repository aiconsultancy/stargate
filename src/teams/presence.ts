import { setTimeout as delay } from "node:timers/promises";
import type { TurnProgress } from "../shared/turn-progress";
import { waitingPhrase } from "../shared/waiting";
import { type WaitingSettings } from "../config/waiting";
import { type OutgoingActivity, isDefiniteRefusal } from "./connector";

type Send = (
  activity: OutgoingActivity,
  signal: AbortSignal,
) => Promise<{ id?: string }>;

type Slot = { anchor: string; id?: string; expires: number };

/** Resolved waiting settings and the bot's display name for one turn. */
export type TeamsWaiting = WaitingSettings & { name: string };

type Label = { text: string; generic: boolean };

function label(progress?: TurnProgress): Label {
  if (progress && "disconnected" in progress && progress.disconnected)
    return { text: "Connection interrupted", generic: false };
  const stage: string | undefined = progress?.stage;

  switch (stage) {
    case "reasoning":
      return { text: "Thinking", generic: true };
    case "tool":
      return { text: "Using a tool", generic: false };
    case "reply":
      return { text: "Writing a reply", generic: false };
    case "queued":
      return { text: "Queued", generic: false };
    case "submitting":
      return { text: "Waiting for confirmation", generic: false };
    case "retry":
      return { text: "Waiting to retry", generic: false };
    case "waiting":
      return { text: "Waiting for an answer", generic: false };
    default:
      return { text: "Working", generic: true };
  }
}

/** Short-lived UI state. The durable reply stays with the gateway. */
export class TeamsPresence {
  private readonly slots = new Map<string, Slot>();
  public constructor(private readonly refreshMs = 3000) {}
  public async working(
    channel: string,
    anchor: string,
    signal: AbortSignal,
    allowed: () => boolean,
    read: () => TurnProgress | undefined,
    send: Send,
    waiting?: TeamsWaiting,
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

    let sequence = 0;
    let previous = "";
    let informative = !!slot;

    const deadline = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);

    // As on IRC, strip control characters. Config names are bounded but an
    // OpenCode agent ID fallback is not, so keep every phrase well inside
    // Teams' 1,000-character informative limit.
    const name =
      waiting &&
      (Array.from(waiting.name.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " "))
        .slice(0, 100)
        .join("")
        .trim() ||
        undefined);

    let phrase = 0;
    let phraseShownAt: number | undefined;

    while (!deadline.aborted && allowed()) {
      const stage = label(read());
      let text = stage.text;
      const at = Date.now();

      // Only the generic stages rotate, and only on this refresh loop, so a
      // Phrase change never adds a request beyond the existing cadence.
      if (
        waiting &&
        name !== undefined &&
        waiting.delayMs !== null &&
        stage.generic &&
        at - now >= waiting.delayMs
      ) {
        if (
          phraseShownAt !== undefined &&
          at - phraseShownAt >= waiting.intervalMs
        ) {
          phrase++;
          phraseShownAt = undefined;
        }

        text = waitingPhrase(name, phrase);
      }

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
                  ...(slot.id && { streamId: slot.id }),
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

          if (text !== stage.text) phraseShownAt ??= Date.now();
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
        ].includes(stage.text)
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
  public async final(
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
