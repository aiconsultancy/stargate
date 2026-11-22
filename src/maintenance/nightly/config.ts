import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { isLocalhost } from "../../lib/loopback";
import {
  piModelSchema,
  piProviderSchema,
  piProxyModel,
  piProxyModels,
} from "../../backends/pi/config";
import {
  settingsCheck,
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
  settingsURL,
} from "../../config/settings-schema";
import { cleanupSchema } from "./cleanup-config";

/** Strict `maintenance` section of stargate.json. Every component is opt-in. */
const absolutePath = Schema.String.check(Schema.isMaxCodePoints(4096))
  .check(settingsRefine(isAbsolute, { message: "Use an absolute path" }))
  .check(
    settingsRefine((path) => !/[\r\n\0]/.test(path), {
      message: "Paths cannot contain newlines",
    }),
  );
const clock = Schema.String.check(
  settingsPattern(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "Use 24-hour HH:MM",
  }),
);
export const timeZoneSchema = Schema.String.check(Schema.isMinCodePoints(1))
  .check(Schema.isMaxCodePoints(100))
  .check(
    settingsRefine(
      (zone) => {
        // Intl accepts fixed offsets; they are not IANA zones and ignore DST.
        if (/^[+-]/.test(zone)) return false;
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Use an IANA time zone name" },
    ),
  );
const envName = Schema.String.check(settingsPattern(/^[A-Z_][A-Z0-9_]*$/));
const repository = Schema.String.check(
  settingsPattern(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
);
const unitName = Schema.String.check(
  settingsPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}\.service$/),
);
const argument = Schema.String.check(Schema.isMinCodePoints(1))
  .check(Schema.isMaxCodePoints(4096))
  .check(
    settingsRefine((value) => ![...value].some((c) => c.charCodeAt(0) < 32), {
      message: "No control characters",
    }),
  );
const command = Schema.mutable(Schema.Array(argument))
  .check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(64));
const url = (loopbackOnly: boolean) =>
  settingsURL.check(
    settingsRefine(
      (value) => {
        const parsed = new URL(value);
        const loopback = isLocalhost(parsed.hostname);
        return (
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash &&
          (loopbackOnly
            ? parsed.protocol === "http:" && loopback
            : parsed.protocol === "https:" ||
              (parsed.protocol === "http:" && loopback))
        );
      },
      {
        message:
          "Use HTTPS, or HTTP on loopback, without credentials, query or fragment",
      },
    ),
  );
const coolOffHours = Schema.Finite.check(Schema.isInt())
  .check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(720));
export const familySchema = Schema.String.check(
  settingsPattern(/^(claude|gpt)-[a-z]+$/),
);
const modelProvider = Schema.String.check(
  settingsPattern(/^[a-z0-9][a-z0-9_-]{0,99}$/),
);
const npmName = Schema.String.check(
  settingsPattern(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
).check(Schema.isMaxCodePoints(214));

/**
 * The idle gate runs again immediately before every disruptive step, so the
 * horizon only has to cover the longest single step after a gate: the
 * OpenCode restart and plugin check (4 minutes), with margin. A schedule
 * that comes due while the gateway is stopped runs once when it is back.
 * A whole-run horizon would block every night on a ship with an hourly cron.
 */
export const defaultCronHorizonMinutes = 10;

export const defaultAgentPackages = [
  { name: "@opencode/cli", command: "opencode2" },
  { name: "@openai/codex", command: "codex" },
  { name: "@anthropic-ai/claude-code", command: "claude" },
  { name: "@earendil-works/pi-coding-agent", command: "pi" },
];

export const maintenanceSchema = settingsStruct({
  enabled: Schema.Boolean.pipe(settingsDefault(false)),
  drain: settingsStruct({
    enabled: Schema.Boolean.pipe(settingsDefault(false)),
    deadlineMinutes: Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(1440))
      .pipe(settingsDefault(10)),
  }).pipe(settingsDefault({ enabled: false, deadlineMinutes: 10 })),
  cleanup: Schema.optional(cleanupSchema),
  /** Stable identity for jitter and reports. Default: hash of host and config path. */
  installID: Schema.optional(
    Schema.String.check(settingsPattern(/^[A-Za-z0-9._:-]{1,100}$/)),
  ),
  window: settingsStruct({
    start: clock.pipe(settingsDefault("00:00")),
    end: clock.pipe(settingsDefault("01:00")),
    timeZone: timeZoneSchema.pipe(settingsDefault("Europe/London")),
    /** Maximum per-install start delay; the actual delay is stable. */
    jitterMinutes: Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(120))
      .pipe(settingsDefault(15)),
    /** No new change starts after `end - reserveMinutes`. */
    reserveMinutes: Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(120))
      .pipe(settingsDefault(10)),
  }).pipe(
    settingsDefault({
      start: "00:00",
      end: "01:00",
      timeZone: "Europe/London",
      jitterMinutes: 15,
      reserveMinutes: 10,
    }),
  ),
  components: settingsStruct({
    stargate: Schema.Boolean.pipe(settingsDefault(false)),
    cliproxyapi: Schema.Boolean.pipe(settingsDefault(false)),
    agentClis: Schema.Boolean.pipe(settingsDefault(false)),
    models: Schema.Boolean.pipe(settingsDefault(false)),
  }).pipe(
    settingsDefault({
      stargate: false,
      cliproxyapi: false,
      agentClis: false,
      models: false,
    }),
  ),
  /** Summary destination; the gateway delivers it through this bot. */
  report: Schema.optional(
    settingsStruct({
      bot: Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
      channel: Schema.String.check(settingsPattern(/^[CG][A-Z0-9]+$/)),
    }),
  ),
  services: settingsStruct({
    gateway: unitName.pipe(settingsDefault("stargate.service")),
    /** Restarts the shared OpenCode server; runs only at an idle boundary. */
    openCodeRestart: command.pipe(
      settingsDefault(["systemctl", "--user", "restart", "opencode2.service"]),
    ),
  }).pipe(
    settingsDefault({
      gateway: "stargate.service",
      openCodeRestart: ["systemctl", "--user", "restart", "opencode2.service"],
    }),
  ),
  idle: settingsStruct({
    pollSeconds: Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(5))
      .check(Schema.isLessThanOrEqualTo(600))
      .pipe(settingsDefault(30)),
    /** A cron schedule due within this horizon blocks maintenance. */
    cronHorizonMinutes: Schema.Finite.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(720))
      .pipe(settingsDefault(defaultCronHorizonMinutes)),
  }).pipe(
    settingsDefault({
      pollSeconds: 30,
      cronHorizonMinutes: defaultCronHorizonMinutes,
    }),
  ),
  /** CLIProxyAPI endpoint used for health checks, catalog and model probes. */
  proxy: Schema.optional(
    settingsStruct({
      url: url(true).pipe(settingsDefault("http://127.0.0.1:8317")),
      clientKeyFile: absolutePath,
    }),
  ),
  stargate: Schema.optional(
    settingsStruct({
      /** Install root: `releases/<version>` and the `current` symlink. */
      root: absolutePath,
      repository: repository.pipe(settingsDefault("aiconsultancy/stargate")),
      apiURL: url(false).pipe(settingsDefault("https://api.github.com")),
      /** Token environment name; otherwise `gh auth token` when available. */
      tokenEnv: Schema.optional(envName),
      /** Required release author; releases are published by CI only. */
      author: Schema.String.check(Schema.isMinCodePoints(1))
        .check(Schema.isMaxCodePoints(100))
        .pipe(settingsDefault("github-actions[bot]")),
      branch: Schema.String.check(
        settingsPattern(/^[A-Za-z0-9._/-]{1,200}$/),
      ).pipe(settingsDefault("main")),
      /** Local clone (bare is fine): the unpacked tree must equal `git archive`. */
      checkout: Schema.optional(absolutePath),
      /**
       * Release attestations are unavailable, so the tree comparison is
       * required: without `checkout` the update fails closed. Set false
       * only with an explicit, documented acceptance of weaker checks.
       */
      requireTreeCheck: Schema.Boolean.pipe(settingsDefault(true)),
      coolOffHours: coolOffHours.pipe(settingsDefault(0)),
      keep: Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(2))
        .check(Schema.isLessThanOrEqualTo(10))
        .pipe(settingsDefault(3)),
      installCommand: command.pipe(
        settingsDefault(["bun", "install", "--frozen-lockfile"]),
      ),
      testCommand: command.pipe(settingsDefault(["bun", "test"])),
    }),
  ),
  cliproxyapi: Schema.optional(
    settingsStruct({
      unit: unitName.pipe(settingsDefault("cliproxyapi.service")),
      /** Stable symlink that the unit's ExecStart runs. */
      link: absolutePath,
      /** Installed binary path; must contain `{version}`. */
      binary: absolutePath.check(
        settingsRefine((path) => path.includes("{version}"), {
          message: "Invalid input",
        }),
      ),
      /** Release asset to download; its GitHub SHA-256 digest is pinned. */
      asset: Schema.String.check(settingsPattern(/^[A-Za-z0-9._{}-]{1,200}$/))
        .check(
          settingsRefine((name) => name.includes("{version}"), {
            message: "Invalid input",
          }),
        )
        .pipe(settingsDefault("CLIProxyAPI_{version}_linux_amd64.tar.gz")),
      /** Executable inside the asset archive. */
      executable: Schema.String.check(
        settingsPattern(/^[A-Za-z0-9._-]{1,100}$/),
      ).pipe(settingsDefault("cli-proxy-api")),
      repository: repository.pipe(settingsDefault("router-for-me/CLIProxyAPI")),
      apiURL: url(false).pipe(settingsDefault("https://api.github.com")),
      coolOffHours: coolOffHours.pipe(settingsDefault(24)),
    }),
  ),
  agentClis: Schema.optional(
    settingsStruct({
      npm: command.pipe(settingsDefault(["npm"])),
      /** npm global prefix, for example /home/me/.local. */
      prefix: absolutePath,
      registry: url(false).pipe(settingsDefault("https://registry.npmjs.org")),
      packages: Schema.mutable(
        Schema.Array(
          settingsStruct({
            name: npmName,
            command: Schema.String.check(
              settingsPattern(/^[A-Za-z0-9._-]{1,100}$/),
            ),
          }),
        ),
      )
        .check(Schema.isMinLength(1))
        .check(Schema.isMaxLength(20))
        .pipe(settingsDefault(defaultAgentPackages)),
      allowScripts: Schema.mutable(Schema.Array(npmName))
        .check(Schema.isMaxLength(50))
        .pipe(
          settingsDefault([
            "@opencode/cli",
            "@anthropic-ai/claude-code",
            "protobufjs",
            "koffi",
          ]),
        ),
      /** Shared updater lock (flock); never run a competing writer. */
      lockFile: Schema.optional(absolutePath),
      coolOffHours: coolOffHours.pipe(settingsDefault(24)),
    }),
  ),
  models: Schema.optional(
    settingsStruct({
      families: Schema.mutable(Schema.Array(familySchema))
        .check(Schema.isMinLength(1))
        .check(Schema.isMaxLength(20))
        .pipe(
          settingsDefault([
            "claude-opus",
            "claude-sonnet",
            "claude-haiku",
            "gpt-sol",
            "gpt-astra",
            "gpt-terra",
            "gpt-luna",
          ]),
        ),
      /** OpenCode provider IDs that route through the proxy. */
      providers: Schema.mutable(Schema.Array(modelProvider))
        .check(Schema.isMinLength(1))
        .check(Schema.isMaxLength(20))
        .pipe(settingsDefault(["openai-proxy", "claude-proxy"])),
      /** Global child-agent profiles, e.g. ~/.config/opencode/agent-profiles. */
      agentProfiles: Schema.optional(absolutePath),
      /** Opt-in additive declarations in the global OpenCode configuration. */
      updateGlobalCatalog: Schema.Boolean.pipe(settingsDefault(false)),
      /** Defaults to $XDG_CONFIG_HOME/opencode/opencode.json (or ~/.config). */
      globalConfigFile: Schema.optional(absolutePath),
      /** Team JSON files whose captain/crew models follow upgrades. */
      teamFiles: Schema.mutable(Schema.Array(absolutePath))
        .check(Schema.isMaxLength(20))
        .pipe(settingsDefault([])),
      /** Maximum candidates probed per model family and run. */
      probes: Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(5))
        .pipe(settingsDefault(2)),
    }),
  ),
  /**
   * Monitoring agent: explains reports and escalates through `report`.
   * It may only read maintenance state and run `plan` or `recover`.
   */
  droid: Schema.optional(
    settingsStruct({
      enabled: Schema.Boolean.pipe(settingsDefault(false)),
      /** Pi Durable model selection, as for Pi backends. */
      backend: settingsStruct({
        model: piModelSchema.pipe(settingsDefault(piProxyModel)),
        provider: Schema.optional(piProviderSchema),
      }).pipe(settingsDefault({ model: piProxyModel })),
      /** Daily health check, local time in `window.timeZone`. */
      healthCheck: clock.pipe(settingsDefault("12:00")),
      /** The post-run check starts this long after the window end. */
      afterRunMinutes: Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(5))
        .check(Schema.isLessThanOrEqualTo(180))
        .pipe(settingsDefault(15)),
      maxRecoversPerDay: Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(5))
        .pipe(settingsDefault(2)),
      /** Reports the droid may read, newest first. */
      reports: Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(14))
        .pipe(settingsDefault(7)),
      /** Failed or deferred runs in a row that count as a problem. */
      failedNights: Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(14))
        .pipe(settingsDefault(2)),
      /** Name of the maintenance timer (install-timer --name). */
      timer: Schema.String.check(
        settingsPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
      ).pipe(settingsDefault("stargate-maintenance")),
      /** Upper bound of one model answer, tool calls included. */
      timeoutMinutes: Schema.Finite.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(30))
        .pipe(settingsDefault(5)),
    }),
  ),
}).check(
  settingsCheck((value, context) => {
    const minutes = (clock: string) => {
      const [hour = 0, minute = 0] = clock.split(":").map(Number);
      return hour * 60 + minute;
    };
    const { start, end, jitterMinutes, reserveMinutes } = value.window;
    const length = (minutes(end) - minutes(start) + 1440) % 1440;
    if (length === 0)
      context.addIssue({
        code: "custom",
        path: ["window", "end"],
        message: "Window start and end must differ",
      });
    else if (jitterMinutes + reserveMinutes >= length)
      context.addIssue({
        code: "custom",
        path: ["window", "jitterMinutes"],
        message: "Jitter plus reserve must be shorter than the window",
      });
    const need = (
      component: keyof typeof value.components,
      sections: (keyof typeof value)[],
    ) => {
      if (!value.components[component]) return;
      for (const section of sections)
        if (value[section] === undefined)
          context.addIssue({
            code: "custom",
            path: [section],
            message: `components.${component} requires the ${section} section`,
          });
    };
    const droid = value.droid;
    if (droid?.enabled && !value.report)
      context.addIssue({
        code: "custom",
        path: ["droid", "enabled"],
        message: "droid requires the report section (its Slack destination)",
      });
    // The proxy provider serves only named models (see pi-durable.ts).
    if (
      droid &&
      (droid.backend.provider
        ? !piProxyModels.includes(droid.backend.model)
        : droid.backend.model === piProxyModel)
    )
      context.addIssue({
        code: "custom",
        path: ["droid", "backend"],
        message: `A provider requires model ${piProxyModels.join(" or ")}, and ${piProxyModel} requires a provider`,
      });
    need("stargate", ["stargate"]);
    need("cliproxyapi", ["cliproxyapi", "proxy"]);
    need("agentClis", ["agentClis"]);
    need("models", ["models", "proxy"]);
  }),
);

export type MaintenanceConfig = typeof maintenanceSchema.Type;
