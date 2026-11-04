import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import type { Logger } from "pino";
import type { SlackDelivery } from "./gateway";
import type { Identity } from "./routing";

export class SlackConnection implements SlackDelivery {
  private readonly socket;
  private readonly web;
  constructor(appToken: string, botToken: string, log: Logger) {
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
    this.web = new WebClient(botToken, options);
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

  async start(accept: (body: unknown) => boolean, log: Logger) {
    this.socket.on(
      "slack_event",
      (request: { body: unknown; ack: () => Promise<void> }) => {
        const handle = async () => {
          // Commit to SQLite before ACK. Slack can retry if the process stops here.
          accept(request.body);
          await request.ack();
        };
        handle().catch(() =>
          log.error("Could not persist or acknowledge Slack event"),
        );
      },
    );
    this.socket.on("error", () => log.error("Slack socket error"));
    await this.socket.start();
  }

  async post(channel: string, thread: string, text: string) {
    await this.web.chat.postMessage({
      channel,
      thread_ts: thread,
      text: text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
      blocks: [
        { type: "section", text: { type: "plain_text", text, emoji: false } },
      ],
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  async close() {
    await this.socket.disconnect();
  }
}
