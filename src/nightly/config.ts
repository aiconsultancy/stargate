import { isAbsolute } from "node:path";
import { z } from "zod";

/** Strict `maintenance` section of pogo.json. Every component is opt-in. */
const absolutePath = z
  .string()
  .max(4096)
  .refine(isAbsolute, "Use an absolute path")
  .refine((path) => !/[\r\n\0]/.test(path), "Paths cannot contain newlines");
const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((zone) => {
    // Intl accepts fixed offsets; they are not IANA zones and ignore DST.
    if (/^[+-]/.test(zone)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Use an IANA time zone name");
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const unitName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}\.service$/);
const argument = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => ![...value].some((c) => c.charCodeAt(0) < 32),
    "No control characters",
  );
const command = z.array(argument).min(1).max(64);
const url = (loopbackOnly: boolean) =>
  z.url().refine((value) => {
    const parsed = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
      parsed.hostname,
    );
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
  }, "Use HTTPS, or HTTP on loopback, without credentials, query or fragment");
const coolOffHours = z.number().int().min(0).max(720);
export const familySchema = z.string().regex(/^(claude|gpt)-[a-z]+$/);
const modelProvider = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const npmName = z
  .string()
  .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
  .max(214);

export const defaultAgentPackages = [
  { name: "@opencode/cli", command: "opencode2" },
  { name: "@openai/codex", command: "codex" },
  { name: "@anthropic-ai/claude-code", command: "claude" },
  { name: "@earendil-works/pi-coding-agent", command: "pi" },
];

export const maintenanceSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** Stable identity for jitter and reports. Default: hash of host and config path. */
    installID: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,100}$/)
      .optional(),
    window: z
      .strictObject({
        start: clock.default("00:00"),
        end: clock.default("01:00"),
        timeZone: timeZoneSchema.default("Europe/London"),
        /** Maximum per-install start delay; the actual delay is stable. */
        jitterMinutes: z.number().int().min(0).max(120).default(15),
        /** No new change starts after `end - reserveMinutes`. */
        reserveMinutes: z.number().int().min(1).max(120).default(10),
      })
      .default({
        start: "00:00",
        end: "01:00",
        timeZone: "Europe/London",
        jitterMinutes: 15,
        reserveMinutes: 10,
      }),
    components: z
      .strictObject({
        pogo: z.boolean().default(false),
        cliproxyapi: z.boolean().default(false),
        agentClis: z.boolean().default(false),
        models: z.boolean().default(false),
      })
      .default({
        pogo: false,
        cliproxyapi: false,
        agentClis: false,
        models: false,
      }),
    /** Summary destination; the gateway delivers it through this bot. */
    report: z
      .strictObject({
        bot: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        channel: z.string().regex(/^[CG][A-Z0-9]+$/),
      })
      .optional(),
    services: z
      .strictObject({
        gateway: unitName.default("pogo.service"),
        /** Restarts the shared OpenCode server; runs only at an idle boundary. */
        openCodeRestart: command.default([
          "systemctl",
          "--user",
          "restart",
          "opencode2.service",
        ]),
      })
      .default({
        gateway: "pogo.service",
        openCodeRestart: [
          "systemctl",
          "--user",
          "restart",
          "opencode2.service",
        ],
      }),
    idle: z
      .strictObject({
        pollSeconds: z.number().int().min(5).max(600).default(30),
        /** A cron schedule due within this horizon blocks maintenance. */
        cronHorizonMinutes: z.number().int().min(0).max(720).default(60),
      })
      .default({ pollSeconds: 30, cronHorizonMinutes: 60 }),
    /** CLIProxyAPI endpoint used for health checks, catalog and model probes. */
    proxy: z
      .strictObject({
        url: url(true).default("http://127.0.0.1:8317"),
        clientKeyFile: absolutePath,
      })
      .optional(),
    pogo: z
      .strictObject({
        /** Install root: `releases/<version>` and the `current` symlink. */
        root: absolutePath,
        repository: repository.default("aiconsultancy/pogo"),
        apiURL: url(false).default("https://api.github.com"),
        /** Token environment name; otherwise `gh auth token` when available. */
        tokenEnv: envName.optional(),
        /** Required release author; releases are published by CI only. */
        author: z.string().min(1).max(100).default("github-actions[bot]"),
        branch: z
          .string()
          .regex(/^[A-Za-z0-9._/-]{1,200}$/)
          .default("main"),
        /** Local clone (bare is fine): the unpacked tree must equal `git archive`. */
        checkout: absolutePath.optional(),
        /**
         * Release attestations are unavailable, so the tree comparison is
         * required: without `checkout` the update fails closed. Set false
         * only with an explicit, documented acceptance of weaker checks.
         */
        requireTreeCheck: z.boolean().default(true),
        coolOffHours: coolOffHours.default(0),
        keep: z.number().int().min(2).max(10).default(3),
        installCommand: command.default([
          "bun",
          "install",
          "--frozen-lockfile",
        ]),
        testCommand: command.default(["bun", "test"]),
      })
      .optional(),
    cliproxyapi: z
      .strictObject({
        unit: unitName.default("cliproxyapi.service"),
        /** Stable symlink that the unit's ExecStart runs. */
        link: absolutePath,
        /** Installed binary path; must contain `{version}`. */
        binary: absolutePath.refine((path) => path.includes("{version}")),
        /** Release asset to download; its GitHub SHA-256 digest is pinned. */
        asset: z
          .string()
          .regex(/^[A-Za-z0-9._{}-]{1,200}$/)
          .refine((name) => name.includes("{version}"))
          .default("CLIProxyAPI_{version}_linux_amd64.tar.gz"),
        /** Executable inside the asset archive. */
        executable: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,100}$/)
          .default("cli-proxy-api"),
        repository: repository.default("router-for-me/CLIProxyAPI"),
        apiURL: url(false).default("https://api.github.com"),
        coolOffHours: coolOffHours.default(24),
      })
      .optional(),
    agentClis: z
      .strictObject({
        npm: command.default(["npm"]),
        /** npm global prefix, for example /home/me/.local. */
        prefix: absolutePath,
        registry: url(false).default("https://registry.npmjs.org"),
        packages: z
          .array(
            z.strictObject({
              name: npmName,
              command: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
            }),
          )
          .min(1)
          .max(20)
          .default(defaultAgentPackages),
        allowScripts: z
          .array(npmName)
          .max(50)
          .default([
            "@opencode/cli",
            "@anthropic-ai/claude-code",
            "protobufjs",
            "koffi",
          ]),
        /** Shared updater lock (flock); never run a competing writer. */
        lockFile: absolutePath.optional(),
        coolOffHours: coolOffHours.default(24),
      })
      .optional(),
    models: z
      .strictObject({
        families: z
          .array(familySchema)
          .min(1)
          .max(20)
          .default([
            "claude-opus",
            "claude-sonnet",
            "claude-haiku",
            "gpt-sol",
            "gpt-terra",
            "gpt-luna",
          ]),
        /** OpenCode provider IDs that route through the proxy. */
        providers: z
          .array(modelProvider)
          .min(1)
          .max(20)
          .default(["openai-proxy", "claude-proxy"]),
        /** Global child-agent profiles, e.g. ~/.config/opencode/agent-profiles. */
        agentProfiles: absolutePath.optional(),
        /** Team JSON files whose captain/crew models follow upgrades. */
        teamFiles: z.array(absolutePath).max(20).default([]),
        /** Maximum candidates probed per model family and run. */
        probes: z.number().int().min(1).max(5).default(2),
      })
      .optional(),
  })
  .superRefine((value, context) => {
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
    need("pogo", ["pogo"]);
    need("cliproxyapi", ["cliproxyapi", "proxy"]);
    need("agentClis", ["agentClis"]);
    need("models", ["models", "proxy"]);
  });

export type MaintenanceConfig = z.infer<typeof maintenanceSchema>;
