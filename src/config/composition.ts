import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Schema, SchemaTransformation } from "effect";
import {
  claudeBackendSchema,
  claudeToolNames,
} from "../backends/claude/config";
import { codexBackendSchema } from "../backends/codex/config";
import { crewActivitySchema } from "../activity/activity";
import { apiV1ConfigSchema } from "../observability/dashboard/api/v1/config";
import { captainPostSchema } from "../coordination/captain/config";
import { cronjobsSchema } from "../automation/cron/config";
import { validateFleetPermissions } from "../coordination/fleet/permissions";
import { fleetPolicySchema } from "../coordination/fleet/fleet-policy";
import { healthConfigSchema } from "../observability/health/config";
import {
  createIrcConfig,
  ircAccount,
  ircChannel,
} from "../transports/irc/config";
import { fold, widestFold } from "../transports/irc/protocol";
import { textMentionRuleSchema } from "../shared/mentions";
import { maintenanceSchema } from "../automation/maintenance/nightly/config";
import { notifyConfigError } from "../notifications/ingest/binding";
import { notifySchema } from "../notifications/ingest/config";
import {
  piCrewBackendSchema,
  piDurableBackendSchema,
} from "../backends/pi/config";
import { quotaWatchSchema } from "../backends/quota/quota-watch";
import { decodeSettings } from "./settings-errors";
import {
  absolutePath,
  envName,
  secureLocalOrHttpsURL,
  settingsCheck,
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
  settingsURL,
  settingsUUID,
} from "./settings-schema";
import { transcriptionSchema } from "../transcription/config";
import { waitingSchema } from "./waiting";

import { opencodeBackendSchema } from "../backends/opencode/config";

const userRule = Schema.Union([
  Schema.Literal("*"),
  Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/)),
]);

const channelRule = Schema.Union([
  Schema.Literal("*"),
  Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/)),
]);

export { piCrewBackendSchema, piDurableBackendSchema };

export { claudeBackendSchema, claudeToolNames };

export { codexBackendSchema };

// HTTP is permitted only for Tailscale names/addresses. Public routes need TLS.
const pairingOrigin = settingsURL
  .check(Schema.isMaxCodePoints(2048))
  .check(
    settingsRefine(
      (value) => {
        if (!URL.canParse(value) || !/^https?:\/\//i.test(value)) return false;
        const url = new URL(value);

        if (
          /[\s\\?#@]/.test(value) ||
          url.username ||
          url.password ||
          url.pathname !== "/"
        )
          return false;

        if (url.protocol === "https:") return true;

        if (url.protocol !== "http:") return false;
        const host = url.hostname;
        const parts = host.split(".").map(Number);

        return (
          host.endsWith(".ts.net") ||
          (parts.length === 4 &&
            parts.every(
              (part) => Number.isInteger(part) && part >= 0 && part <= 255,
            ) &&
            parts[0] === 100 &&
            (parts[1] ?? 0) >= 64 &&
            (parts[1] ?? 256) <= 127) ||
          host.startsWith("[fd7a:115c:a1e0:")
        );
      },
      {
        message:
          "Use an HTTPS origin, or an HTTP Tailscale origin, without credentials, path, query or fragment",
      },
    ),
  )
  .pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        // The checks above own rejection. Failure-only diagnostic decoding
        // Disables checks and must retain the string instead of throwing.
        decode: (value) =>
          URL.canParse(value) ? new URL(value).origin : value,
        encode: (value) => value,
      }),
    ),
  );

const pairingSchema = settingsStruct({
  operators: Schema.mutable(
    Schema.Array(Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/))),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(100)),
  urls: Schema.mutable(Schema.Array(pairingOrigin))
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(5)),
});

export const backendSchema = settingsDiscriminatedUnion("type", [
  opencodeBackendSchema,
  piDurableBackendSchema,
  claudeBackendSchema,
  codexBackendSchema,
  settingsStruct({
    type: Schema.Literal("module"),
    module: absolutePath,
    options: settingsRecord(Schema.String, Schema.Unknown).pipe(
      settingsDefault({}),
    ),
  }),
]);

export const botSchema = settingsStruct({
  id: Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  displayName: Schema.optional(
    Schema.Trim.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(100),
    ),
  ),
  slack: settingsStruct({
    steerThreadFollowUps: Schema.Boolean.pipe(settingsDefault(false)),
    inboundReactions: Schema.Boolean.pipe(settingsDefault(false)),
    appId: Schema.String.check(settingsPattern(/^A[A-Z0-9]+$/)),
    appTokenEnv: envName,
    botTokenEnv: envName,
  }),
  access: settingsStruct({
    users: Schema.mutable(Schema.Array(userRule)).check(Schema.isMinLength(1)),
    channels: Schema.mutable(Schema.Array(channelRule)).check(
      Schema.isMinLength(1),
    ),
    deniedUsers: Schema.mutable(Schema.Array(userRule)).pipe(
      settingsDefault([]),
    ),
    deniedChannels: Schema.mutable(Schema.Array(channelRule)).pipe(
      settingsDefault([]),
    ),
    mentionOnly: Schema.Boolean.pipe(settingsDefault(false)),
    /** Admit verified peer captain bots (`*-captain`); other bots stay rejected. */
    peerCaptains: Schema.optional(Schema.Boolean),
    /** Peer captain turns per thread/hour; absent keeps the default of five. */
    peerTurnsPerHour: Schema.optional(
      Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(600)),
    ),
    /**
     * In these channels, a top-level message whose text contains one of the
     * names starts a conversation like a mention. Absent is off.
     */
    textMentions: Schema.optional(textMentionRuleSchema),
  }),
  backend: backendSchema,
  /** Read-only health reporting; remote health uses a cached snapshot only. */
  health: Schema.optional(healthConfigSchema),
  /** Opt-in Slack configuration buttons; typed commands remain the default. */
  configPanelEnabled: Schema.Boolean.pipe(settingsDefault(false)),
  cronjobs: Schema.optional(cronjobsSchema),
  /** Captain `stargate_post` to allowed channels; absent is off. */
  captainPost: Schema.optional(captainPostSchema),
  pairing: Schema.optional(pairingSchema),
  threadContext: Schema.Boolean.pipe(settingsDefault(false)),
  /** Follow an untagged reply when Slack history proves this bot already replied. */
  resumeSlackThreads: Schema.optional(Schema.Boolean),
  /** Acknowledge a human Slack message while its turn runs. */
  slackReadReceipts: Schema.optional(Schema.Boolean),
  /** Speech-to-text for accepted audio and video messages; absent is off. */
  transcription: Schema.optional(transcriptionSchema),
  waiting: waitingSchema.pipe(
    settingsDefault({ delayMs: 5000, intervalMs: 10_000 }),
  ),
  crewActivity: crewActivitySchema.pipe(
    settingsDefault({
      detail: "off",
    }),
  ),
  concurrency: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(32))
    .pipe(settingsDefault(4)),
  turnTimeoutMs: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(3_600_000))
    .pipe(settingsDefault(1_800_000)),
});

export {
  defaultAllCallWords,
  ircFeatureDefaults,
} from "../transports/irc/config";

export const { ircSchema, ircFeedbackDefaults, effectiveIrcConfig } =
  createIrcConfig({
    backendSchema,
    transcriptionSchema,
    validateFleetPermissions,
  });

export type IrcConfig = typeof ircSchema.Type;

export type EffectiveIrcConfig = ReturnType<typeof effectiveIrcConfig>;

const dispatchSeconds = (minimum: number, maximum: number) =>
  Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(minimum))
    .check(Schema.isLessThanOrEqualTo(maximum));

/** Headers that the dispatch client owns or that no proxy needs from config. */
const reservedDispatchHeaders = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
]);

export const agentDispatchDefaults = {
  pollIntervalSeconds: 120,
  answerTimeoutSeconds: 300,
  retryLadderSeconds: [3600, 10_800, 21_600, 43_200],
} as const;

/**
 * Deterministic agent dispatch on the rear admiral's gateway (see
 * docs/agent-dispatch.md). Stargate polls the Subspace API over outbound
 * HTTPS only; nothing here listens for connections. Off unless `enabled`.
 */
export const agentDispatchSchema = settingsStruct({
  enabled: Schema.Boolean.pipe(settingsDefault(false)),
  /** Fleet slug or UUID in the Subspace API. */
  fleet: Schema.String.check(
    settingsPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/),
  ),
  api: settingsStruct({
    /** API origin, optionally ending in `/api`. HTTPS, or HTTP on loopback. */
    baseUrl: secureLocalOrHttpsURL,
    /** Variable holding the rear admiral agent's bearer token. */
    tokenEnv: envName,
    /** Extra headers for private access (for example a zero-trust service token). */
    headersEnv: settingsRecord(
      Schema.String.check(
        settingsPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/),
      ).check(
        settingsRefine(
          (name) => !reservedDispatchHeaders.has(name.toLowerCase()),
          {
            message:
              "This header is set by Stargate; use tokenEnv for the bearer token",
          },
        ),
      ),
      envName,
    ).pipe(settingsDefault({})),
  }),
  messaging: settingsStruct({
    /** IRC is the only messaging system today. */
    type: Schema.Literal("irc").pipe(settingsDefault("irc")),
    /** The rear admiral's IRC registration ID. */
    registration: Schema.String.check(
      settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    ),
    /** Defaults to the registration's fleetChannels.command. */
    channel: Schema.optional(ircChannel),
  }),
  /** Subspace agent name to chat account; an unlisted name is its own account. */
  captainAccounts: settingsRecord(
    Schema.String.check(settingsPattern(/^[A-Za-z0-9-]{1,64}$/)),
    ircAccount,
  ).pipe(settingsDefault({})),
  pollIntervalSeconds: dispatchSeconds(30, 3600).pipe(
    settingsDefault(agentDispatchDefaults.pollIntervalSeconds),
  ),
  answerTimeoutSeconds: dispatchSeconds(60, 3600).pipe(
    settingsDefault(agentDispatchDefaults.answerTimeoutSeconds),
  ),
  /** Waits between rounds; there is one more round than entries. */
  retryLadderSeconds: Schema.mutable(Schema.Array(dispatchSeconds(60, 604_800)))
    .check(Schema.isMaxLength(10))
    .pipe(settingsDefault([...agentDispatchDefaults.retryLadderSeconds])),
});

export type AgentDispatchConfig = typeof agentDispatchSchema.Type;

/** The rear admiral registration and channel that dispatch uses, or why not. */
export function agentDispatchTarget(
  dispatch: AgentDispatchConfig,
  irc: readonly IrcConfig[],
): { registration: IrcConfig; channel: string } | string {
  const registration = irc.find(
    (entry) => entry.id === dispatch.messaging.registration,
  );

  if (!registration)
    return "Agent dispatch messaging.registration must name an IRC registration";

  if (registration.fleetPolicy?.role !== "rear_admiral")
    return "Agent dispatch runs only on a rear admiral's IRC registration (fleetPolicy.role rear_admiral)";

  const channel =
    dispatch.messaging.channel ?? registration.fleetChannels?.command;

  if (!channel)
    return "Set agent dispatch messaging.channel or the registration's fleetChannels.command";

  const joined = effectiveIrcConfig(registration).channels.find(
    (name) => fold(name) === fold(channel),
  );

  if (!joined)
    return "The agent dispatch channel must be one of the rear admiral registration's channels";

  return { registration, channel: joined };
}

const normalisedPath = absolutePath.check(
  settingsRefine((path) => resolve(path) === path, {
    message: "An absolute normalised path is required",
  }),
);

const subspaceLine = (maximum: number) =>
  Schema.Trim.check(Schema.isMinCodePoints(1))
    .check(Schema.isMaxCodePoints(maximum))
    .check(
      settingsRefine((value) => !/\p{Cc}/u.test(value), {
        message: "Use one line without control characters",
      }),
    );

/** Headers the Subspace signing proxy and enrolment set or always drop. */
const reservedSubspaceHeaders = new Set([
  ...reservedDispatchHeaders,
  "cookie",
  "origin",
  "x-subspace-agent",
]);

/** One officer whose Subspace API identity the gateway holds. */
const subspaceOfficerSchema = settingsStruct({
  /** The agent's name in the Subspace API; also its bundle's file name. */
  name: Schema.String.check(settingsPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/)),
  rank: Schema.Literals(["rearAdmiral", "captain"]),
  /** A captain's ship; a rear admiral has none. */
  ship: Schema.optional(subspaceLine(64)),
  model: subspaceLine(100),
  ircNick: Schema.optional(
    Schema.String.check(settingsPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)),
  ),
  /** Key and certificate; default `<stateDirectory>/<name>.pem`. */
  bundlePath: Schema.optional(normalisedPath),
}).check(
  settingsCheck((officer, context) => {
    if ((officer.rank === "captain") !== (officer.ship !== undefined))
      context.addIssue({
        code: "custom",
        path: ["ship"],
        message: "A captain needs a ship; a rear admiral has none",
      });
  }),
);

/**
 * Optional Subspace API agent identity: one key per officer, enrolled with
 * the API. Absent or `enabled: false` loads, opens and contacts nothing.
 */
export const subspaceAgentsSchema = settingsStruct({
  enabled: Schema.Boolean.pipe(settingsDefault(false)),
  api: settingsStruct({
    /**
     * The API's origin, with no path: its routes are `/api/v1/` and `/mcp`.
     * HTTPS, or HTTP on loopback.
     */
    baseUrl: secureLocalOrHttpsURL.check(
      settingsRefine((value) => new URL(value).pathname === "/", {
        message: "Use the API's origin, with no path",
      }),
    ),
    /**
     * The API's public origin (its `AGENT_TOKEN_AUDIENCE`) for `aud`, when
     * Stargate reaches it by another address; defaults to the origin of `baseUrl`.
     */
    audience: Schema.optional(
      Schema.String.check(
        settingsRefine(
          (value) =>
            URL.canParse(value) &&
            /^https?:$/.test(new URL(value).protocol) &&
            new URL(value).origin === value,
          { message: "Use an origin: scheme, host and optional port only" },
        ),
      ),
    ),
    /** Extra headers for private access (for example a zero-trust service token). */
    headersEnv: settingsRecord(
      Schema.String.check(
        settingsPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/),
      ).check(
        settingsRefine(
          (name) => !reservedSubspaceHeaders.has(name.toLowerCase()),
          { message: "Stargate sets or drops this header itself" },
        ),
      ),
      envName,
    ).pipe(settingsDefault({})),
    /** Bound on each upstream request, in seconds. */
    timeoutSeconds: dispatchSeconds(1, 300).pipe(settingsDefault(60)),
  }),
  /** The fleet's one-time enrolment token: a private file or a variable. */
  enrolment: Schema.optional(
    settingsStruct({
      tokenFile: Schema.optional(normalisedPath),
      tokenEnv: Schema.optional(envName),
    }).check(
      settingsCheck((enrolment, context) => {
        if (
          (enrolment.tokenFile === undefined) ===
          (enrolment.tokenEnv === undefined)
        )
          context.addIssue({
            code: "custom",
            message: "Set exactly one of tokenFile or tokenEnv",
          });
      }),
    ),
  ),
  /** Key type for new bundles; an existing bundle keeps its own. */
  keyAlgorithm: Schema.Literals(["ed25519", "ecdsa-p256"]).pipe(
    settingsDefault("ed25519"),
  ),
  /** Private (0700) directory for bundles and enrolment records. */
  stateDirectory: Schema.optional(normalisedPath),
  officers: Schema.mutable(Schema.Array(subspaceOfficerSchema))
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(64)),
});

export type SubspaceAgentsConfig = typeof subspaceAgentsSchema.Type;

const repeated = (values: readonly string[]) =>
  new Set(values).size !== values.length;

/** Cross-checks of an enabled section; a disabled one names nothing that must exist. */
function subspaceAgentsIssues(
  section: SubspaceAgentsConfig,
): [PropertyKey[], string][] {
  const issues: [PropertyKey[], string][] = [];
  const officers = section.officers;

  if (repeated(officers.map((officer) => officer.name.toLowerCase())))
    issues.push([["officers"], "Officer names must be unique"]);

  if (repeated(officers.flatMap((officer) => officer.bundlePath ?? [])))
    issues.push([["officers"], "Each officer needs its own bundlePath"]);

  return issues;
}

/** Bot Framework transport: exact sender IDs, no credential values in config. */
export const teamsSchema = settingsStruct({
  livePresence: Schema.optional(Schema.Boolean),
  id: Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  displayName: Schema.optional(
    Schema.String.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(100),
    ),
  ),
  botClientId: settingsUUID,
  tenantId: settingsUUID,
  socketPath: absolutePath,
  access: settingsStruct({
    users: Schema.mutable(Schema.Array(settingsUUID)).check(
      Schema.isMinLength(1),
    ),
    channels: Schema.mutable(
      Schema.Array(
        Schema.String.check(Schema.isMinCodePoints(1)).check(
          Schema.isMaxCodePoints(1024),
        ),
      ),
    ).pipe(settingsDefault([])),
    deniedUsers: Schema.mutable(Schema.Array(settingsUUID)).pipe(
      settingsDefault([]),
    ),
    deniedChannels: Schema.mutable(
      Schema.Array(
        Schema.String.check(Schema.isMinCodePoints(1)).check(
          Schema.isMaxCodePoints(1024),
        ),
      ),
    ).pipe(settingsDefault([])),
  }),
  backend: backendSchema,
  fleetPolicy: Schema.optional(fleetPolicySchema),
  approvalUsers: Schema.mutable(Schema.Array(settingsUUID)).pipe(
    settingsDefault([]),
  ),
  approvalTTLms: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(3_600_000))
    .pipe(settingsDefault(600_000)),
  waiting: waitingSchema.pipe(
    settingsDefault({ delayMs: 5000, intervalMs: 10_000 }),
  ),
  crewActivity: crewActivitySchema.pipe(settingsDefault({ detail: "off" })),
  concurrency: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(32))
    .pipe(settingsDefault(1)),
  turnTimeoutMs: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(3_600_000))
    .pipe(settingsDefault(1_800_000)),
}).check(
  settingsCheck((value, context) => {
    if (value.approvalUsers.some((user) => !value.access.users.includes(user)))
      context.addIssue({
        code: "custom",
        message: "Approval users must be allowed human users",
      });

    if (value.approvalUsers.length > 0 && value.backend.type !== "opencode")
      context.addIssue({
        code: "custom",
        message: "Teams approvals require OpenCode",
      });
  }),
);

export type TeamsConfig = typeof teamsSchema.Type;

/** Registration IDs: Slack bots, IRC captains and `<irc id>-<crew id>`. */
export function registrationIds(config: {
  bots: readonly { id: string }[];
  irc: readonly IrcConfig[];
  teams?: readonly { id: string }[];
}) {
  return [
    ...config.bots.map((bot) => bot.id),
    ...(config.teams ?? []).map((team) => team.id),
    ...config.irc.flatMap((irc) => [
      irc.id,
      ...irc.crew.map((member) => `${irc.id}-${member.id}`),
    ]),
  ];
}

/** Pinned captain sessions of every transport. */
export function pinnedSessionIDs(config: {
  bots: readonly BotConfig[];
  irc: readonly IrcConfig[];
  teams?: readonly TeamsConfig[];
}) {
  return [
    ...new Set(
      [...config.bots, ...config.irc, ...(config.teams ?? [])].flatMap(
        (registration) =>
          registration.backend.type === "opencode" &&
          registration.backend.sessionID !== undefined
            ? [registration.backend.sessionID]
            : [],
      ),
    ),
  ];
}

const configFields = settingsStruct({
  dataDirectory: Schema.String.pipe(settingsDefault(".stargate")),
  /** Opt in to the private-network Fleet API; see docs/api.md. */
  api: Schema.optional(apiV1ConfigSchema),
  notify: Schema.optional(notifySchema),
  /** Serve the read-only fleet dashboard on `<dataDirectory>/dashboard.sock`. */
  dashboard: Schema.optional(Schema.Boolean),
  /** Explicit operator-group socket; the private default is unchanged. */
  dashboardSocket: Schema.optional(
    settingsStruct({
      path: absolutePath.check(
        settingsRefine((path) => resolve(path) === path, {
          message: "An absolute normalised socket path is required",
        }),
      ),
      groupAccess: Schema.Literal(true),
    }),
  ),
  bots: Schema.mutable(Schema.Array(botSchema)).pipe(settingsDefault([])),
  notifications: settingsStruct({
    updateNotice: Schema.Boolean.pipe(settingsDefault(false)),
  }).pipe(settingsDefault({ updateNotice: false })),
  /** IRCv3 registrations, independent of Slack; see docs/irc.md. */
  irc: Schema.mutable(Schema.Array(ircSchema)).pipe(settingsDefault([])),
  teams: Schema.mutable(Schema.Array(teamsSchema)).pipe(settingsDefault([])),
  /** Nightly self-update and host maintenance; see docs/maintenance.md. */
  maintenance: Schema.optional(maintenanceSchema),
  /** Read subscription quota and announce changes to crew availability. */
  quotaWatch: Schema.optional(quotaWatchSchema),
  /** Rear admiral agent dispatch from Subspace issues; off by default. */
  agentDispatch: Schema.optional(agentDispatchSchema),
  /** Officers' Subspace API keys and signing proxy; absent by default. */
  subspaceAgents: Schema.optional(subspaceAgentsSchema),
});

const configCheck = (liveNotificationPolicy = false) =>
  settingsCheck<typeof configFields.Type>(
    (
      {
        bots,
        irc,
        teams,
        maintenance,
        quotaWatch,
        dashboard,
        dashboardSocket,
        notify,
        api,
        agentDispatch,
        subspaceAgents,
      },
      context,
    ) => {
      // A disabled section is inert: it names nothing that must exist yet.
      if (agentDispatch?.enabled) {
        const target = agentDispatchTarget(agentDispatch, irc);

        if (typeof target === "string")
          context.addIssue({
            code: "custom",
            path: ["agentDispatch", "messaging"],
            message: target,
          });
      }

      if (subspaceAgents?.enabled)
        for (const [path, message] of subspaceAgentsIssues(subspaceAgents))
          context.addIssue({
            code: "custom",
            path: ["subspaceAgents", ...path],
            message,
          });

      if (notify) {
        const message = notifyConfigError(
          notify,
          bots,
          api?.listen,
          liveNotificationPolicy,
        );

        if (message)
          context.addIssue({ code: "custom", path: ["notify"], message });
      }

      if (dashboardSocket && dashboard !== true)
        context.addIssue({
          code: "custom",
          path: ["dashboardSocket"],
          message: "A shared dashboard socket requires dashboard: true",
        });

      if (bots.length + irc.length + teams.length === 0)
        context.addIssue({
          code: "custom",
          path: ["bots"],
          message: "Configure at least one Slack, Teams or IRC registration",
        });
      const ids = registrationIds({ bots, irc, teams });

      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: "custom",
          message: "Duplicate registration ID across bots, irc and IRC crew",
        });

      // One Slack bot and one IRC captain may share a pin: each delivers only
      // Replies attributed to its own native inputs. Same-transport pins stay
      // Unique, so one queue never owns another's cursor.
      const ircPins = irc.flatMap((registration) =>
        registration.backend.type === "opencode" &&
        registration.backend.sessionID !== undefined
          ? [registration.backend.sessionID]
          : [],
      );

      if (new Set(ircPins).size !== ircPins.length)
        context.addIssue({
          code: "custom",
          message:
            "Duplicate pinned OpenCode sessionID across IRC registrations",
        });

      const teamPins = teams.flatMap((team) =>
        team.backend.type === "opencode" && team.backend.sessionID
          ? [team.backend.sessionID]
          : [],
      );

      const slackPins = new Set(
        bots.flatMap((bot) =>
          bot.backend.type === "opencode" && bot.backend.sessionID
            ? [bot.backend.sessionID]
            : [],
        ),
      );

      if (
        new Set(teamPins).size !== teamPins.length ||
        teamPins.some((pin) => slackPins.has(pin))
      )
        context.addIssue({
          code: "custom",
          message: "A pinned session needs one primary chat transport owner",
        });

      if (new Set(teams.map((team) => team.socketPath)).size !== teams.length)
        context.addIssue({
          code: "custom",
          message: "Teams registrations need separate socket paths",
        });

      // An audit channel is never a conversation in any registration: another
      // Ship listing it would answer mirrored lines. Host names and ports do
      // Not prove two servers distinct (aliases, addresses, proxies), so every
      // IRC registration counts, under the widest name folding.
      const shipChannels = new Set(
        irc.flatMap((registration) => registration.channels.map(widestFold)),
      );

      for (const registration of irc) {
        const audit = registration.audit?.channel;

        if (audit !== undefined && shipChannels.has(widestFold(audit)))
          context.addIssue({
            code: "custom",
            message: `IRC audit channel of ${registration.id} is a ship channel of an IRC registration`,
          });
      }

      const ircSecrets = irc.flatMap((registration) => [
        ...(registration.passwordEnv ? [registration.passwordEnv] : []),
        ...registration.crew.flatMap((member) =>
          member.passwordEnv ? [member.passwordEnv] : [],
        ),
      ]);

      if (new Set(ircSecrets).size !== ircSecrets.length)
        context.addIssue({
          code: "custom",
          message: "Each IRC account needs its own passwordEnv",
        });

      for (const [feature, report] of [
        ["maintenance", maintenance?.report],
        ["quotaWatch", quotaWatch?.report],
      ] as const) {
        if (!report) continue;
        const bot = bots.find((item) => item.id === report.bot);

        const matches = (rules: readonly string[]) =>
          rules.includes("*") || rules.includes(report.channel);

        if (
          !bot ||
          matches(bot.access.deniedChannels) ||
          (feature === "maintenance" && !matches(bot.access.channels))
        )
          context.addIssue({
            code: "custom",
            path: [feature, "report"],
            message:
              feature === "maintenance"
                ? "Maintenance report bot must exist and allow the report channel"
                : "Quota report bot must exist and not deny the report channel",
          });
      }

      for (const [index, bot] of bots.entries())
        if (bot.captainPost && bot.backend.type !== "opencode")
          context.addIssue({
            code: "custom",
            path: ["bots", index, "captainPost"],
            message: "captainPost requires an OpenCode captain backend",
          });

      const cronDirectories = bots.flatMap((bot) =>
        bot.cronjobs ? [resolve(bot.cronjobs.directory)] : [],
      );

      if (new Set(cronDirectories).size !== cronDirectories.length)
        context.addIssue({
          code: "custom",
          message: "Each bot needs a separate cronjobs directory",
        });

      const pinnedSessions = bots.flatMap((bot) =>
        bot.backend.type === "opencode" && bot.backend.sessionID !== undefined
          ? [bot.backend.sessionID]
          : [],
      );

      if (new Set(pinnedSessions).size !== pinnedSessions.length) {
        context.addIssue({
          code: "custom",
          message:
            "Duplicate pinned OpenCode sessionID; each root needs one bot owner",
        });
      }

      for (const field of [
        "id",
        "appId",
        "botTokenEnv",
        "appTokenEnv",
      ] as const) {
        const values = bots.map((bot) =>
          field === "id" ? bot.id : bot.slack[field],
        );

        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            message: `Duplicate bot ${field}`,
          });
        }
      }
    },
  );

export const configSchema = configFields.check(configCheck());

/** Live access changes may revoke pending display work, never redirect it.
 * The reload planner still requires identical notification topology. */
export const reloadConfigSchema = configFields.check(configCheck(true));

export type BackendConfig = typeof backendSchema.Type;

export type BotConfig = typeof botSchema.Type;

/** Loaded configuration; `dataDirectory` is absolute. */
export type Config = typeof configSchema.Type;

export function secret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];

  if (!value?.trim()) throw new Error(`Missing environment variable: ${name}`);

  return value;
}

export async function loadConfig(path: string) {
  const config = decodeSettings(configSchema, await Bun.file(path).json());
  const dataDirectory = resolve(dirname(resolve(path)), config.dataDirectory);

  // Rejection, not a compatibility reader: never create a parallel empty store.
  if (
    existsSync(join(dataDirectory, "pogo.sqlite")) ||
    (basename(dataDirectory) === ".stargate" &&
      !existsSync(join(dataDirectory, "stargate.sqlite")) &&
      existsSync(join(dirname(dataDirectory), ".pogo")))
  )
    throw new Error(
      "Unconverted Pogo state detected. Stop and complete docs/hard-cutover.md before starting Stargate; do not delete state.",
    );

  return {
    ...config,
    dataDirectory,
  };
}
