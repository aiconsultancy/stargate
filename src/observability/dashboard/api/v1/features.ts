import {
  type BotConfig,
  type Config,
  type IrcConfig,
  type TeamsConfig,
  effectiveIrcConfig,
  ircFeatureDefaults,
  ircFeedbackDefaults,
} from "../../../../config";
import { resolveQuestionSettings } from "../../../../questions/question-settings";
import type { V1Feature } from "./types";

/**
 * The loaded configuration as the runtime holds it; the HTTP layer owns the
 * parser and listener for the opt-in API block.
 */
export type ApiV1Config = Omit<Config, "irc" | "teams" | "notifications"> & {
  irc?: Config["irc"];
  teams?: Config["teams"];
  notifications?: Config["notifications"];
};

export type Registration =
  | { kind: "slack"; config: BotConfig }
  | { kind: "irc"; config: IrcConfig }
  | { kind: "teams"; config: TeamsConfig };

const flag = (
  key: string,
  label: string,
  enabled: boolean,
  defaultEnabled = false,
  value?: string,
): V1Feature => ({
  key,
  label,
  enabled,
  defaultEnabled,
  ...(value !== undefined && { value }),
});

export function gatewayFeatures(config: ApiV1Config): V1Feature[] {
  const maintenance = config.maintenance;
  const waiting = [...config.bots, ...(config.teams ?? [])];
  const transcription = [...config.bots, ...(config.irc ?? [])];

  return [
    flag("dashboard", "Dashboard", config.dashboard === true),
    flag(
      "dashboard.groupAccess",
      "Shared dashboard socket",
      config.dashboardSocket?.groupAccess === true,
    ),
    flag("api", "Fleet API", config.api !== undefined),
    flag(
      "cronjobs",
      "File-backed cron",
      config.bots.some((bot) => !!bot.cronjobs),
    ),
    flag(
      "waiting",
      "Turn waiting notices",
      waiting.some((bot) => bot.waiting.delayMs !== null),
      true,
    ),
    flag(
      "transcription",
      "Transcription",
      transcription.some((bot) => !!bot.transcription),
    ),
    flag(
      "notifications.updateNotice",
      "Update notices",
      config.notifications?.updateNotice ?? false,
    ),
    flag(
      "quotaWatch",
      "Quota watch",
      !!config.quotaWatch,
      false,
      config.quotaWatch?.providers.join(", "),
    ),
    flag("maintenance", "Nightly maintenance", maintenance?.enabled === true),
    flag(
      "maintenance.drain",
      "Maintenance drain",
      maintenance?.drain.enabled === true,
    ),
    flag(
      "maintenance.cleanup",
      "Worktree cleanup",
      maintenance?.cleanup?.enabled === true,
    ),
    flag("maintenance.report", "Maintenance reports", !!maintenance?.report),
    flag(
      "maintenance.droid",
      "Maintenance droid",
      maintenance?.droid?.enabled === true,
    ),
    flag(
      "maintenance.components.stargate",
      "Stargate updates",
      maintenance?.components.stargate === true,
    ),
    flag(
      "maintenance.components.cliproxyapi",
      "CLIProxyAPI updates",
      maintenance?.components.cliproxyapi === true,
    ),
    flag(
      "maintenance.components.agentClis",
      "Agent CLI updates",
      maintenance?.components.agentClis === true,
    ),
    flag(
      "maintenance.components.models",
      "Model updates",
      maintenance?.components.models === true,
    ),
    flag(
      "maintenance.models.updateGlobalCatalog",
      "Global model catalog updates",
      maintenance?.models?.updateGlobalCatalog === true,
    ),
    flag(
      "maintenance.stargate.requireTreeCheck",
      "Release archive tree check",
      maintenance?.stargate?.requireTreeCheck ?? true,
      true,
    ),
  ];
}

const ircLabels: Record<keyof typeof ircFeatureDefaults, string> = {
  steerThreadFollowUps: "IRC follow-up steering",
  filesIn: "IRC incoming files",
  filesOut: "IRC outgoing files",
  multiline: "IRC multiline replies",
  typing: "IRC typing indicators",
  turnStatus: "IRC turn status",
  reactions: "IRC reactions",
  catchUp: "IRC catch-up",
  alwaysOn: "IRC always-on",
  botMode: "IRC bot mode",
  readMarker: "IRC read markers",
};

function ircFeatures(config: IrcConfig): V1Feature[] {
  const { access, features } = effectiveIrcConfig(config);
  const defaults = ircFeedbackDefaults(config);
  const mode = access.channelRequests ?? "standard";
  const keys = Object.keys(ircLabels) as (keyof typeof ircLabels)[];

  return [
    flag(
      "irc.crewQuestionHandoff",
      "Gateway-owned crew questions",
      features.crewQuestionHandoff,
      defaults.crewQuestionHandoff,
    ),
    flag(
      "irc.questions",
      "IRC questions",
      features.questions,
      defaults.questions,
    ),
    ...keys.map((key) =>
      flag(
        `irc.${key}`,
        ircLabels[key],
        features[key],
        ircFeatureDefaults[key],
      ),
    ),
    flag(
      "irc.liveProgress",
      "Live IRC request progress",
      features.liveProgress,
      defaults.liveProgress,
    ),
    flag("irc.tls", "IRC TLS", config.server.tls, true),
    flag(
      "irc.fleetTyping",
      "IRC fleet typing indicators",
      features.fleetTyping,
      defaults.fleetTyping,
    ),
    flag(
      "irc.sasl",
      "IRC authentication",
      true,
      true,
      config.clientPemFile ? "external" : "plain",
    ),
    flag(
      "irc.filehostOverride",
      "IRC file host override",
      !!config.server.filehostOverride,
    ),
    flag("irc.channelRequests", "IRC channel requests", true, true, mode),
    flag("irc.wakeChannels", "IRC channel wake", !!access.wakeChannels?.length),
    flag(
      "irc.humanWakeChannels",
      "IRC human wake",
      !!access.humanWakeChannels?.length,
    ),
    flag(
      "irc.humanMessageDebounce",
      "IRC human message debounce",
      (access.humanMessageDebounceMs ?? 0) > 0,
    ),
    flag(
      "irc.peerCaptains",
      "IRC peer captains",
      access.peerCaptains.length > 0 && access.peerTurnsPerHour !== 0,
    ),
    flag(
      "irc.shipTurns",
      "IRC ship agent turns",
      access.shipTurnsPerAgentPerHour > 0,
      true,
    ),
    flag(
      "irc.textMentions",
      "IRC text mentions",
      !!access.textMentions?.length,
    ),
    flag("irc.allCalls", "IRC all-calls", access.allCallWords.length > 0, true),
    flag(
      "irc.allCallStagger",
      "IRC all-call staggering",
      access.allCallStaggerMs > 0,
      true,
    ),
    flag(
      "irc.stopReactions",
      "IRC Stop reactions",
      features.reactions && config.stopReactions.length > 0,
      true,
    ),
    flag(
      "irc.directMessages",
      "IRC direct messages",
      config.dmPolicy === "agent",
      true,
      config.dmPolicy,
    ),
    flag("irc.audit", "IRC direct message audit", !!config.audit),
    flag("irc.crew", "IRC crew connections", config.crew.length > 0),
    flag(
      "irc.crewMessaging.sessions",
      "IRC crew messaging",
      config.crewMessaging.sessions,
    ),
    flag(
      "irc.crewMessaging.ircCopies",
      "IRC crew message copies",
      config.crewMessaging.ircCopies,
    ),
    flag(
      "irc.fleetChannels",
      "IRC fleet channel defaults",
      !!config.fleetChannels,
    ),
    flag("fleetPolicy", "Fleet policy", !!config.fleetPolicy),
    flag("fleetControl", "Fleet control", !!config.fleetControl),
    flag(
      "fleetControl.results",
      "Fleet results",
      config.fleetControl?.results === true,
    ),
    flag(
      "fleetControl.reviews",
      "Fleet reviews",
      !!config.fleetControl?.reviews,
    ),
  ];
}

export async function registrationFeatures(
  registration: Registration,
): Promise<V1Feature[]> {
  const { kind, config } = registration;
  const features: V1Feature[] = [];

  if (kind !== "irc") {
    const detail = config.crewActivity.detail;
    features.push(
      flag("crewActivity", "Crew activity", detail !== "off", false, detail),
      flag(
        "crewActivity.reporter",
        "Crew activity reporter",
        !!config.crewActivity.reporter,
      ),
      flag(
        "waiting",
        "Turn waiting notices",
        config.waiting.delayMs !== null,
        true,
      ),
    );
  }

  if (kind !== "teams") {
    features.push(
      flag(
        "transcription",
        "Transcription",
        !!config.transcription,
        false,
        config.transcription?.provider.type,
      ),
    );
  }

  if (kind === "slack") {
    const questions = await resolveQuestionSettings(config);
    features.push(
      flag(
        "configPanelEnabled",
        "Slack configuration panel",
        config.configPanelEnabled,
      ),
      flag(
        "slack.questions",
        "Slack questions",
        questions.enabled,
        false,
        `${questions.answer}, ${questions.timeoutMs / 60_000} min`,
      ),
      flag(
        "slack.steerThreadFollowUps",
        "Slack follow-up steering",
        config.slack.steerThreadFollowUps,
      ),
      flag(
        "slack.inboundReactions",
        "Slack inbound reactions",
        config.slack.inboundReactions,
      ),
      flag(
        "slack.readReceipts",
        "Slack read receipts",
        config.slackReadReceipts === true,
      ),
      flag("slack.threadContext", "Slack thread context", config.threadContext),
      flag(
        "slack.resumeThreads",
        "Slack thread resumption",
        config.resumeSlackThreads === true,
      ),
      flag(
        "slack.mentionOnly",
        "Slack mention-only intake",
        config.access.mentionOnly,
      ),
      flag(
        "slack.peerCaptains",
        "Slack peer captains",
        config.access.peerCaptains === true &&
          config.access.peerTurnsPerHour !== 0,
      ),
      flag(
        "slack.textMentions",
        "Slack text mentions",
        !!config.access.textMentions,
      ),
      flag(
        "slack.muteBypass",
        "Slack mention mute bypass",
        !!config.access.textMentions?.muteBypassNames?.length,
      ),
      flag(
        "slack.spokenMentions",
        "Slack spoken mentions",
        !!config.transcription?.spokenMentions,
      ),
      flag("slack.pairing", "Slack pairing", !!config.pairing),
      flag("slack.captainPost", "Slack captain posting", !!config.captainPost),
      flag("slack.health", "Slack health command", !!config.health),
      flag("cronjobs", "File-backed cron", !!config.cronjobs),
      flag(
        "cronjobs.dailyReport",
        "Daily cron reports",
        !!config.cronjobs?.dailyReport,
      ),
    );
  } else if (kind === "irc") {
    features.push(...ircFeatures(config));
  } else {
    features.push(
      flag(
        "teams.livePresence",
        "Teams typing and progress",
        config.livePresence === true,
      ),
      flag(
        "teams.approvals",
        "Teams approvals",
        config.approvalUsers.length > 0,
      ),
      flag(
        "teams.channelIntake",
        "Teams channel intake",
        config.access.channels.length > 0,
      ),
      flag("fleetPolicy", "Fleet policy", !!config.fleetPolicy),
    );
  }

  const { backend } = config;

  if (backend.type === "opencode") {
    features.push(
      flag(
        "backend.pinnedSession",
        "Pinned captain session",
        !!backend.sessionID,
      ),
      flag(
        "backend.enforcePermissions",
        "OpenCode permission enforcement",
        backend.enforcePermissions === true,
      ),
    );
  } else if (backend.type === "pi-durable") {
    features.push(
      flag(
        "backend.tools",
        "Pi tools",
        backend.tools !== "none",
        false,
        backend.tools,
      ),
      flag("backend.providerProxy", "Pi provider proxy", !!backend.provider),
      flag(
        "backend.thinkingLevel",
        "Pi thinking",
        !!backend.thinkingLevel && backend.thinkingLevel !== "off",
        false,
        backend.thinkingLevel ?? "off",
      ),
    );
  } else if (backend.type === "claude") {
    features.push(
      flag("backend.tools", "Claude tools", backend.allowedTools.length > 0),
      flag(
        "backend.mcpServers",
        "Claude MCP servers",
        Object.keys(backend.mcpServers ?? {}).length > 0,
      ),
      flag(
        "backend.settingSources",
        "Claude filesystem settings",
        backend.settingSources.length > 0,
      ),
    );
  } else if (backend.type === "codex") {
    features.push(
      flag(
        "backend.sandbox",
        "Codex sandbox",
        backend.sandbox !== "danger-full-access",
        true,
        backend.sandbox,
      ),
      flag("backend.network", "Codex network", backend.network),
      flag(
        "backend.projectDocs",
        "Codex project instructions",
        backend.projectDocs,
      ),
    );
  }

  return features;
}
