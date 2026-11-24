import { Predicate } from "effect";
import { slackContent } from "../../shared/slack-format";
import { type SlackRegistration, bindingAllowed } from "./binding";
import type { NotifyConfig } from "./config";
import type { Destination, DisplayPayload } from "./model";
import type { NotificationSink, SinkOutcome } from "./sink";

export function notificationContent(payload: DisplayPayload) {
  const sections = [payload.title, payload.body, payload.url].filter(
    (text): text is string => text !== undefined && text.length > 0,
  );

  // Bound UTF-16 too, without splitting a code point. All fields remain intact.
  const blocks = sections.flatMap((text) => {
    const parts: string[] = [];
    let part = "";

    for (const point of text) {
      if (part.length + point.length > 2800) {
        parts.push(part);
        part = "";
      }

      part += point;
    }

    if (part) {
      parts.push(part);
    }

    return parts.map((text) => ({
      type: "section" as const,
      text: { type: "plain_text" as const, text, emoji: false },
    }));
  });

  return {
    text: slackContent(sections.join("\n\n"), "plain").text,
    blocks,
  };
}

const permanent = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "account_inactive",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "restricted_action",
  "no_permission",
  "msg_too_long",
  "invalid_blocks",
  "invalid_arguments",
  "no_text",
]);

export function notificationOutcome(error: unknown): SinkOutcome {
  if (!Predicate.isObject(error)) {
    return { state: "unknown" };
  }

  if (
    error["code"] === "slack_webapi_rate_limited_error" &&
    typeof error["retryAfter"] === "number" &&
    Number.isFinite(error["retryAfter"]) &&
    error["retryAfter"] >= 0
  ) {
    return {
      state: "refused",
      retryable: true,
      retryAfterMs: error["retryAfter"] * 1000,
    };
  }

  const data = error["data"];

  if (
    error["code"] === "slack_webapi_platform_error" &&
    Predicate.isObject(data) &&
    typeof data["error"] === "string" &&
    permanent.has(data["error"])
  ) {
    return { state: "refused", retryable: false };
  }

  return { state: "unknown" };
}

export interface NotificationSlack {
  notification(
    channel: string,
    payload: DisplayPayload,
    signal: AbortSignal,
  ): Promise<SinkOutcome>;
}

export function slackNotificationSink(options: {
  current(): {
    notify: NotifyConfig | undefined;
    registrations: readonly SlackRegistration[];
  };
  admitted: Readonly<Record<string, Destination>>;
  connections: ReadonlyMap<string, NotificationSlack>;
}): NotificationSink {
  const allowed: NotificationSink["allowed"] = (destination) => {
    const current = options.current();

    return bindingAllowed(
      destination,
      current.notify,
      current.registrations,
      options.admitted,
    );
  };

  return {
    allowed,
    async send(destination, payload, signal) {
      // No await between the CURRENT policy snapshot and the physical dispatch.
      if (!allowed(destination)) {
        return { state: "refused", retryable: false };
      }

      const connection = options.connections.get(destination.registrationId);

      if (!connection) {
        return { state: "refused", retryable: false };
      }

      return connection.notification(destination.channel, payload, signal);
    },
  };
}
