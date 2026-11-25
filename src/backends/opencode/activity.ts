import { setTimeout as delay } from "node:timers/promises";
import type { OpenCodeClient } from "@opencode/client";
import type {
  ActivityError,
  ActivityItem,
  ActivityOutcome,
  ActivityRequest,
  TurnActivityLog,
  TurnActivityRecorder,
} from "../backend";
import type { OpenCodeTurnObserver } from "./opencode";

const activityEvents = [
  "session.step.started",
  "session.step.first-token",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
] as const;

const subscribe = (events: OpenCodeClient["event"], signal: AbortSignal) =>
  events.subscribe({ types: activityEvents, signal });

type Frame =
  ReturnType<typeof subscribe> extends AsyncIterable<infer F> ? F : never;

type Event = Exclude<Frame, { type: "server.connected" }>;

type Source = Parameters<OpenCodeTurnObserver>[0];

/** Trailing frames can follow the idle signal on the shared stream. */
export const settleGraceMs = 500;
const ownershipRetryMs = 250;
const ownershipRetryMaxMs = 10_000;
const ownershipReadMs = 10_000;

function activityError(error: {
  type: string;
  message: string;
  status?: number | undefined;
  response?: { body: string } | undefined;
  retryAfterMs?: number | undefined;
}): ActivityError {
  return {
    type: error.type,
    message: error.message,
    status: error.status ?? null,
    responseBody: error.response?.body ?? null,
    retryAfterMs: error.retryAfterMs ?? null,
  };
}

const tool = (callId: string): ActivityItem => ({
  kind: "tool",
  callId,
  name: null,
  status: "input",
  rawInput: "",
  input: null,
  executed: null,
  metadata: null,
  content: null,
  error: null,
});

const step = (): ActivityItem => ({
  kind: "step",
  status: "running",
  model: null,
  firstTokenAt: null,
  streamedAt: null,
  endedAt: null,
  finish: null,
  tokens: null,
  cost: null,
  error: null,
});

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
  /** Assistant message -> current step key; a message can hold several. */
  private readonly steps = new Map<string, { key: string; count: number }>();

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
        for await (const frame of subscribe(
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

  private stepKey(assistant: string, start: boolean) {
    let current = this.steps.get(assistant);

    if (!current || start) {
      const count = (current?.count ?? 0) + 1;
      current = { key: `step:${assistant}:${count}`, count };
      this.steps.set(assistant, current);
    }

    return current.key;
  }

  private apply(event: Event, now: number) {
    const log = this.log;

    if (!log) {
      return;
    }

    const assistant = event.data.assistantMessageID;

    switch (event.type) {
      case "session.step.started": {
        const { model } = event.data;

        log.update(this.stepKey(assistant, true), now, step, (item) => {
          if (item.kind === "step") {
            item.model = {
              provider: model.providerID,
              id: model.id,
              variant: model.variant ?? null,
            };
          }
        });

        return;
      }

      case "session.step.first-token":
      case "session.step.streamed":
      case "session.step.ended":
      case "session.step.failed": {
        log.update(this.stepKey(assistant, false), now, step, (item) => {
          if (item.kind !== "step") {
            return;
          }

          if (event.type === "session.step.first-token") {
            item.firstTokenAt = now;
          } else if (event.type === "session.step.streamed") {
            item.streamedAt = now;
          } else {
            const { data } = event;
            item.status =
              event.type === "session.step.ended" ? "completed" : "failed";
            item.endedAt = now;
            item.finish = data.finish ?? data.rawFinish ?? null;
            item.cost = data.cost ?? null;
            item.tokens = data.tokens
              ? {
                  input: data.tokens.input,
                  output: data.tokens.output,
                  reasoning: data.tokens.reasoning,
                  cacheRead: data.tokens.cache.read,
                  cacheWrite: data.tokens.cache.write,
                }
              : null;

            if (event.type === "session.step.failed") {
              item.error = activityError(event.data.error);
            }
          }
        });

        return;
      }

      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended": {
        const kind = event.type.startsWith("session.text.")
          ? "text"
          : "reasoning";

        log.update(
          `${kind}:${assistant}:${event.data.ordinal}`,
          now,
          () => ({ kind, status: "streaming", text: "" }),
          (item) => {
            if (item.kind !== "text" && item.kind !== "reasoning") {
              return;
            }

            if (
              event.type === "session.text.delta" ||
              event.type === "session.reasoning.delta"
            ) {
              item.text += event.data.delta;
            } else if (
              event.type === "session.text.ended" ||
              event.type === "session.reasoning.ended"
            ) {
              item.text = event.data.text;
              item.status = "completed";
            }
          },
        );

        return;
      }

      default:
        this.applyTool(log, event, now);
    }
  }

  private applyTool(log: TurnActivityLog, event: Event, now: number) {
    if (!event.type.startsWith("session.tool.") || !("id" in event.data)) {
      return;
    }

    const callId = event.data.id;

    log.update(
      `tool:${event.data.assistantMessageID}:${callId}`,
      now,
      () => tool(callId),
      (item) => {
        if (item.kind !== "tool") {
          return;
        }

        switch (event.type) {
          case "session.tool.input.started":
            item.name = event.data.name;
            break;
          case "session.tool.input.delta":
            item.rawInput += event.data.delta;
            break;
          case "session.tool.input.ended":
            item.rawInput = event.data.text;
            break;
          case "session.tool.called":
            item.input = event.data.input;
            item.executed = event.data.executed;
            item.status = "running";
            break;
          case "session.tool.progress":
            item.metadata = event.data.metadata;
            break;
          case "session.tool.success":
          case "session.tool.failed":
            item.status =
              event.type === "session.tool.success" ? "completed" : "failed";
            item.executed = event.data.executed;
            item.metadata = event.data.metadata ?? item.metadata;
            item.content =
              event.data.content?.map((part) =>
                part.type === "text"
                  ? { type: "text", text: part.text }
                  : {
                      type: "file",
                      uri: part.uri,
                      mime: part.mime,
                      name: part.name ?? null,
                    },
              ) ?? null;

            if (event.type === "session.tool.failed") {
              item.error = activityError(event.data.error);
            }

            break;
          default:
        }
      },
    );
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
