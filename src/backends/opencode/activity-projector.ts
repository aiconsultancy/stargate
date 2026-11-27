import type { OpenCodeClient, SessionLogItem } from "@opencode/client";
import type { ActivityError, ActivityItem, TurnActivityLog } from "../backend";

export const activityEvents = [
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

export const subscribeActivity = (
  events: OpenCodeClient["event"],
  signal: AbortSignal,
) => events.subscribe({ types: activityEvents, signal });

export type ActivityFrame =
  ReturnType<typeof subscribeActivity> extends AsyncIterable<infer F>
    ? F
    : never;

export type ActivityEvent = Exclude<
  ActivityFrame,
  { type: "server.connected" }
>;

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

const itemEvents = new Set<string>(activityEvents);
const familyEvents = new Set<string>(activityFamilyEvents);

export const isFamilyLogItem = (
  event: SessionLogItem,
): event is Extract<SessionLogItem, ActivityFamilyEvent> =>
  familyEvents.has(event.type);

export const isActivityEvent = (
  event: ActivityFamilyEvent,
): event is ActivityEvent => itemEvents.has(event.type);

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

const childAttribution = "activity.child-attribution";

export function childAttributionMarker(
  log: TurnActivityLog,
  assistant: string,
  callId: string,
) {
  let marked = false;

  return (at: number, uncertain: boolean) => {
    if (marked === uncertain) {
      return;
    }

    marked = uncertain;
    log.update(
      `tool:${assistant}:${callId}`,
      at,
      () => tool(callId),
      (item) => {
        const other =
          item.unavailable?.filter((entry) => entry !== childAttribution) ?? [];

        if (uncertain) {
          other.push(childAttribution);
        }

        if (other.length > 0) {
          item.unavailable = other;
        } else {
          delete item.unavailable;
        }
      },
    );
  };
}

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
 * Projects OpenCode activity frames into the backend-neutral item model.
 * One instance per turn; it keeps the step numbering of each assistant
 * message. Shared by the officer observer and the crew collector.
 */
export class ActivityProjector {
  /** Assistant message -> current step key; a message can hold several. */
  private readonly steps = new Map<string, { key: string; count: number }>();

  private stepKey(assistant: string, start: boolean) {
    let current = this.steps.get(assistant);

    if (!current || start) {
      const count = (current?.count ?? 0) + 1;
      current = { key: `step:${assistant}:${count}`, count };
      this.steps.set(assistant, current);
    }

    return current.key;
  }

  public apply(log: TurnActivityLog, event: ActivityEvent, now: number) {
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

  private applyTool(log: TurnActivityLog, event: ActivityEvent, now: number) {
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
