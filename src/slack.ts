import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient, type WebClientOptions } from "@slack/web-api";
import type { Logger } from "pino";
import type { ActivityView } from "./activity";
import { activityContent } from "./activity-slack";
import { stopBlock } from "./cancellation";
import type { CronUIApi } from "./cron-ui";
import type { SlackDelivery } from "./gateway";
import type { ReactionName } from "./reactions";
import { failureContent, type RequestFailure } from "./request-failure";
import type { Identity } from "./routing";
import { slackContent } from "./slack-format";
import { loadThreadContext, type ThreadContextRequest } from "./thread-context";

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

export interface SlackInteractions {
  command(body: unknown, ack: SocketRequest["ack"]): Promise<void>;
  interactive(body: unknown, ack: SocketRequest["ack"]): Promise<void>;
}

/** Socket Mode's generic event includes commands too; acknowledge each only once. */
export async function handleSlackRequest(
  request: SocketRequest,
  accept: (body: unknown) => boolean,
  log: Logger,
  interactions?: SlackInteractions,
) {
  try {
    if (request.type === "slash_commands" && interactions) {
      await interactions.command(request.body, request.ack);
    } else if (request.type === "interactive" && interactions) {
      await interactions.interactive(request.body, request.ack);
    } else {
      if (request.type === "events_api") accept(request.body);
      await request.ack();
    }
  } catch {
    log.error("Could not handle or acknowledge Slack request");
  }
}

export class SlackConnection implements SlackDelivery {
  private readonly socket;
  private readonly web;
  private readonly historyWeb: (signal: AbortSignal) => WebClient;
  constructor(
    appToken: string,
    botToken: string,
    log: Logger,
    webOptions: Pick<WebClientOptions, "slackApiUrl" | "fetch"> = {},
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
    // token/options, without leaking cancellation through its shared queue.
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
    this.socket = new SocketModeClient({
      appToken,
      logger,
      clientOptions: options,
    });
  }

  async identity(): Promise<Identity> {
    const auth = await this.web.auth.test();
    if (!auth.team_id || !auth.user_id || !auth.bot_id)
      throw new Error("Slack requires a workspace bot token");
    return { team: auth.team_id, user: auth.user_id };
  }

  async threadContext(input: ThreadContextRequest) {
    return loadThreadContext(input, (args) =>
      this.historyWeb(input.signal).conversations.replies(args),
    );
  }

  async start(
    accept: (body: unknown) => boolean,
    log: Logger,
    interactions?: SlackInteractions,
  ) {
    this.socket.on("slack_event", async (request: SocketRequest) => {
      // handleSlackRequest catches errors without exposing SDK payloads.
      await handleSlackRequest(request, accept, log, interactions);
    });
    this.socket.on("error", () => log.error("Slack socket error"));
    await this.socket.start();
  }

  private async send(
    channel: string,
    thread: string,
    text: string,
    format: "markdown" | "plain",
    stopJob?: number,
  ) {
    const content = slackContent(text, format);
    const result = await this.web.chat.postMessage({
      channel,
      ...(thread ? { thread_ts: thread } : {}),
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
    if (!result.ts) throw new Error("Slack did not return a message timestamp");
    return result.ts;
  }

  async post(channel: string, thread: string, text: string, stopJob?: number) {
    return this.send(channel, thread, text, "markdown", stopJob);
  }

  async announce(channel: string, text: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.send(channel, "", text, "plain");
  }

  async failure(
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
      if (!result.ts)
        throw new Error("Slack did not return a message timestamp");
      return result.ts;
    } catch (error) {
      if (ts !== undefined && slackError(error, "message_not_found"))
        return false;
      throw error;
    }
  }

  async activity(
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
    if (!result.ts) throw new Error("Slack did not return a message timestamp");
    return result.ts;
  }

  readonly cronUI: CronUIApi = {
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

  async update(channel: string, ts: string, text: string, stopJob?: number) {
    try {
      const content = slackContent(text);
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
      if (slackError(error, "message_not_found")) return false;
      throw error;
    }
  }

  async remove(channel: string, ts: string) {
    try {
      await this.web.chat.delete({ channel, ts });
    } catch (error) {
      // Retrying a confirmed or ambiguous delete must remain safe.
      if (!slackError(error, "message_not_found")) throw error;
    }
  }

  async react(channel: string, timestamp: string, name: ReactionName) {
    try {
      await this.web.reactions.add({ channel, timestamp, name });
    } catch (error) {
      if (!slackError(error, "already_reacted")) throw error;
    }
  }

  async close() {
    await this.socket.disconnect();
  }
}
