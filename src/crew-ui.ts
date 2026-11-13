import type { Logger } from "pino";
import { z } from "zod";
import type { AgentBackend } from "./backend";
import type { BotConfig } from "./config";
import { redactActivity } from "./crew/reporting";
import {
  type CrewStatus,
  type CrewStatusTask,
  crewStatusSchema,
} from "./crew-status";
import type { CronView, SlackAck } from "./cron-ui";
import { formatQuota, type QuotaSnapshot, quotaSnapshotSchema } from "./quota";
import { type Identity, isAllowedChannel, isAllowedUser } from "./routing";

export interface CrewUIApi {
  open(triggerID: string, view: CronView): Promise<string>;
  update(viewID: string, view: CronView): Promise<void>;
}
const id = z.string().min(1).max(255);
const commandSchema = z.object({
  command: z.literal("/pogo"),
  text: z
    .string()
    .trim()
    .max(100)
    .regex(/^(?:crew(?:\s+[a-z0-9][a-z0-9_-]{0,63})?|usage)$/),
  api_app_id: id,
  team_id: id,
  user_id: z.string().regex(/^[UW][A-Z0-9]+$/),
  channel_id: z.string().regex(/^[CGD][A-Z0-9]+$/),
  trigger_id: id,
  user_name: z.string().optional(),
  is_bot: z.literal(false).optional(),
  bot_id: z.never().optional(),
});
const plain = (text: string) => ({
  type: "plain_text" as const,
  text,
  emoji: false,
});
const section = (text: string) => ({
  type: "section" as const,
  text: plain(redactActivity(text, 3000)),
});
function notice(text: string, title = "Crew activity"): CronView {
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
  return `${task.kind === "report" ? "Report" : task.kind === "assignment" ? "Assignment" : "Task"}: ${task.summary || "Summary unavailable"}\n${task.id}: ${task.status}${task.phase !== task.status ? ` (${task.phase})` : ""}`;
}
function timing(task: CrewStatusTask, now: number) {
  return `Since recorded start: ${age(task.startedAt, now)}; last update: ${age(task.updatedAt, now)}${task.updatedAt === null ? "" : " ago"}.`;
}

/** All dynamic text stays literal. No model text, links or mentions get markup. */
export function crewStatusView(
  status: CrewStatus,
  detail: boolean,
  now = Date.now(),
): CronView {
  const blocks = [
    section(
      "Read-only snapshot. Stored running/ready state is not proof of live execution. No work is started, retried or repaired. Close and run /pogo crew [member] again to refresh. Times may be unknown for older tasks.",
    ),
  ];
  for (const member of status.members) {
    blocks.push(
      section(
        [
          `${member.name} (${member.id}) — ${member.backend}`,
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
          !detail ? `Details: /pogo crew ${member.id}` : "",
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
  if (!status.members.length)
    blocks.push(
      section(
        "No configured crew member found. Use /pogo crew for the roster.",
      ),
    );
  if (status.truncated)
    blocks.push(
      section(
        `Roster truncated: showing ${status.members.length} of ${status.total}. Query a member directly with /pogo crew <member-id>.`,
      ),
    );
  return { ...notice("Crew activity"), blocks };
}

export function quotaStatusView(
  snapshot: QuotaSnapshot,
  now = Date.now(),
): CronView {
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
      "Close and run /pogo usage again to refresh. No model is called; no account data is posted to the channel.",
    ),
  );
  return { ...notice("Usage", "Provider usage"), blocks };
}

export class CrewUI {
  constructor(
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
  reconfigure(config: BotConfig) {
    this.config = config;
  }

  private allowed(data: z.infer<typeof commandSchema>) {
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

  async command(body: unknown, ack: SlackAck) {
    const parsed = commandSchema.safeParse(body);
    const usage = parsed.success && parsed.data.text === "usage";
    if (
      !parsed.success ||
      !this.allowed(parsed.data) ||
      !(usage ? this.backend.quota : this.backend.crewStatus)
    ) {
      await ack({
        response_type: "ephemeral",
        text: "Status unavailable. Use /pogo crew [member] or /pogo usage in an allowed channel with a configured captain backend.",
      });
      return;
    }
    // ACK and consume the three-second trigger before reading any backend state.
    await ack();
    const data = parsed.data;
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
        const snapshot = quotaSnapshotSchema.parse(
          await this.backend.quota(signal),
        );
        signal.throwIfAborted();
        if (this.allowed(data))
          await this.api.update(viewID, quotaStatusView(snapshot));
        return;
      }
      if (!this.backend.crewStatus) return;
      const status = crewStatusSchema.parse(
        await this.backend.crewStatus(member ? { member } : {}, signal),
      );
      signal.throwIfAborted();
      if (!this.allowed(data)) return;
      // Defense at adapter boundary: module backends get the same redaction and
      // literal rendering. Schema bounds rows and forbids native session fields.
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
      this.log.error("Could not read or display Pogo status");
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

  async interactive(_body: unknown, ack: SlackAck) {
    await ack();
  }
}
