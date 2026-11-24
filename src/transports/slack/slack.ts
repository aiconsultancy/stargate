import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient, type WebClientOptions } from "@slack/web-api";
import type { ViewsOpenArguments } from "@slack/web-api";
import { Result, Schema } from "effect";
import type { Logger } from "pino";
import type { ActivityView } from "../../chat/activity/activity";
import { activityContent } from "../../chat/activity/activity-slack";
import type { CrewUIApi } from "./crew-ui";
import type {
  ReactionTargetRequest,
  TransportDelivery,
} from "../../gateway/ports";
import type { DisplayPayload } from "../../notifications/ingest/model";
import type { SinkOutcome } from "../../notifications/ingest/sink";
import {
  notificationContent,
  notificationOutcome,
} from "../../notifications/ingest/slack";
import { type ReactionName, slackTimestamp } from "../../shared/reactions";
import {
  type RequestFailure,
  failureContent,
} from "../../shared/request-failure";
import type { Identity } from "../../gateway/routing";
import { SlackSocket, retrySlack } from "./slack-connection";
import { SlackFiles, type SlackFilesFetch } from "./slack-files";
import {
  type SlackContent,
  prepareSlackReply,
  slackContent,
} from "../../shared/slack-format";
import {
  type ThreadContextRequest,
  loadThreadContext,
} from "../../gateway/thread-context";

type ModalView = Extract<ViewsOpenArguments["view"], { type: "modal" }>;

function slackError(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "error" in error.data &&
    error.data.error === code
  );
}

export type SocketRequest = {
  type: string;
  body: unknown;
  ack: (payload?: Record<string, unknown>) => Promise<void>;
};

const reactionTargetSchema = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("message"),
  channel: Schema.String,
  message: Schema.Struct({
    type: Schema.Literal("message"),
    ts: slackTimestamp,
    thread_ts: Schema.optional(slackTimestamp),
    user: Schema.String,
    team: Schema.optional(Schema.String),
    channel: Schema.optional(Schema.String),
    app_id: Schema.optional(Schema.String),
    parent_user_id: Schema.optional(Schema.String),
    hidden: Schema.optional(Schema.Literal(false)),
  }),
});

export interface SlackInteractions {
  command(body: unknown, ack: SocketRequest["ack"]): Promise<void>;
  interactive(body: unknown, ack: SocketRequest["ack"]): Promise<void>;
}

/**
 * Socket Mode's generic event includes commands too; acknowledge each only
 * once. While intake is closed, nothing is acknowledged: Slack redelivers the
 * request to the next connection instead of losing an unpersisted event.
 */
export async function handleSlackRequest(
  request: SocketRequest,
  accept: (body: unknown) => boolean | Promise<boolean>,
  log: Logger,
  interactions?: SlackInteractions,
  open: () => boolean = () => true,
) {
  if (!open()) {
    return;
  }

  try {
    if (request.type === "slash_commands" && interactions) {
      await interactions.command(request.body, request.ack);

      return;
    }

    if (request.type === "interactive" && interactions) {
      await interactions.interactive(request.body, request.ack);

      return;
    }

    if (request.type === "events_api") {
      await accept(request.body);

      // Slack redelivers if intake closed while it waited.
      // The event ID deduplicates any stored copy.
      if (!open()) {
        return;
      }
    }

    await request.ack();
  } catch {
    log.error("Could not handle or acknowledge Slack request");
  }
}

export class SlackConnection implements TransportDelivery {
  public readonly files: SlackFiles;
  private readonly socket;
  private readonly web;
  private readonly historyWeb: (signal: AbortSignal) => WebClient;
  private handle?: (request: SocketRequest) => Promise<void>;
  private closing: Promise<void> | undefined;
  public constructor(
    appToken: string,
    botToken: string,
    log: Logger,
    webOptions: Pick<WebClientOptions, "slackApiUrl" | "fetch"> = {},
    fileFetch?: SlackFilesFetch,
  ) {
    // Third-party errors can contain request headers/bodies. Do not log them.
    const logger = {
      debug() {},
      info() {},
      warn() {
        log.warn("Slack client warning");
      },
      error() {
        log.error("Slack client error");
      },
      setLevel() {},
      setName() {},
      getLevel() {
        return LogLevel.ERROR;
      },
    };

    const options = {
      logger,
      timeout: 15_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    };

    this.web = new WebClient(botToken, { ...webOptions, ...options });
    // SDK v8 has no per-method signal. A request-scoped client uses the same
    // Token/options, without leaking cancellation through its shared queue.
    this.historyWeb = (signal) =>
      new WebClient(botToken, {
        ...webOptions,
        ...options,
        fetch: (url, init) =>
          (webOptions.fetch ?? globalThis.fetch)(url, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([signal, init.signal])
              : signal,
          }),
      });
    this.files = new SlackFiles(this.historyWeb, botToken, fileFetch);
    this.socket = new SlackSocket(() => {
      const socket = new SocketModeClient({
        appToken,
        logger,
        clientOptions: options,
        autoReconnectEnabled: false,
      });

      socket.on("slack_event", (request: SocketRequest) => {
        void this.handle?.(request);
      });

      return socket;
    }, log);
  }

  /** Slack `users.info`; the caller parses the untrusted result. */
  public async userInfo(user: string, signal: AbortSignal): Promise<unknown> {
    return this.historyWeb(signal).users.info({ user });
  }

  /** Exact message lookup only; the event's item_user is not authorship proof. */
  public async reactionThread({
    channel,
    ts,
    appId,
    identity,
    signal,
  }: ReactionTargetRequest) {
    const result = Schema.decodeUnknownResult(reactionTargetSchema)(
      await this.historyWeb(signal).reactions.get({ channel, timestamp: ts }),
    );

    if (Result.isFailure(result) || result.success.channel !== channel) {
      return;
    }

    const message = result.success.message;

    if (
      message.ts !== ts ||
      message.user !== identity.user ||
      (message.team !== undefined && message.team !== identity.team) ||
      (message.channel !== undefined && message.channel !== channel) ||
      (message.parent_user_id !== undefined &&
        message.thread_ts === undefined) ||
      (message.app_id !== undefined && message.app_id !== appId)
    ) {
      return;
    }

    return message.thread_ts ?? message.ts;
  }

  public async identity(signal?: AbortSignal): Promise<Identity> {
    const auth = await retrySlack(() => this.web.auth.test(), signal);

    if (!auth.team_id || !auth.user_id || !auth.bot_id) {
      throw new Error("Slack requires a workspace bot token");
    }

    return { team: auth.team_id, user: auth.user_id };
  }

  public async threadContext(input: ThreadContextRequest) {
    return loadThreadContext(input, (args) =>
      this.historyWeb(input.signal).conversations.replies(args),
    );
  }

  public async start(
    accept: (body: unknown) => boolean | Promise<boolean>,
    log: Logger,
    interactions?: SlackInteractions,
    open?: () => boolean,
    signal?: AbortSignal,
  ) {
    this.handle = async (request: SocketRequest) => {
      // HandleSlackRequest catches errors without exposing SDK payloads.
      await handleSlackRequest(request, accept, log, interactions, open);
    };

    await this.socket.start(signal);
  }

  public get connectionState() {
    return this.socket.state;
  }
  public watch() {
    return this.socket.watch();
  }

  private async send(
    channel: string,
    thread: string,
    text: string,
    format: "markdown" | "plain",
    stopJob?: number,
    prepared?: SlackContent,
  ) {
    const content = prepared ?? slackContent(text, format);

    const result = await this.web.chat.postMessage({
      channel,
      ...(thread && { thread_ts: thread }),
      ...content,
      blocks: [
        ...content.blocks,
        ...(stopJob === undefined ? [] : [stopBlock(stopJob)]),
      ],
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    });

    if (!result.ts) {
      throw new Error("Slack did not return a message timestamp");
    }

    return result.ts;
  }

  public readonly prepareReply = prepareSlackReply;

  public async post(
    channel: string,
    thread: string,
    text: string,
    stopJob?: number,
    _unit?: { job: number; part: number },
    content?: SlackContent,
  ) {
    return this.send(channel, thread, text, "plain", stopJob, content);
  }

  public async announce(channel: string, text: string, signal?: AbortSignal) {
    signal?.throwIfAborted();

    return this.send(channel, "", text, "plain");
  }

  public async notification(
    channel: string,
    payload: DisplayPayload,
    signal: AbortSignal,
  ): Promise<SinkOutcome> {
    if (signal.aborted) {
      return { state: "refused", retryable: true };
    }

    try {
      const result = await this.historyWeb(signal).chat.postMessage({
        channel,
        ...notificationContent(payload),
        mrkdwn: false,
        parse: "none",
        unfurl_links: false,
        unfurl_media: false,
      });

      return result.ok === true &&
        typeof result.ts === "string" &&
        /^\d+\.\d+$/.test(result.ts)
        ? { state: "sent" }
        : { state: "unknown" };
    } catch (error) {
      return notificationOutcome(error);
    }
  }

  public async ephemeral(
    channel: string,
    user: string,
    thread: string,
    text: string,
  ) {
    await this.web.chat.postEphemeral({
      channel,
      user,
      thread_ts: thread,
      ...slackContent(text, "plain"),
      parse: "none",
    });
  }

  public async failure(
    channel: string,
    thread: string,
    cause: RequestFailure,
    ts?: string,
  ) {
    const content = {
      channel,
      ...failureContent(cause),
      parse: "none" as const,
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    };

    try {
      if (ts !== undefined) {
        await this.web.chat.update({ ...content, ts });

        return ts;
      }

      const result = await this.web.chat.postMessage({
        ...content,
        thread_ts: thread,
      });

      if (!result.ts) {
        throw new Error("Slack did not return a message timestamp");
      }

      return result.ts;
    } catch (error) {
      if (ts !== undefined && slackError(error, "message_not_found")) {
        return false;
      }

      throw error;
    }
  }

  public async activity(
    channel: string,
    thread: string,
    view: ActivityView,
    ts?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const web = signal ? this.historyWeb(signal) : this.web;

    const content = {
      channel,
      ...activityContent(view),
      parse: "none" as const,
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    };

    if (ts !== undefined) {
      // Missing/ambiguous updates must not create duplicate activity messages.
      await web.chat.update({ ...content, ts });

      return ts;
    }

    const result = await web.chat.postMessage({
      ...content,
      thread_ts: thread,
    });

    if (!result.ts) {
      throw new Error("Slack did not return a message timestamp");
    }

    return result.ts;
  }

  public readonly crewUI: CrewUIApi = {
    open: async (triggerId, view) => {
      const result = await this.web.views.open({ trigger_id: triggerId, view });

      if (!result.view?.id) {
        throw new Error("Slack did not return a view ID");
      }

      return result.view.id;
    },
    update: async (viewId, view) => {
      await this.web.views.update({ view_id: viewId, view });
    },
  };

  public readonly cronUI: {
    open(triggerId: string, view: ModalView): Promise<void>;
    push(triggerId: string, view: ModalView): Promise<void>;
    update(viewId: string, hash: string, view: ModalView): Promise<void>;
  } = {
    open: async (triggerId, view) => {
      await this.web.views.open({ trigger_id: triggerId, view });
    },
    push: async (triggerId, view) => {
      await this.web.views.push({ trigger_id: triggerId, view });
    },
    update: async (viewId, hash, view) => {
      await this.web.views.update({ view_id: viewId, hash, view });
    },
  };

  public async update(
    channel: string,
    ts: string,
    text: string,
    stopJob?: number,
    prepared?: SlackContent,
  ) {
    try {
      const content = prepared ?? slackContent(text, "plain");
      await this.web.chat.update({
        channel,
        ts,
        ...content,
        blocks: [
          ...content.blocks,
          ...(stopJob === undefined ? [] : [stopBlock(stopJob)]),
        ],
        parse: "none",
      });

      return true;
    } catch (error) {
      if (slackError(error, "message_not_found")) {
        return false;
      }

      throw error;
    }
  }

  public async remove(channel: string, ts: string) {
    try {
      await this.web.chat.delete({ channel, ts });
    } catch (error) {
      // Retrying a confirmed or ambiguous delete must remain safe.
      if (!slackError(error, "message_not_found")) {
        throw error;
      }
    }
  }

  public async react(channel: string, timestamp: string, name: ReactionName) {
    try {
      await this.web.reactions.add({ channel, timestamp, name });
    } catch (error) {
      if (!slackError(error, "already_reacted")) {
        throw error;
      }
    }
  }

  public async readReceipt(
    channel: string,
    timestamp: string,
    active: boolean,
  ) {
    const web = this.historyWeb(AbortSignal.timeout(1500));
    const args = { channel, timestamp, name: "eyes" };

    try {
      if (active) {
        await web.reactions.add(args);
      } else {
        await web.reactions.remove(args);
      }
    } catch (error) {
      if (!slackError(error, active ? "already_reacted" : "no_reaction")) {
        throw error;
      }
    }
  }

  /** Idempotent: a repeated SDK disconnect can wait for an event that never comes. */
  public close() {
    this.closing ??= this.socket.close();

    return this.closing;
  }
}

export function stopBlock(job: number) {
  return {
    type: "actions" as const,
    elements: [
      {
        type: "button" as const,
        action_id: "stargate_stop",
        text: { type: "plain_text" as const, text: "Stop", emoji: false },
        accessibility_label: "Stop this request (requester only)",
        value: String(job),
      },
    ],
  };
}
