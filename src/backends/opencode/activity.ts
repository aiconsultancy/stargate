import { setTimeout as delay } from "node:timers/promises";
import type {
  ActivityOutcome,
  ActivityRequest,
  TurnActivityLog,
  TurnActivityRecorder,
} from "../backend";
import {
  OpenCodeActivityFamilies,
  isActivityEvent,
  subscribeActivityFamily,
} from "./activity-family";
import { type ActivityEvent, ActivityProjector } from "./activity-projector";
import type { OpenCodeTurnObserver } from "./opencode";

type Event = ActivityEvent;

type Source = Parameters<OpenCodeTurnObserver>[0];

type Packet = { event: Event; at: number; order: number };

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
  private readonly held = new Map<string, Packet[]>();
  private readonly projector = new ActivityProjector();

  public constructor(
    private readonly recorder: TurnActivityRecorder,
    private readonly source: Source,
    private readonly families: OpenCodeActivityFamilies,
    private readonly detach: () => void,
  ) {}

  public shutdown() {
    this.stop.abort();
    this.detach();
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

      this.log = this.recorder.begin(requests, this.source.sessionID);
      this.families.track(this.source.sessionID, this.log);
    }
  }

  public end(outcome: ActivityOutcome) {
    if (this.ended) {
      return;
    }

    this.ended = true;
    const log = this.log;

    if (!log) {
      this.shutdown();

      return;
    }

    this.families.settled(this.source.sessionID, log);
    log.end(outcome);
    void this.settle();
  }

  private async settle() {
    await delay(settleGraceMs, undefined, { signal: this.stop.signal }).catch(
      () => {},
    );
    // Open ownership checks make one final read against settled history.
    this.shutdown();
  }

  public reconnected() {
    this.log?.reconnected();
  }

  public receive(packet: Packet) {
    const { event } = packet;

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

    if (owner === "owned") {
      this.apply(packet);

      return;
    }

    const held = this.held.get(assistant) ?? [];
    held.push(packet);
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
        .owns(
          assistant,
          input,
          AbortSignal.any([
            this.source.lifetime,
            AbortSignal.timeout(ownershipReadMs),
          ]),
        )
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
      for (const packet of held) {
        this.apply(packet);
      }
    }
  }

  private apply({ event, at, order }: Packet) {
    if (this.log && !this.source.lifetime.aborted) {
      this.projector.apply(this.log, event, at);
      this.families.owned(this.log, event, order);
    }
  }
}

/** A single subscription per backend, not per child or prompt. */
class OfficerActivity {
  private readonly turns = new Set<TurnCollector>();
  private readonly families: OpenCodeActivityFamilies;

  public constructor(
    private readonly source: Pick<
      Source,
      "events" | "lifetime" | "parent" | "active" | "log"
    >,
  ) {
    this.families = new OpenCodeActivityFamilies({
      signal: source.lifetime,
      parent: (id, signal) => source.parent(id, signal),
      active: (signal) => source.active(signal),
      log: (sessionID, after, signal) =>
        source.log({ sessionID, after, follow: false }, { signal }),
    });
    source.lifetime.addEventListener(
      "abort",
      () => {
        for (const turn of this.turns) {
          turn.shutdown();
        }
      },
      { once: true },
    );
    void this.consume();
  }

  public turn(recorder: TurnActivityRecorder, source: Source) {
    const collector = new TurnCollector(recorder, source, this.families, () => {
      this.turns.delete(collector);
    });

    this.turns.add(collector);

    return collector;
  }

  private async consume() {
    const signal = this.source.lifetime;
    let retry = 250;
    let connections = 0;

    while (!signal.aborted) {
      try {
        for await (const event of subscribeActivityFamily(
          this.source.events,
          signal,
        )) {
          if (event.type === "server.connected") {
            if (++connections > 1) {
              for (const turn of this.turns) {
                turn.reconnected();
              }

              await this.families.reconnected();
            }

            retry = 250;
            continue;
          }

          const at = Date.now();
          const order = this.families.receive(event, at);

          if (isActivityEvent(event)) {
            for (const turn of this.turns) {
              turn.receive({ event, at, order });
            }
          }
        }
      } catch {
        // Reattach below without changing reply or progress collection.
      }

      await delay(retry, undefined, { signal, ref: false }).catch(() => {});
      retry = Math.min(retry * 2, 10_000);
    }
  }
}

/** Adapts a registration's activity recorder to OpenCode prompt turns. */
export function openCodeTurnObserver(
  recorder: TurnActivityRecorder,
): OpenCodeTurnObserver {
  const backends = new WeakMap<AbortSignal, OfficerActivity>();

  return (source) => {
    let backend = backends.get(source.lifetime);

    if (!backend) {
      const { events, lifetime } = source;
      backend = new OfficerActivity({
        events,
        lifetime,
        parent: source.parent,
        active: source.active,
        log: source.log,
      });
      backends.set(source.lifetime, backend);
    }

    const collector = backend.turn(recorder, source);

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
