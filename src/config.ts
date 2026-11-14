import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { crewActivitySchema } from "./activity";
import { cronjobsSchema } from "./cronjob-config";
import { fold, widestFold } from "./irc/protocol";
import {
  mentionNameSchema,
  mentionNamesSchema,
  mentionRuleSchema,
} from "./mentions";
import { maintenanceSchema } from "./nightly/config";
import {
  piModelSchema,
  piProviderSchema,
  piThinkingLevelSchema,
} from "./pi-model";
import { transcriptionSchema } from "./transcription";
import { waitingSchema } from "./waiting";

const absolutePath = z.string().refine(isAbsolute, "Use an absolute path");
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const userRule = z.union([z.literal("*"), z.string().regex(/^[UW][A-Z0-9]+$/)]);
const channelRule = z.union([
  z.literal("*"),
  z.string().regex(/^[CGD][A-Z0-9]+$/),
]);

export const piDurableBackendSchema = z.strictObject({
  type: z.literal("pi-durable"),
  directory: absolutePath,
  model: piModelSchema,
  provider: piProviderSchema.optional(),
  thinkingLevel: piThinkingLevelSchema.optional(),
  systemPrompt: z
    .string()
    .default("You are a helpful assistant responding in Slack."),
  tools: z.enum(["none", "coding"]).default("none"),
});

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
const claudeToolsSchema = z
  .array(z.enum(claudeToolNames))
  .max(claudeToolNames.length)
  .refine((tools) => new Set(tools).size === tools.length, {
    message: "Duplicate allowedTools entry",
  });

/**
 * Claude Agent SDK backend. The model is reached only through the explicit
 * proxy `provider`; there is no native login or API-key fallback.
 */
export const claudeBackendSchema = z.strictObject({
  type: z.literal("claude"),
  /** Starting working directory, not a sandbox. */
  directory: absolutePath,
  model: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/,
      "Use a proxy model ID such as claude-sonnet-5-5",
    ),
  /** Anthropic Messages endpoint ending in `/v1`, as for OpenCode and Pi. */
  provider: piProviderSchema.refine(
    (provider) => provider.baseURL.endsWith("/v1"),
    "Claude provider baseURL must end with /v1",
  ),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Appended to Claude Code's own system prompt. */
  systemPrompt: z.string().trim().min(1).max(64_000).optional(),
  /** The only tools the model can see and run; every other one is absent. */
  allowedTools: claudeToolsSchema.default([]),
  /**
   * Filesystem settings to load from `directory`: `project` loads
   * `.claude/settings.json` and CLAUDE.md, `local` loads
   * `.claude/settings.local.json`. Empty by default.
   */
  settingSources: z
    .array(z.enum(["project", "local"]))
    .max(2)
    .refine((sources) => new Set(sources).size === sources.length, {
      message: "Duplicate settingSources entry",
    })
    .default([]),
  maxTurns: z.number().int().min(1).max(500).default(50),
});

// HTTP is permitted only for Tailscale names/addresses. Public routes need TLS.
const pairingOrigin = z
  .url()
  .max(2048)
  .refine((value) => {
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
  }, "Use an HTTPS origin, or an HTTP Tailscale origin, without credentials, path, query or fragment")
  .transform((value) => new URL(value).origin);

const pairingSchema = z.strictObject({
  operators: z
    .array(z.string().regex(/^[UW][A-Z0-9]+$/))
    .min(1)
    .max(100),
  urls: z.array(pairingOrigin).min(1).max(5),
});

export const backendSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("opencode"),
    url: z
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    directory: absolutePath,
    headersEnv: z.record(z.string(), envName).default({}),
    sessionID: z
      .string()
      .max(256)
      .regex(/^ses_[A-Za-z0-9]+$/)
      .optional(),
    agent: z.string().min(1).optional(),
    model: z
      .strictObject({ providerID: z.string().min(1), id: z.string().min(1) })
      .optional(),
    permissions: z
      .array(
        z.strictObject({
          action: z.string().min(1),
          resource: z.string().min(1),
          effect: z.enum(["allow", "deny"]),
        }),
      )
      .default([{ action: "*", resource: "*", effect: "deny" }]),
  }),
  piDurableBackendSchema,
  claudeBackendSchema,
  z.strictObject({
    type: z.literal("module"),
    module: absolutePath,
    options: z.record(z.string(), z.unknown()).default({}),
  }),
]);

export const botSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  displayName: z.string().trim().min(1).max(100).optional(),
  slack: z.strictObject({
    appId: z.string().regex(/^A[A-Z0-9]+$/),
    appTokenEnv: envName,
    botTokenEnv: envName,
  }),
  access: z.strictObject({
    users: z.array(userRule).min(1),
    channels: z.array(channelRule).min(1),
    deniedUsers: z.array(userRule).default([]),
    deniedChannels: z.array(channelRule).default([]),
    mentionOnly: z.boolean().default(false),
    /** Admit verified peer captain bots (`*-captain`); other bots stay rejected. */
    peerCaptains: z.boolean().optional(),
    /** Peer captain turns per thread/hour; absent keeps the default of five. */
    peerTurnsPerHour: z.number().int().min(0).max(600).optional(),
    /**
     * In these channels, a top-level message whose text contains one of the
     * names starts a conversation like a mention. Absent is off.
     */
    textMentions: mentionRuleSchema.optional(),
  }),
  backend: backendSchema,
  cronjobs: cronjobsSchema.optional(),
  pairing: pairingSchema.optional(),
  threadContext: z.boolean().default(false),
  /** Speech-to-text for accepted audio and video messages; absent is off. */
  transcription: transcriptionSchema.optional(),
  waiting: waitingSchema.default({ delayMs: 5000, intervalMs: 10000 }),
  crewActivity: crewActivitySchema.default({
    detail: "off",
  }),
  concurrency: z.number().int().min(1).max(32).default(4),
  turnTimeoutMs: z.number().int().min(1000).max(3_600_000).default(1_800_000),
});

// IRC names are matched without case. Accounts and nicks stay within the
// common RFC 2812 nick alphabet; channels use `#` or `&`, no spaces/commas.
const ircNickPattern = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,31}$/;
const ircAccount = z.string().regex(ircNickPattern);
// At most 50 bytes (a common CHANNELLEN); JOIN lines are batched to 512.
const ircChannel = z
  .string()
  .regex(/^[#&][^\s,:]{1,49}$/)
  .refine(
    (name) => Buffer.byteLength(name, "utf8") <= 50,
    "IRC channel names are limited to 50 bytes",
  )
  .refine(
    (name) => [...name].every((char) => char >= " " && char !== "\u007f"),
    "IRC channel names cannot contain control characters",
  );
const loopbackHosts = new Set(["127.0.0.1", "::1"]);

export const defaultAllCallWords = ["all hands", "all crew", "everyone"];

const ircServerSchema = z
  .strictObject({
    host: z.string().regex(/^[A-Za-z0-9.:-]{1,253}$/),
    port: z.number().int().min(1).max(65_535),
    tls: z.boolean(),
    /** PEM file of a private CA. Without it, system roots verify the server. */
    caFile: absolutePath.optional(),
    /**
     * Expected ISUPPORT NETWORK name, for example `Fleet`. Pogo refuses a
     * server that announces another name. Part of the namespace, with host
     * and port.
     */
    network: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    /**
     * FILEHOST upload URL to use when the server does not advertise
     * soju.im/FILEHOST or draft/FILEHOST. A different advertised origin
     * turns files off rather than choosing one.
     */
    filehostOverride: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      }, "Use an HTTPS URL (HTTP only on loopback) without credentials, query or fragment")
      .optional(),
  })
  .refine(
    (server) => server.tls || loopbackHosts.has(server.host),
    "Plaintext IRC is allowed only for 127.0.0.1 or ::1; set tls: true",
  )
  .refine(
    (server) => server.tls || server.caFile === undefined,
    "caFile requires tls: true",
  );

const ircCrewSchema = z.strictObject({
  /** Short crew member ID, for example `chief`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  displayName: z.string().trim().min(1).max(100).optional(),
  account: ircAccount,
  passwordEnv: envName,
  /** Defaults to the account; Ergo forces nick = account anyway. */
  nick: ircAccount.optional(),
  /**
   * Channels the captain grants this member. Only these are ever joined; an
   * invite to any other channel is ignored. Currently exactly one channel.
   */
  channels: z.array(ircChannel).length(1),
  /** Unpinned: one session per IRC channel, never the crew task session. */
  backend: backendSchema.refine(
    (backend) => backend.type !== "opencode" || backend.sessionID === undefined,
    "IRC crew backends must not pin a sessionID; crew task sessions stay with the crew plugin",
  ),
  concurrency: z.number().int().min(1).max(32).default(2),
  turnTimeoutMs: z.number().int().min(1000).max(3_600_000).default(1_800_000),
});

/**
 * Optional IRCv3 features. Each is used only when the server offers it;
 * these switches can turn one off. All default on.
 */
const ircFeaturesSchema = z.strictObject({
  /** Download FILEHOST links in admitted messages as attachments. */
  filesIn: z.boolean().default(true),
  /** Upload published reply files to FILEHOST and post their links. */
  filesOut: z.boolean().default(true),
  /** Send each reply chunk as one draft/multiline batch. */
  multiline: z.boolean().default(true),
  /** Send +typing while a turn runs (needs message-tags). */
  typing: z.boolean().default(true),
  /** +draft/react for reaction replies, and Stop by reaction. */
  reactions: z.boolean().default(true),
  /** CHATHISTORY catch-up of missed messages (persisted cursor). */
  catchUp: z.boolean().default(true),
  /** draft/persistence: ask the server to keep the account always-on. */
  alwaysOn: z.boolean().default(true),
  /** Set the ISUPPORT BOT user mode (for example +B). */
  botMode: z.boolean().default(true),
  /** draft/read-marker: MARKREAD after each accepted message. */
  readMarker: z.boolean().default(true),
});
const ircFeatureDefaults = {
  filesIn: true,
  filesOut: true,
  multiline: true,
  typing: true,
  reactions: true,
  catchUp: true,
  alwaysOn: true,
  botMode: true,
  readMarker: true,
};

export const ircSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    displayName: z.string().trim().min(1).max(100).optional(),
    server: ircServerSchema,
    /** SASL PLAIN account of the captain bot. */
    account: ircAccount,
    passwordEnv: envName,
    /** Defaults to the account. */
    nick: ircAccount.optional(),
    /** The only channels the captain joins; the first is the ship channel. */
    channels: z.array(ircChannel).min(1).max(20),
    access: z
      .strictObject({
        /** Any SASL account may write unless denied; `*` denies everyone. */
        deniedAccounts: z
          .array(z.union([z.literal("*"), ircAccount]))
          .default([]),
        /** `*` also blocks direct messages. */
        deniedChannels: z
          .array(z.union([z.literal("*"), ircChannel]))
          .default([]),
        /** Words that address the captain in its channels, like a nick mention. */
        textMentions: mentionNamesSchema.optional(),
        /**
         * All-call words (whole words, any case): a channel message that
         * contains one reaches the captain and every crew member in that
         * channel. `[]` turns all-calls off.
         */
        allCallWords: z
          .array(mentionNameSchema)
          .max(20)
          .default([...defaultAllCallWords]),
        /** Accounts of other fleet captains: peer rules, 5 per target an hour. */
        peerCaptains: z.array(ircAccount).max(50).default([]),
        /** Peer turns per conversation/hour; absent keeps the default of five. */
        peerTurnsPerHour: z.number().int().min(0).max(600).optional(),
        /**
         * Ship (captain/crew) messages admitted per agent in a rolling hour.
         * A channel's cap is this value times the ship agents configured in
         * it, counted across the whole ship. `0` turns ship messages off.
         */
        shipTurnsPerAgentPerHour: z.number().int().min(0).max(600).default(60),
        /**
         * All-call turns start this many milliseconds apart: the captain at
         * once, then each crew member of the channel in configuration order.
         * Each later turn lists what was said since the all-call. `0` is off.
         */
        allCallStaggerMs: z.number().int().min(0).max(30_000).default(4000),
      })
      .default({
        deniedAccounts: [],
        deniedChannels: [],
        peerCaptains: [],
        allCallWords: [...defaultAllCallWords],
        shipTurnsPerAgentPerHour: 60,
        allCallStaggerMs: 4000,
      }),
    crew: z.array(ircCrewSchema).max(20).default([]),
    features: ircFeaturesSchema.default(ircFeatureDefaults),
    /**
     * Reactions (+draft/react) that stop an active turn when a person
     * reacts to its request or to a bot message answering it. `[]` is off.
     */
    stopReactions: z
      .array(z.string().min(1).max(32))
      .max(10)
      .default(["✋", "🛑"]),
    /** Catch-up replays at most this many hours, whatever the cursor. */
    catchUpHours: z.number().int().min(1).max(168).default(24),
    /**
     * Speech-to-text for audio and video files in admitted messages, as for
     * Slack bots; absent is off. Spoken mentions are Slack-only.
     */
    transcription: transcriptionSchema
      .refine(
        (value) => value.spokenMentions === undefined,
        "spokenMentions is not supported on IRC",
      )
      .optional(),
    /**
     * DM audit mirror: the captain connection posts a copy of every direct
     * message that the captain or a crew connection receives or sends to
     * this channel. Absent is off. The channel is never a conversation.
     */
    audit: z.strictObject({ channel: ircChannel }).optional(),
    /**
     * `agent`: the captain answers direct messages (crew ignore them).
     * `redirect`: every connection answers a direct message with a NOTICE
     * that points to its ship channel and never acts on its content.
     */
    dmPolicy: z.enum(["agent", "redirect"]).default("agent"),
    /**
     * Crew messaging over IRC (OpenCode captain; opt-in). `sessions` binds
     * each crew IRC session to its crew member in the crew plugin, so
     * pogo_dm and pogo_mail work there. `ircCopies` also sends each pogo_dm
     * between two ship agents with IRC connections as an IRC DM from the
     * sender's account.
     */
    crewMessaging: z
      .strictObject({
        sessions: z.boolean().default(false),
        ircCopies: z.boolean().default(false),
      })
      .default({ sessions: false, ircCopies: false }),
    backend: backendSchema,
    concurrency: z.number().int().min(1).max(32).default(4),
    turnTimeoutMs: z.number().int().min(1000).max(3_600_000).default(1_800_000),
  })
  .superRefine((irc, context) => {
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
    const secrets = [irc.passwordEnv, ...irc.crew.map((m) => m.passwordEnv)];
    if (new Set(secrets).size !== secrets.length)
      issue("Captain and crew need separate passwordEnv variables");
    if (new Set(irc.crew.map((member) => member.id)).size !== irc.crew.length)
      issue("Duplicate IRC crew id");
    if (new Set(irc.channels.map(lower)).size !== irc.channels.length)
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
  });

export type IrcConfig = z.infer<typeof ircSchema>;
export type IrcCrewConfig = IrcConfig["crew"][number];

/** Registration IDs: Slack bots, IRC captains and `<irc id>-<crew id>`. */
export function registrationIds(config: {
  bots: readonly { id: string }[];
  irc: readonly IrcConfig[];
}) {
  return [
    ...config.bots.map((bot) => bot.id),
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
}) {
  return [
    ...new Set(
      [...config.bots, ...config.irc].flatMap((registration) =>
        registration.backend.type === "opencode" &&
        registration.backend.sessionID !== undefined
          ? [registration.backend.sessionID]
          : [],
      ),
    ),
  ];
}

export const configSchema = z
  .strictObject({
    dataDirectory: z.string().default(".pogo"),
    /** Serve the read-only fleet dashboard on `<dataDirectory>/dashboard.sock`. */
    dashboard: z.boolean().optional(),
    bots: z.array(botSchema).default([]),
    /** IRCv3 registrations, independent of Slack; see docs/irc.md. */
    irc: z.array(ircSchema).default([]),
    /** Nightly self-update and host maintenance; see docs/maintenance.md. */
    maintenance: maintenanceSchema.optional(),
  })
  .superRefine(({ bots, irc, maintenance }, context) => {
    if (bots.length + irc.length === 0)
      context.addIssue({
        code: "custom",
        path: ["bots"],
        message: "Configure at least one Slack bot or IRC registration",
      });
    const ids = registrationIds({ bots, irc });
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
        message: "Duplicate pinned OpenCode sessionID across IRC registrations",
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
      registration.passwordEnv,
      ...registration.crew.map((member) => member.passwordEnv),
    ]);
    if (new Set(ircSecrets).size !== ircSecrets.length)
      context.addIssue({
        code: "custom",
        message: "Each IRC account needs its own passwordEnv",
      });
    const report = maintenance?.report;
    if (report) {
      const bot = bots.find((item) => item.id === report.bot);
      const allowed = (rules: readonly string[]) =>
        rules.includes("*") || rules.includes(report.channel);
      if (
        !bot ||
        !allowed(bot.access.channels) ||
        allowed(bot.access.deniedChannels)
      )
        context.addIssue({
          code: "custom",
          path: ["maintenance", "report"],
          message:
            "Maintenance report bot must exist and allow the report channel",
        });
    }
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
        context.addIssue({ code: "custom", message: `Duplicate bot ${field}` });
      }
    }
  });

export type BackendConfig = z.infer<typeof backendSchema>;
export type BotConfig = z.infer<typeof botSchema>;
/** Loaded configuration; `dataDirectory` is absolute. */
export type Config = z.infer<typeof configSchema>;

export function secret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export async function loadConfig(path: string) {
  const config = configSchema.parse(await Bun.file(path).json());
  return {
    ...config,
    dataDirectory: resolve(dirname(resolve(path)), config.dataDirectory),
  };
}
