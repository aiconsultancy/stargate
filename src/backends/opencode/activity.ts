import { setTimeout as delay } from "node:timers/promises";
import type {
  ActivityOutcome,
  ActivityRequest,
  TurnActivityLog,
  TurnActivityRecorder,
} from "../backend";
import {
  type ActivityEvent,
  ActivityProjector,
  subscribeActivity,
} from "./activity-projector";
import type { OpenCodeTurnObserver } from "./opencode";

type Event = ActivityEvent;

type Source = Parameters<OpenCodeTurnObserver>[0];

/** Trailing frames can follow the idle signal on the shared stream. */
export const settleGraceMs = 500;
const ownershipRetryMs = 250;
const ownershipRetryMaxMs = 10_000;
const ownershipReadMs = 10_000;

/**
 * Projects one officer turn's OpenCode frames into the backend-neutral item
 * model. Frames are held per assistant message until the prompt's own
 * placement proof assigns that message to the submitted input; a message
 * that belongs to another input is discarded unseen.
 */
class TurnCollector {
  private readonly stop = new AbortController();
  private log: TurnActivityLog | undefined;
  private input: string | undefined;
  private ended = false;

  private readonly owners = new Map<
    string,
    "checking" | "owned" | "excluded"
  >();
  private readonly held = new Map<string, { event: Event; at: number }[]>();
  private readonly projector = new ActivityProjector();

  public constructor(
    private readonly recorder: TurnActivityRecorder,
    private readonly source: Source,
  ) {
    void this.consume();
  }

  public submitted(input: string) {
    if (this.input === undefined && !this.ended) {
      this.input = input;
      let requests: readonly ActivityRequest[] | undefined;

      try {
        requests = this.source.requests?.();
      } catch {
        // An unavailable request link must not affect prompt submission.
      }

      this.log = this.recorder.begin(requests);
    }
  }

  public end(outcome: ActivityOutcome) {
    if (this.ended) {
      return;
    }

    this.ended = true;
    const log = this.log;

    if (!log) {
      this.stop.abort();

      return;
    }

    log.end(outcome);
    void this.settle();
  }

  private async settle() {
    await delay(settleGraceMs);
    // Open ownership checks make one final read against settled history.
    this.stop.abort();
  }

  private async consume() {
    let retryMs = 250;
    let connections = 0;

    while (!this.stop.signal.aborted) {
      try {
        for await (const frame of subscribeActivity(
          this.source.events,
          this.stop.signal,
        )) {
          if (frame.type === "server.connected") {
            if (++connections > 1) {
              this.log?.reconnected();
            }

            retryMs = 250;
            continue;
          }

          this.receive(frame);
        }
      } catch {
        /* Reattach below; the turn itself is unaffected. */
      }

      await delay(retryMs, undefined, { signal: this.stop.signal }).catch(
        () => {},
      );
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  }

  private receive(event: Event) {
    // Frames before submission cannot belong to this input.
    if (
      this.input === undefined ||
      event.data.sessionID !== this.source.sessionID
    ) {
      return;
    }

    const assistant = event.data.assistantMessageID;
    const owner = this.owners.get(assistant);

    if (owner === "excluded") {
      return;
    }

    const at = Date.now();

    if (owner === "owned") {
      this.apply(event, at);

      return;
    }

    const held = this.held.get(assistant) ?? [];
    held.push({ event, at });
    this.held.set(assistant, held);

    if (owner === undefined) {
      void this.check(assistant);
    }
  }

  private async check(assistant: string) {
    const input = this.input;

    if (input === undefined) {
      return;
    }

    this.owners.set(assistant, "checking");
    let retryMs = ownershipRetryMs;
    let final = false;

    for (;;) {
      // After the turn settled, one more read decides; unprovable stays hidden.
      final ||= this.stop.signal.aborted;

      const owned = await this.source
        .owns(assistant, input, AbortSignal.timeout(ownershipReadMs))
        .catch(() => null);

      if (typeof owned === "boolean" || final) {
        this.decide(assistant, owned === true);

        return;
      }

      await delay(retryMs, undefined, { signal: this.stop.signal }).catch(
        () => {},
      );
      retryMs = Math.min(retryMs * 2, ownershipRetryMaxMs);
    }
  }

  private decide(assistant: string, owned: boolean) {
    const held = this.held.get(assistant) ?? [];
    this.held.delete(assistant);
    this.owners.set(assistant, owned ? "owned" : "excluded");

    if (owned) {
      for (const { event, at } of held) {
        this.apply(event, at);
      }
    }
  }

  private apply(event: Event, now: number) {
    if (this.log) {
      this.projector.apply(this.log, event, now);
    }
  }
}

/** Adapts a registration's activity recorder to OpenCode prompt turns. */
export function openCodeTurnObserver(
  recorder: TurnActivityRecorder,
): OpenCodeTurnObserver {
  return (source) => {
    const collector = new TurnCollector(recorder, source);

    return {
      submitted: (input) => {
        collector.submitted(input);
      },
      end: (outcome) => {
        collector.end(outcome);
      },
    };
  };
}
