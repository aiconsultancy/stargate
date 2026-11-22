import { Result, Schema } from "effect";
import { fleetPolicySchema } from "../fleet/fleet-policy";
import { fleetControlSchema } from "../fleet/protocol";
import { mentionNameSchema, mentionNamesSchema } from "../shared/mentions";
import { isLoopbackAddress } from "../lib/loopback";
import { fold, widestFold } from "./protocol";
import {
  absolutePath,
  envName,
  settingsCheck,
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
  settingsURL,
} from "../config/settings-schema";

// IRC names are matched without case. Accounts and nicks stay within the
// common RFC 2812 nick alphabet; channels use `#` or `&`, no spaces/commas.
const ircNickPattern = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,31}$/;
export const ircAccount = Schema.String.check(settingsPattern(ircNickPattern));
// At most 50 bytes (a common CHANNELLEN); JOIN lines are batched to 512.
export const ircChannel = Schema.String.check(
  settingsPattern(/^[#&][^\s,:]{1,49}$/),
)
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

type FleetPermission = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};
type IrcBackend =
  | {
      type: "opencode";
      sessionID?: string | undefined;
      permissions: FleetPermission[];
    }
  | { type: "pi-durable" | "claude" | "codex" | "module" };
type RequiredCodec<T, E> = Schema.Codec<T, E> & {
  readonly "~type.optionality": "required";
};

export function createIrcConfig<
  B extends IrcBackend,
  BE,
  T extends { readonly spokenMentions?: unknown },
  TE,
>({
  backendSchema,
  transcriptionSchema,
  validateFleetPermissions,
}: {
  backendSchema: RequiredCodec<B, BE>;
  transcriptionSchema: RequiredCodec<T, TE>;
  validateFleetPermissions: (rules: readonly FleetPermission[]) => void;
}) {
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
  type IrcConfig = typeof ircConfiguredSchema.Type;
  function ircFeedbackDefaults(config: IrcConfig) {
    const native = config.backend.type === "opencode";
    return {
      questions: native && !!config.fleetPolicy?.humanAccounts.length,
      crewQuestionHandoff:
        config.backend.type === "opencode" && !!config.backend.sessionID,
      liveProgress: true,
      fleetTyping: true,
    };
  }

  type EffectiveIrcConfig = IrcConfig & {
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
  function effectiveIrcConfig(config: IrcConfig): EffectiveIrcConfig {
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
    if (
      access.channelRequests === undefined &&
      access.wakeChannels === undefined
    )
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

  const ircSchema = ircConfiguredSchema.check(
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
                message:
                  "Derived fleet membership requires a valid IRC channel",
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
              message:
                "Fleet channel membership exceeds 20 configured channels",
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
      if (
        configured.features.questions &&
        !irc.fleetPolicy?.humanAccounts.length
      )
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
      const accounts = [
        irc.account,
        ...irc.crew.map((member) => member.account),
      ];
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
        [
          ...irc.channels,
          ...irc.crew.flatMap((member) => member.channels),
        ].some((channel) => widestFold(channel) === widestFold(audit))
      )
        issue("The IRC audit channel must not be a captain or crew channel");
    }),
  );

  return { ircSchema, ircFeedbackDefaults, effectiveIrcConfig };
}
