import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Result, Schema, SchemaTransformation } from "effect";
import { crewActivitySchema } from "./activity/activity";
import { apiV1ConfigSchema } from "./dashboard/api/v1/config";
import { captainPostSchema } from "./captain-post/captain-post-config";
import { cronjobsSchema } from "./cron/job-config";
import { validateFleetPermissions } from "./fleet/permissions";
import { fleetControlSchema } from "./fleet/protocol";
import { fleetPolicySchema } from "./fleet/fleet-policy";
import { healthConfigSchema } from "./health/health-config";
import { fold, widestFold } from "./irc/protocol";
import { isLoopbackAddress } from "./lib/loopback";
import {
  mentionNameSchema,
  mentionNamesSchema,
  textMentionRuleSchema,
} from "./shared/mentions";
import { maintenanceSchema } from "./maintenance/nightly/config";
import { notifyConfigError } from "./notifications/ingest/binding";
import { notifySchema } from "./notifications/ingest/config";
import {
  piModelSchema,
  piProviderSchema,
  piThinkingLevelSchema,
  secureLocalOrHttpsURL,
} from "./backends/pi/pi-model";
import { quotaWatchSchema } from "./quota/quota-watch";
import { decodeSettings } from "./settings-errors";
import {
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
import { transcriptionSchema } from "./transcription/transcription";
import { waitingSchema } from "./gateway/waiting";

const absolutePath = Schema.String.check(
  settingsRefine(isAbsolute, { message: "Use an absolute path" }),
);
const envName = Schema.String.check(settingsPattern(/^[A-Z_][A-Z0-9_]*$/));
const userRule = Schema.Union([
  Schema.Literal("*"),
  Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/)),
]);
const channelRule = Schema.Union([
  Schema.Literal("*"),
  Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/)),
]);

export const piDurableBackendSchema = settingsStruct({
  type: Schema.Literal("pi-durable"),
  directory: absolutePath,
  model: piModelSchema,
  provider: Schema.optional(piProviderSchema),
  thinkingLevel: Schema.optional(piThinkingLevelSchema),
  systemPrompt: Schema.String.pipe(
    settingsDefault("You are a helpful assistant responding in Slack."),
  ),
  tools: Schema.Literals(["none", "coding"]).pipe(settingsDefault("none")),
});

const { directory: _piDirectory, ...piCrewBackendFields } =
  piDurableBackendSchema.fields;
/** Crew working directories are supplied by the configured worktree map. */
export const piCrewBackendSchema = settingsStruct(piCrewBackendFields);

/**
 * Built-in Claude Code tools that a `claude` backend may enable. Others, such
 * as scheduling, notification or plan-mode tools, need a reviewed change.
 * Tests check that the pinned SDK still defines every name.
 */
export const claudeToolNames = [
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "LSP",
  "NotebookEdit",
  "Read",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;
/**
 * Bare tool names only. A scoped rule such as `Read(./src/**)` is refused:
 * Claude Code permits reads anywhere in its working directory regardless of
 * the scope, so the rule would promise a limit that nothing enforces.
 */
const claudeToolsSchema = Schema.mutable(
  Schema.Array(Schema.Literals(claudeToolNames)),
)
  .check(Schema.isMaxLength(claudeToolNames.length))
  .check(
    settingsRefine((tools) => new Set(tools).size === tools.length, {
      message: "Duplicate allowedTools entry",
    }),
  );

/** Explicit, operator-controlled MCP servers; no embedded credentials. */
const claudeMcpServersSchema = settingsRecord(
  Schema.String.check(settingsPattern(/^[a-z][a-z0-9_-]{0,31}$/)),
  settingsDiscriminatedUnion("type", [
    settingsStruct({
      type: Schema.Literal("http"),
      url: secureLocalOrHttpsURL,
      headersHelper: Schema.optional(
        Schema.String.check(
          settingsPattern(/^\/[a-zA-Z0-9_./-]+(?: [a-zA-Z0-9_./-]+)*$/, {
            message:
              "Use an absolute executable and optional literal arguments",
          }),
        ),
      ),
    }),
    settingsStruct({
      type: Schema.Literal("stdio"),
      command: absolutePath,
      args: Schema.mutable(Schema.Array(Schema.String)).pipe(
        settingsDefault([]),
      ),
    }),
  ]),
);

/**
 * Claude Agent SDK backend. The model is reached only through the explicit
 * proxy `provider`; there is no native login or API-key fallback.
 */
export const claudeBackendSchema = settingsStruct({
  type: Schema.Literal("claude"),
  /** Starting working directory, not a sandbox. */
  directory: absolutePath,
  model: Schema.String.check(
    settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/, {
      message: "Use a proxy model ID such as claude-sonnet-5-5",
    }),
  ),
  /** Anthropic Messages endpoint ending in `/v1`, as for OpenCode and Pi. */
  provider: piProviderSchema.check(
    settingsRefine((provider) => provider.baseURL.endsWith("/v1"), {
      message: "Claude provider baseURL must end with /v1",
    }),
  ),
  effort: Schema.optional(
    Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
  ),
  /** Appended to Claude Code's own system prompt. */
  systemPrompt: Schema.optional(
    Schema.Trim.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(64_000),
    ),
  ),
  /** The only tools the model can see and run; every other one is absent. */
  allowedTools: claudeToolsSchema.pipe(settingsDefault([])),
  mcpServers: Schema.optional(claudeMcpServersSchema),
  /**
   * Filesystem settings to load from `directory`: `project` loads
   * `.claude/settings.json` and CLAUDE.md, `local` loads
   * `.claude/settings.local.json`. Empty by default.
   */
  settingSources: Schema.mutable(
    Schema.Array(Schema.Literals(["project", "local"])),
  )
    .check(Schema.isMaxLength(2))
    .check(
      settingsRefine((sources) => new Set(sources).size === sources.length, {
        message: "Duplicate settingSources entry",
      }),
    )
    .pipe(settingsDefault([])),
  maxTurns: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(500))
    .pipe(settingsDefault(50)),
});

/**
 * Codex SDK backend. The model is reached only through the explicit proxy
 * `provider` (an OpenAI Responses API endpoint); there is no ChatGPT login,
 * `~/.codex` or API-key fallback. Only settings the Codex sandbox enforces
 * are accepted.
 */
export const codexBackendSchema = settingsStruct({
  type: Schema.Literal("codex"),
  /** Starting working directory and sandbox root, not a host boundary. */
  directory: absolutePath,
  model: Schema.String.check(
    settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, {
      message: "Use a proxy model ID such as gpt-6.1-sol",
    }),
  ),
  /** OpenAI Responses API endpoint ending in `/v1`, as for OpenCode. */
  provider: piProviderSchema.check(
    settingsRefine((provider) => provider.baseURL.endsWith("/v1"), {
      message: "Codex provider baseURL must end with /v1",
    }),
  ),
  reasoningEffort: Schema.optional(
    Schema.Literals(["minimal", "low", "medium", "high", "xhigh"]),
  ),
  /** Added as Codex developer instructions. */
  systemPrompt: Schema.optional(
    Schema.Trim.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(64_000),
    ),
  ),
  /**
   * Codex sandbox for tool commands. `read-only` by default;
   * `workspace-write` permits writes under `directory`;
   * `danger-full-access` runs commands without a sandbox.
   */
  sandbox: Schema.Literals([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]).pipe(settingsDefault("read-only")),
  /**
   * Network for tool commands. Only `workspace-write` switches it; the
   * read-only sandbox always blocks it, and `danger-full-access` cannot
   * block it, so that mode requires `network: true`.
   */
  network: Schema.Boolean.pipe(settingsDefault(false)),
  /** Read `AGENTS.md` project instructions from `directory`. */
  projectDocs: Schema.Boolean.pipe(settingsDefault(false)),
  /**
   * Directories after the system ones on the CLI's `PATH`. The operator's
   * own `PATH` is never inherited; every entry is checked at start-up.
   */
  extraPath: Schema.mutable(Schema.Array(absolutePath))
    .check(Schema.isMaxLength(32))
    .pipe(settingsDefault([])),
})
  .check(
    settingsRefine(
      (backend) => !backend.network || backend.sandbox !== "read-only",
      {
        message:
          "The read-only sandbox always blocks network; network: true needs workspace-write",
      },
    ),
  )
  .check(
    settingsRefine(
      (backend) => backend.network || backend.sandbox !== "danger-full-access",
      {
        message:
          "danger-full-access cannot block the network; set network: true",
      },
    ),
  );

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
        // disables checks and must retain the string instead of throwing.
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
  settingsStruct({
    type: Schema.Literal("opencode"),
    url: settingsURL.check(
      settingsRefine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        { message: "Invalid input" },
      ),
    ),
    directory: absolutePath,
    headersEnv: settingsRecord(Schema.String, envName).pipe(
      settingsDefault({}),
    ),
    sessionID: Schema.optional(
      Schema.String.check(Schema.isMaxCodePoints(256)).check(
        settingsPattern(/^ses_[A-Za-z0-9]+$/),
      ),
    ),
    agent: Schema.optional(Schema.String.check(Schema.isMinCodePoints(1))),
    enforcePermissions: Schema.optional(Schema.Boolean),
    model: Schema.optional(
      settingsStruct({
        providerID: Schema.String.check(Schema.isMinCodePoints(1)),
        id: Schema.String.check(Schema.isMinCodePoints(1)),
      }),
    ),
    permissions: Schema.mutable(
      Schema.Array(
        settingsStruct({
          action: Schema.String.check(Schema.isMinCodePoints(1)),
          resource: Schema.String.check(Schema.isMinCodePoints(1)),
          effect: Schema.Literals(["allow", "deny", "ask"]),
        }),
      ),
    ).pipe(settingsDefault([{ action: "*", resource: "*", effect: "deny" }])),
  }),
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
    settingsDefault({ delayMs: 5000, intervalMs: 10000 }),
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

// IRC names are matched without case. Accounts and nicks stay within the
// common RFC 2812 nick alphabet; channels use `#` or `&`, no spaces/commas.
const ircNickPattern = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,31}$/;
const ircAccount = Schema.String.check(settingsPattern(ircNickPattern));
// At most 50 bytes (a common CHANNELLEN); JOIN lines are batched to 512.
const ircChannel = Schema.String.check(settingsPattern(/^[#&][^\s,:]{1,49}$/))
  .check(
    settingsRefine((name) => Buffer.byteLength(name, "utf8") <= 50, {
      message: "IRC channel names are limited to 50 bytes",
    }),
  )
  .check(
    settingsRefine(
      (name) => [...name].every((char) => char >= " " && char !== "\u007f"),
      { message: "IRC channel names cannot contain control characters" },
    ),
  );
const loopbackHosts = new Set(["127.0.0.1", "::1"]);

export const defaultAllCallWords = ["all hands", "all crew", "everyone"];

const ircServerSchema = settingsStruct({
  host: Schema.String.check(settingsPattern(/^[A-Za-z0-9.:-]{1,253}$/)),
  port: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(65_535)),
  tls: Schema.Boolean,
  /** PEM file of a private CA. Without it, system roots verify the server. */
  caFile: Schema.optional(absolutePath),
  /**
   * Expected ISUPPORT NETWORK name, for example `Fleet`. Stargate refuses a
   * server that announces another name. Part of the namespace, with host
   * and port.
   */
  network: Schema.optional(
    Schema.String.check(settingsPattern(/^[A-Za-z0-9._-]{1,64}$/)),
  ),
  /**
   * FILEHOST upload URL to use when the server does not advertise
   * soju.im/FILEHOST or draft/FILEHOST. A different advertised origin
   * turns files off rather than choosing one.
   */
  filehostOverride: Schema.optional(
    settingsURL.check(Schema.isMaxCodePoints(2048)).check(
      settingsRefine(
        (value) => {
          const url = new URL(value);
          return (
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" && isLoopbackAddress(url.hostname)))
          );
        },
        {
          message:
            "Use an HTTPS URL (HTTP only on loopback) without credentials, query or fragment",
        },
      ),
    ),
  ),
})
  .check(
    settingsRefine((server) => server.tls || loopbackHosts.has(server.host), {
      message:
        "Plaintext IRC is allowed only for 127.0.0.1 or ::1; set tls: true",
    }),
  )
  .check(
    settingsRefine((server) => server.tls || server.caFile === undefined, {
      message: "caFile requires tls: true",
    }),
  );

const ircCrewSchema = settingsStruct({
  /** Short crew member ID, for example `chief`. */
  id: Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,31}$/)),
  displayName: Schema.optional(
    Schema.Trim.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(100),
    ),
  ),
  account: ircAccount,
  passwordEnv: Schema.optional(envName),
  /** Private certificate and key for this account's SASL EXTERNAL login. */
  clientPemFile: Schema.optional(absolutePath),
  /** Defaults to the account; Ergo forces nick = account anyway. */
  nick: Schema.optional(ircAccount),
  /**
   * Channels the captain grants this member. Only these are ever joined; an
   * invite to any other channel is ignored. Currently exactly one channel.
   */
  channels: Schema.mutable(Schema.Array(ircChannel)).check(
    Schema.isBetweenLength(1, 1),
  ),
  /** Unpinned: one session per IRC channel, never the crew task session. */
  backend: backendSchema.check(
    settingsRefine(
      (backend) =>
        backend.type !== "opencode" || backend.sessionID === undefined,
      {
        message:
          "IRC crew backends must not pin a sessionID; crew task sessions stay with the crew plugin",
      },
    ),
  ),
  concurrency: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(32))
    .pipe(settingsDefault(2)),
  turnTimeoutMs: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(3_600_000))
    .pipe(settingsDefault(1_800_000)),
});

/**
 * Optional IRCv3 features. Each is used only when the server offers it;
 * these switches can turn one off. Question defaults depend on the registration.
 */
const ircFeaturesSchema = settingsStruct({
  steerThreadFollowUps: Schema.Boolean.pipe(settingsDefault(false)),
  /** Bridge native clarification forms to their original authenticated requester. */
  questions: Schema.optional(Schema.Boolean),
  /** Download FILEHOST links in admitted messages as attachments. */
  filesIn: Schema.Boolean.pipe(settingsDefault(true)),
  /** Upload published reply files to FILEHOST and post their links. */
  filesOut: Schema.Boolean.pipe(settingsDefault(true)),
  /** Send each reply chunk as one draft/multiline batch. */
  multiline: Schema.Boolean.pipe(settingsDefault(true)),
  /** Also refresh typing during verified human fleet requests. */
  fleetTyping: Schema.optional(Schema.Boolean),
  /** Send +typing while a turn runs (needs message-tags). */
  typing: Schema.Boolean.pipe(settingsDefault(true)),
  /** Emit confirmed OpenCode lifecycle stages and enable read-only IRC status. */
  liveProgress: Schema.optional(Schema.Boolean),
  /** Fleet captains acknowledge human requests and report long turns. */
  turnStatus: Schema.Boolean.pipe(settingsDefault(true)),
  /** +draft/react for reaction replies, and Stop by reaction. */
  reactions: Schema.Boolean.pipe(settingsDefault(true)),
  /** Native crew questions use the pinned owner gateway. */
  crewQuestionHandoff: Schema.optional(Schema.Boolean),

  /** CHATHISTORY catch-up of missed messages (persisted cursor). */
  catchUp: Schema.Boolean.pipe(settingsDefault(true)),
  /** draft/persistence: ask the server to keep the account always-on. */
  alwaysOn: Schema.Boolean.pipe(settingsDefault(true)),
  /** Set the ISUPPORT BOT user mode (for example +B). */
  botMode: Schema.Boolean.pipe(settingsDefault(true)),
  /** draft/read-marker: MARKREAD after each accepted message. */
  readMarker: Schema.Boolean.pipe(settingsDefault(true)),
});
export const ircFeatureDefaults = {
  steerThreadFollowUps: false,
  filesIn: true,
  filesOut: true,
  multiline: true,
  typing: true,
  turnStatus: true,
  reactions: true,
  catchUp: true,
  alwaysOn: true,
  botMode: true,
  readMarker: true,
};

const ircConfiguredSchema = settingsStruct({
  id: Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  displayName: Schema.optional(
    Schema.Trim.check(Schema.isMinCodePoints(1)).check(
      Schema.isMaxCodePoints(100),
    ),
  ),
  server: ircServerSchema,
  /** Expected SASL account of the captain bot. */
  account: ircAccount,
  passwordEnv: Schema.optional(envName),
  /** Owner-only PEM bundle used for SASL EXTERNAL instead of a password. */
  clientPemFile: Schema.optional(absolutePath),
  /** Defaults to the account. */
  nick: Schema.optional(ircAccount),
  /** The only channels the captain joins; the first is the ship channel. */
  channels: Schema.mutable(Schema.Array(ircChannel))
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(20)),
  /** Role-aware fleet defaults; home is this ship or the rear admiral's room. */
  fleetChannels: Schema.optional(
    settingsStruct({ home: ircChannel, command: ircChannel }),
  ),
  access: settingsStruct({
    /** When set, only these exact SASL accounts may start a turn. */
    allowedAccounts: Schema.optional(
      Schema.mutable(Schema.Array(ircAccount))
        .check(Schema.isMinLength(1))
        .check(Schema.isMaxLength(50)),
    ),
    /** Require an exact current nick mention in joined channels and a real msgid. */
    channelRequests: Schema.optional(
      Schema.Literals(["nick-mention", "standard"]),
    ),
    /** Explicit channels that wake on every admitted account's message. */
    wakeChannels: Schema.optional(
      Schema.mutable(Schema.Array(ircChannel)).check(Schema.isMaxLength(20)),
    ),
    /** Captain-only automatic human requests; reply membership is gateway-owned. */
    humanWakeChannels: Schema.optional(
      Schema.mutable(
        Schema.Array(
          settingsStruct({
            channel: ircChannel,
            replies: Schema.Literals(["all", "participating"]),
          }),
        ),
      ).check(Schema.isMaxLength(20)),
    ),
    /** Quiet window for consecutive live human messages; absent/0 is off. */
    humanMessageDebounceMs: Schema.optional(
      Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(5000)),
    ),
    /** Any SASL account may write unless denied; `*` denies everyone. */
    deniedAccounts: Schema.mutable(
      Schema.Array(Schema.Union([Schema.Literal("*"), ircAccount])),
    ).pipe(settingsDefault([])),
    /** `*` also blocks direct messages. */
    deniedChannels: Schema.mutable(
      Schema.Array(Schema.Union([Schema.Literal("*"), ircChannel])),
    ).pipe(settingsDefault([])),
    /** Words that address the captain in its channels, like a nick mention. */
    textMentions: Schema.optional(mentionNamesSchema),
    /**
     * All-call words (whole words, any case): a channel message that
     * contains one reaches the captain and every crew member in that
     * channel. `[]` turns all-calls off.
     */
    allCallWords: Schema.mutable(Schema.Array(mentionNameSchema))
      .check(Schema.isMaxLength(20))
      .pipe(settingsDefault([...defaultAllCallWords])),
    /** Authenticated accounts of other fleet captains. */
    peerCaptains: Schema.optional(
      Schema.mutable(Schema.Array(ircAccount)).check(Schema.isMaxLength(50)),
    ),
    /** Peer turns per receiving connection and conversation in a rolling hour; defaults to 30. */
    peerTurnsPerHour: Schema.optional(
      Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(600)),
    ),
    /**
     * Ship (captain/crew) messages admitted per agent in a rolling hour.
     * A channel's cap is this value times the ship agents configured in
     * it, counted across the whole ship. `0` turns ship messages off.
     */
    shipTurnsPerAgentPerHour: Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(600))
      .pipe(settingsDefault(60)),
    /**
     * All-call turns start this many milliseconds apart: the captain at
     * once, then each crew member of the channel in configuration order.
     * Each later turn lists what was said since the all-call. `0` is off.
     */
    allCallStaggerMs: Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(30_000))
      .pipe(settingsDefault(4000)),
  }).pipe(
    settingsDefault({
      deniedAccounts: [],
      deniedChannels: [],
      allCallWords: [...defaultAllCallWords],
      shipTurnsPerAgentPerHour: 60,
      allCallStaggerMs: 4000,
    }),
  ),
  crew: Schema.mutable(Schema.Array(ircCrewSchema))
    .check(Schema.isMaxLength(20))
    .pipe(settingsDefault([])),
  features: ircFeaturesSchema.pipe(settingsDefault(ircFeatureDefaults)),
  /**
   * Reactions (+draft/react) that stop an active turn when a person
   * reacts to its request or to a bot message answering it. `[]` is off.
   */
  stopReactions: Schema.mutable(
    Schema.Array(
      Schema.String.check(Schema.isMinCodePoints(1)).check(
        Schema.isMaxCodePoints(32),
      ),
    ),
  )
    .check(Schema.isMaxLength(10))
    .pipe(settingsDefault(["✋", "🛑"])),
  /** Catch-up replays at most this many hours, whatever the cursor. */
  catchUpHours: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(168))
    .pipe(settingsDefault(24)),
  /**
   * Speech-to-text for audio and video files in admitted messages, as for
   * Slack bots; absent is off. Spoken mentions are Slack-only.
   */
  transcription: Schema.optional(
    transcriptionSchema.check(
      settingsRefine((value) => value.spokenMentions === undefined, {
        message: "spokenMentions is not supported on IRC",
      }),
    ),
  ),
  /** Authenticated private recipient for unowned native questions on a pinned captain. */
  questionOperator: Schema.optional(ircAccount),
  /**
   * DM audit mirror: the captain connection posts a copy of every direct
   * message that the captain or a crew connection receives or sends to
   * this channel. Absent is off. The channel is never a conversation.
   */
  audit: Schema.optional(settingsStruct({ channel: ircChannel })),
  /**
   * `agent`: the captain answers direct messages (crew ignore them).
   * `redirect`: every connection answers a direct message with a NOTICE
   * that points to its ship channel and never acts on its content.
   */
  dmPolicy: Schema.Literals(["agent", "redirect"]).pipe(
    settingsDefault("agent"),
  ),
  /**
   * Crew messaging over IRC (OpenCode captain; opt-in). `sessions` binds
   * each crew IRC session to its crew member in the crew plugin, so
   * stargate_dm and stargate_mail work there. `ircCopies` also sends each stargate_dm
   * between two ship agents with IRC connections as an IRC DM from the
   * sender's account.
   */
  crewMessaging: settingsStruct({
    sessions: Schema.Boolean.pipe(settingsDefault(false)),
    ircCopies: Schema.Boolean.pipe(settingsDefault(false)),
  }).pipe(settingsDefault({ sessions: false, ircCopies: false })),
  backend: backendSchema,
  fleetPolicy: Schema.optional(fleetPolicySchema),
  fleetControl: Schema.optional(fleetControlSchema),
  concurrency: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(32))
    .pipe(settingsDefault(4)),
  turnTimeoutMs: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(3_600_000))
    .pipe(settingsDefault(3_600_000)),
});

/** Persisted operator configuration: fleet-derived fields remain absent. */
export type IrcConfig = typeof ircConfiguredSchema.Type;
export function ircFeedbackDefaults(config: IrcConfig) {
  const native = config.backend.type === "opencode";
  return {
    questions: native && !!config.fleetPolicy?.humanAccounts.length,
    crewQuestionHandoff:
      config.backend.type === "opencode" && !!config.backend.sessionID,
    liveProgress: true,
    fleetTyping: true,
  };
}

export type EffectiveIrcConfig = IrcConfig & {
  features: IrcConfig["features"] & ReturnType<typeof ircFeedbackDefaults>;
  access: IrcConfig["access"] & { peerCaptains: string[] };
};

/** Enrolment and an explicit trusted role are both required for automatic grants. */
function fleetRoster(config: IrcConfig) {
  const own = new Set(
    [config.account, ...config.crew.map((member) => member.account)].map(
      (account) => fold(account),
    ),
  );
  const enrolled = new Set(
    config.fleetPolicy?.agentAccounts.map((account) => fold(account)) ?? [],
  );
  return (
    config.fleetControl?.targets.filter(
      (target) =>
        !own.has(fold(target.account)) &&
        enrolled.has(fold(target.account)) &&
        (target.role === "captain" || target.role === "rear_admiral"),
    ) ?? []
  );
}

/** Runtime view only; never write derived membership/wake/trust back to disk. */
export function effectiveIrcConfig(config: IrcConfig): EffectiveIrcConfig {
  const access = {
    ...config.access,
    peerCaptains: config.access.peerCaptains ?? [],
  };
  const defaults = ircFeedbackDefaults(config);
  const features = {
    ...config.features,
    questions: config.features.questions ?? defaults.questions,
    crewQuestionHandoff:
      config.features.crewQuestionHandoff ?? defaults.crewQuestionHandoff,
    liveProgress: config.features.liveProgress ?? defaults.liveProgress,
    fleetTyping: config.features.fleetTyping ?? defaults.fleetTyping,
  };
  const metadata = config.fleetChannels;
  if (
    !metadata ||
    !config.fleetPolicy ||
    !config.fleetControl ||
    config.fleetPolicy.role === "crew"
  )
    return { ...config, access, features };
  const roster = fleetRoster(config);
  // Explicit legacy wake configuration retains its complete admission policy.
  if (access.channelRequests === undefined && access.wakeChannels === undefined)
    access.channelRequests = "nick-mention";
  if (
    access.humanWakeChannels === undefined &&
    access.wakeChannels === undefined
  )
    access.humanWakeChannels =
      config.fleetPolicy.role === "rear_admiral"
        ? [{ channel: metadata.home, replies: "all" }]
        : [
            { channel: metadata.home, replies: "all" },
            { channel: metadata.command, replies: "participating" },
          ];
  if (config.access.peerCaptains === undefined) {
    const seen = new Set<string>();
    access.peerCaptains = roster.flatMap((target) => {
      const key = fold(target.account);
      if (seen.has(key)) return [];
      seen.add(key);
      return [target.account];
    });
  }
  const seen = new Set<string>();
  const channels = [
    ...config.channels,
    metadata.home,
    metadata.command,
    ...roster
      .filter((target) => target.role === "captain")
      .map((target) => target.channel),
  ].filter((channel) => {
    const key = fold(channel);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...config, access, channels, features };
}

export const ircSchema = ircConfiguredSchema.check(
  settingsCheck((configured, context) => {
    const irc = effectiveIrcConfig(configured);
    if (irc.fleetChannels) {
      if (
        !irc.fleetPolicy ||
        !irc.fleetControl ||
        irc.fleetPolicy.role === "crew" ||
        fold(irc.fleetChannels.home) === fold(irc.fleetChannels.command)
      )
        context.addIssue({
          code: "custom",
          message:
            "Fleet channels need a captain/rear-admiral policy, target roster and distinct home/command channels",
        });
      else {
        for (const target of fleetRoster(configured))
          if (
            target.role === "captain" &&
            !Result.isSuccess(
              Schema.decodeUnknownResult(ircChannel)(target.channel),
            )
          )
            context.addIssue({
              code: "custom",
              path: [
                "fleetControl",
                "targets",
                configured.fleetControl?.targets.indexOf(target) ?? 0,
                "channel",
              ],
              message: "Derived fleet membership requires a valid IRC channel",
            });
        if (
          !Result.isSuccess(
            Schema.decodeUnknownResult(
              Schema.mutable(Schema.Array(ircAccount)).check(
                Schema.isMaxLength(50),
              ),
            )(irc.access.peerCaptains),
          )
        )
          context.addIssue({
            code: "custom",
            path: ["access", "peerCaptains"],
            message:
              "Fleet IRC peer defaults must be at most 50 valid SASL accounts; configure an explicit peer list to narrow them",
          });
        if (irc.channels.length > 20)
          context.addIssue({
            code: "custom",
            message: "Fleet channel membership exceeds 20 configured channels",
          });
      }
    }
    if (irc.fleetControl && irc.backend.type === "opencode") {
      try {
        validateFleetPermissions(irc.backend.permissions);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["backend", "permissions"],
          message:
            "Fleet IPC requires supported explicit allow/deny rules; native ask decisions cannot authorise gateway operations",
        });
      }
    }
    if (
      irc.fleetControl &&
      (!irc.fleetPolicy ||
        irc.backend.type !== "opencode" ||
        !irc.backend.sessionID)
    )
      context.addIssue({
        code: "custom",
        message:
          "Fleet control needs an explicit policy and pinned OpenCode root",
      });
    if (
      irc.features.crewQuestionHandoff &&
      (irc.backend.type !== "opencode" || !irc.backend.sessionID)
    )
      context.addIssue({
        code: "custom",
        message:
          "Crew question handoff requires a pinned OpenCode registration",
      });

    if (
      irc.access.wakeChannels?.some(
        (channel) => !irc.channels.includes(channel),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Wake channels must be joined channels",
      });
    if (
      irc.access.wakeChannels?.length &&
      irc.access.channelRequests === "nick-mention"
    )
      context.addIssue({
        code: "custom",
        message: "Wake channels conflict with nick-mention-only admission",
      });
    if (
      irc.questionOperator &&
      (!irc.features.questions ||
        irc.access.deniedChannels.includes("*") ||
        irc.access.deniedAccounts.some(
          (a) => a === "*" || fold(a) === fold(irc.questionOperator ?? ""),
        ) ||
        (irc.access.allowedAccounts &&
          !irc.access.allowedAccounts.some(
            (a) => a === "*" || fold(a) === fold(irc.questionOperator ?? ""),
          )) ||
        irc.backend.type !== "opencode" ||
        !irc.backend.sessionID ||
        !irc.fleetPolicy?.humanAccounts.some(
          (account) => fold(account) === fold(irc.questionOperator ?? ""),
        ) ||
        irc.fleetPolicy.agentAccounts.some(
          (account) => fold(account) === fold(irc.questionOperator ?? ""),
        ))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "questionOperator requires native questions, a pinned OpenCode session and an enrolled human account",
      });
    }
    if (configured.features.questions && !irc.fleetPolicy?.humanAccounts.length)
      context.addIssue({
        code: "custom",
        message:
          "Native IRC questions require a fleet policy with explicit humanAccounts",
      });
    if (irc.access.humanWakeChannels?.length) {
      const keys = irc.access.humanWakeChannels.map(({ channel }) =>
        fold(channel),
      );
      if (!irc.fleetPolicy)
        context.addIssue({
          code: "custom",
          message: "Human wake channels require an explicit fleet policy",
        });
      if (
        new Set(keys).size !== keys.length ||
        keys.some(
          (key) => !irc.channels.some((channel) => fold(channel) === key),
        )
      )
        context.addIssue({
          code: "custom",
          message: "Human wake channels must be unique joined channels",
        });
      if (irc.audit && keys.includes(fold(irc.audit.channel)))
        context.addIssue({
          code: "custom",
          message: "The audit channel cannot be a human wake channel",
        });
    }
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    // Collisions fold with rfc1459, the widest classic CASEMAPPING, so names
    // any server treats as equal are refused. Grants (crew ⊆ captain) only
    // ASCII-lower-case, the narrowest: a name that differs under any
    // mapping is not the captain's channel.
    const lower = (value: string) => fold(value);
    const exact = (value: string) => fold(value, "ascii");
    const accounts = [irc.account, ...irc.crew.map((member) => member.account)];
    if (new Set(accounts.map(lower)).size !== accounts.length)
      issue("Captain and crew need distinct IRC accounts");
    const nicks = [
      irc.nick ?? irc.account,
      ...irc.crew.map((member) => member.nick ?? member.account),
    ];
    if (new Set(nicks.map(lower)).size !== nicks.length)
      issue("Captain and crew need distinct IRC nicks");
    for (const member of [irc, ...irc.crew]) {
      if (Boolean(member.passwordEnv) === Boolean(member.clientPemFile))
        issue(
          "Set exactly one of passwordEnv (PLAIN) or clientPemFile (EXTERNAL)",
        );
      if (member.clientPemFile && !irc.server.tls)
        issue("IRC clientPemFile requires TLS");
    }
    const secrets = [
      ...(irc.passwordEnv ? [irc.passwordEnv] : []),
      ...irc.crew.flatMap((m) => (m.passwordEnv ? [m.passwordEnv] : [])),
    ];
    if (new Set(secrets).size !== secrets.length)
      issue("Captain and crew need separate passwordEnv variables");
    if (new Set(irc.crew.map((member) => member.id)).size !== irc.crew.length)
      issue("Duplicate IRC crew id");
    if (
      new Set(configured.channels.map(lower)).size !==
      configured.channels.length
    )
      issue("Duplicate IRC channel");
    const granted = new Set(irc.channels.map(exact));
    for (const member of irc.crew)
      if (!member.channels.every((channel) => granted.has(exact(channel))))
        issue(`IRC crew ${member.id} may only join captain channels`);
    const ship = new Set(accounts.map(lower));
    if (irc.access.peerCaptains.some((account) => ship.has(lower(account))))
      issue("peerCaptains must not list this ship's own accounts");
    const audit = irc.audit?.channel;
    if (
      audit !== undefined &&
      [...irc.channels, ...irc.crew.flatMap((member) => member.channels)].some(
        (channel) => widestFold(channel) === widestFold(audit),
      )
    )
      issue("The IRC audit channel must not be a captain or crew channel");
  }),
);

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
    settingsDefault({ delayMs: 5000, intervalMs: 10000 }),
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
    if (value.approvalUsers.length && value.backend.type !== "opencode")
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
      // replies attributed to its own native inputs. Same-transport pins stay
      // unique, so one queue never owns another's cursor.
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
      const slackPins = bots.flatMap((bot) =>
        bot.backend.type === "opencode" && bot.backend.sessionID
          ? [bot.backend.sessionID]
          : [],
      );
      if (
        new Set(teamPins).size !== teamPins.length ||
        teamPins.some((pin) => slackPins.includes(pin))
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
      // ship listing it would answer mirrored lines. Host names and ports do
      // not prove two servers distinct (aliases, addresses, proxies), so every
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
