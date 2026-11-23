import type { ViewsOpenArguments } from "@slack/web-api";
import { Result, Schema } from "effect";
import type { Logger } from "pino";
import type { AgentBackend } from "../backends/backend";
import type { BotConfig } from "../config";
import { redactCredentials } from "../lib/credentials";
import {
  type CrewStatus,
  type CrewStatusTask,
  crewStatusSchema,
} from "../shared/crew-status";
import {
  type QuotaSnapshot,
  formatQuota,
  quotaSnapshotSchema,
} from "../quota/quota";
import {
  type Identity,
  isAllowedChannel,
  isAllowedUser,
} from "../gateway/routing";
import { settingsPattern } from "../config/settings-schema";

type CrewView = Extract<ViewsOpenArguments["view"], { type: "modal" }>;

type SlackAck = (payload?: Record<string, unknown>) => Promise<void>;

export interface CrewUIApi {
  open(triggerID: string, view: CrewView): Promise<string>;
  update(viewID: string, view: CrewView): Promise<void>;
}

const id = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(255),
);

const commandSchema = Schema.Struct({
  command: Schema.Literal("/stargate"),
  text: Schema.Trim.check(
    Schema.isMaxCodePoints(100),
    settingsPattern(/^(?:crew(?:\s+[a-z0-9][a-z0-9_-]{0,63})?|usage)$/),
  ),
  api_app_id: id,
  team_id: id,
  user_id: Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/)),
  channel_id: Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/)),
  trigger_id: id,
  user_name: Schema.optional(Schema.String),
  is_bot: Schema.optional(Schema.Literal(false)),
  bot_id: Schema.optional(Schema.Never),
});

const plain = (text: string) => ({
  type: "plain_text" as const,
  text,
  emoji: false,
});

const section = (text: string) => ({
  type: "section" as const,
  text: plain(redactCredentials(text, 3000)),
});

function notice(text: string, title = "Crew activity"): CrewView {
  return {
    type: "modal",
    title: plain(title),
    close: plain("Close"),
    clear_on_close: true,
    blocks: [section(text)],
  };
}

function age(time: number | null, now: number) {
  if (time === null) return "unknown";
  const seconds = Math.max(0, Math.floor((now - time) / 1000));

  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function taskLine(task: CrewStatusTask) {
  return `${taskKindLabel(task.kind)}: ${task.summary || "Summary unavailable"}\n${task.id}: ${task.status}${task.phase !== task.status ? ` (${task.phase})` : ""}`;
}

function timing(task: CrewStatusTask, now: number) {
  return `Since recorded start: ${age(task.startedAt, now)}; last update: ${age(task.updatedAt, now)}${task.updatedAt === null ? "" : " ago"}.`;
}

/** All dynamic text stays literal. No model text, links or mentions get markup. */
export function crewStatusView(
  status: CrewStatus,
  detail: boolean,
  now = Date.now(),
): CrewView {
  const blocks = [
    section(
      "Read-only snapshot. Stored running/ready state is not proof of live execution. No work is started, retried or repaired. Close and run /stargate crew [member] again to refresh. Times may be unknown for older tasks.",
    ),
  ];

  for (const member of status.members) {
    blocks.push(
      section(
        [
          `${member.name} (${member.id}) — ${member.backend}`,
          ...(member.project ? [`Project: ${member.project}.`] : []),
          `Provisioning: ${member.provisioned}. ${member.observed ? "Execution observed in this process (not a health check)." : "Execution unobserved; liveness unknown."}`,
          member.current
            ? `Current stored task\n${taskLine(member.current)}\n${timing(member.current, now)}`
            : "No current stored task.",
          member.current?.status === "uncertain"
            ? "Outcome uncertain: no proof running or finished. No retry made."
            : "",
          `Queued: ${member.queuedCount}.`,
          member.lastOutcome
            ? `Last stored outcome\n${taskLine(member.lastOutcome)}`
            : "Last outcome: unknown (no recorded outcome).",
          !detail ? `Details: /stargate crew ${member.id}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );

    if (!detail) continue;

    if (member.current?.progress)
      blocks.push(
        section(
          `Latest visible progress (bounded snapshot)\n${member.current.progress}`,
        ),
      );
    blocks.push(
      section(
        `Queued tasks: showing ${member.queued.length} of ${member.queuedCount}${member.queuedCount > member.queued.length ? " (truncated)" : ""}.`,
      ),
    );

    for (const task of member.queued) blocks.push(section(taskLine(task)));
    blocks.push(
      section(
        `Recent outcomes: showing ${member.recent.length} of ${member.recentCount}${member.recentCount > member.recent.length ? " (truncated; only recent status details retained)" : ""}.`,
      ),
    );

    for (const task of member.recent)
      blocks.push(
        section(
          `${taskLine(task)}\n${timing(task, now)}${task.progress ? `\nLatest visible progress: ${task.progress}` : ""}`,
        ),
      );
  }

  if (status.members.length === 0)
    blocks.push(
      section(
        "No configured crew member found. Use /stargate crew for the roster.",
      ),
    );

  if (status.truncated)
    blocks.push(
      section(
        `Roster truncated: showing ${status.members.length} of ${status.total}. Query a member directly with /stargate crew <member-id>.`,
      ),
    );

  return { ...notice("Crew activity"), blocks };
}

export function quotaStatusView(
  snapshot: QuotaSnapshot,
  now = Date.now(),
): CrewView {
  // At most 10 accounts x 16 windows. Group each account, not one block per row.
  const lines = formatQuota(snapshot, now);
  const blocks = [section(lines.slice(0, 2).join("\n"))];
  let text = "";

  for (const line of lines.slice(2)) {
    if (text.length + line.length + 1 > 2900) {
      blocks.push(section(text));
      text = "";
    }

    text += `${text ? "\n" : ""}${line}`;
  }

  if (text) blocks.push(section(text));
  blocks.push(
    section(
      "Close and run /stargate usage again to refresh. No model is called; no account data is posted to the channel.",
    ),
  );

  return { ...notice("Usage", "Provider usage"), blocks };
}

export class CrewUI {
  public constructor(
    private config: BotConfig,
    private readonly identity: Identity,
    private readonly backend: Pick<AgentBackend, "crewStatus" | "quota">,
    private readonly api: CrewUIApi,
    private readonly log: Logger,
    private readonly signal: AbortSignal,
    private readonly deadline: () => AbortSignal = () =>
      AbortSignal.timeout(10_000),
  ) {}

  /** Access changes apply before the next operation or delivery. */
  public reconfigure(config: BotConfig) {
    this.config = config;
  }

  private allowed(data: typeof commandSchema.Type) {
    return (
      !this.signal.aborted &&
      data.api_app_id === this.config.slack.appId &&
      data.team_id === this.identity.team &&
      data.user_id !== this.identity.user &&
      data.user_name !== "slackbot" &&
      isAllowedUser(this.config, data.user_id) &&
      isAllowedChannel(this.config, data.channel_id)
    );
  }

  public async command(body: unknown, ack: SlackAck) {
    const parsed = Schema.decodeUnknownResult(commandSchema)(body);
    const usage = Result.isSuccess(parsed) && parsed.success.text === "usage";

    if (
      Result.isFailure(parsed) ||
      !this.allowed(parsed.success) ||
      !(usage ? this.backend.quota : this.backend.crewStatus)
    ) {
      await ack({
        response_type: "ephemeral",
        text: "Status unavailable. Use /stargate crew [member] or /stargate usage in an allowed channel with a configured captain backend.",
      });

      return;
    }

    // ACK and consume the three-second trigger before reading any backend state.
    await ack();
    const data = parsed.success;
    let viewID: string | undefined;

    try {
      viewID = await this.api.open(
        data.trigger_id,
        notice(
          usage
            ? "Reading provider usage… No model is called."
            : "Reading crew status… No model is called.",
          usage ? "Provider usage" : "Crew activity",
        ),
      );

      if (!this.allowed(data)) return;
      const member = data.text.split(/\s+/)[1];
      const signal = AbortSignal.any([this.signal, this.deadline()]);
      signal.throwIfAborted();

      if (usage && this.backend.quota) {
        const snapshot = Schema.decodeUnknownSync(quotaSnapshotSchema)(
          await this.backend.quota(signal),
        );

        signal.throwIfAborted();

        if (this.allowed(data))
          await this.api.update(viewID, quotaStatusView(snapshot));

        return;
      }

      if (!this.backend.crewStatus) return;

      const status = Schema.decodeUnknownSync(crewStatusSchema)(
        await this.backend.crewStatus(member ? { member } : {}, signal),
      );

      signal.throwIfAborted();

      if (!this.allowed(data)) return;

      // Defense at adapter boundary: module backends get the same redaction and
      // Literal rendering. Schema bounds rows and forbids native session fields.
      const safe = member
        ? {
            ...status,
            members: status.members
              .filter(({ id }) => id === member)
              .slice(0, 1),
          }
        : status;

      await this.api.update(viewID, crewStatusView(safe, !!member));
    } catch {
      this.log.error("Could not read or display Stargate status");

      if (!viewID || !this.allowed(data)) return;

      try {
        await this.api.update(
          viewID,
          notice(
            usage
              ? "Quota unavailable or timed out. Check the captain location, crew plugin and private quota configuration. No model was called."
              : "Crew status unavailable or timed out. Check the configured captain location and crew plugin. No model was called or work retried.",
            usage ? "Provider usage" : "Crew activity",
          ),
        );
      } catch {
        this.log.error("Could not update crew status modal");
      }
    }
  }

  public async interactive(_body: unknown, ack: SlackAck) {
    await ack();
  }
}

function taskKindLabel(kind: string) {
  switch (kind) {
    case "report":
      return "Report";
    case "assignment":
      return "Assignment";
    default:
      return "Task";
  }
}
