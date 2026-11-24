import { join } from "node:path";
import { Option, Schema } from "effect";
import type { AgentBackend } from "../../backends/backend";
import type { BotConfig, Config } from "../../config";
import { crewStatusSchema } from "../../shared/crew-status";
import type { CronReportRow } from "../../automation/cron/store";
import { type HealthConfig, healthConfigSchema } from "./config";
import {
  createHostHealthReader,
  hostHealthSchema,
  readHealthFile,
} from "./health-host";
import {
  maintenanceDrainSchema,
  readMaintenanceDrain,
} from "../../automation/maintenance/maintenance-drain";
import {
  readReports,
  readUnit,
} from "../../automation/maintenance/nightly/droid/droid-facts";
import {
  type CommandRunner,
  processRunner,
} from "../../automation/maintenance/nightly/exec";
import {
  readReady,
  readySchema,
} from "../../automation/maintenance/nightly/update/ready";
import { reportOutcomes } from "../../automation/maintenance/nightly/reports/report";
import { quotaSnapshotSchema } from "../../backends/quota/quota";
import { botStatusReport } from "../../app/status-report";
import { settingsPattern } from "../../config/settings-schema";
import { exactStruct } from "../../shared/session-history";

export const healthSections = [
  "host",
  "agents",
  "stargate",
  "opencode",
  "proxy",
  "services",
  "starfleet",
] as const;

type Section = (typeof healthSections)[number];

const serviceState = Schema.Literals([
  "active",
  "inactive",
  "failed",
  "unknown",
]);

// The installed Zod 4.6.7 ISO date-time with an optional offset.
const offsetDateTime = Schema.String.check(
  settingsPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/,
  ),
);

export const starfleetSnapshotSchema = exactStruct({
  schema: Schema.Literal("stargate.health.starfleet.v1"),
  observedAt: offsetDateTime,
  services: exactStruct({
    avondale: serviceState,
    stargate: serviceState,
    opencode: serviceState,
    proxy: serviceState,
  }),
});

export async function readStarfleetSnapshot(path: string) {
  const text = await readHealthFile(path, 65_536, true);

  try {
    return Schema.decodeUnknownSync(starfleetSnapshotSchema)(
      JSON.parse(text ?? ""),
    );
  } catch {
    return null;
  }
}

type Sources = {
  host?: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  ready?: () => Promise<unknown>;
  reports?: () => Promise<unknown>;
  alert?: () => Promise<unknown>;
  starfleet?: () => Promise<unknown>;
  uptime?: () => number;
  drain?: () => Promise<unknown>;
};

export type HealthReaderInput = {
  bot: () => BotConfig;
  dataDirectory: string;
  backend: Pick<AgentBackend, "crewStatus" | "quota">;
  schedules?: () => CronReportRow[];
  maintenance?: Config["maintenance"];
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  sources?: Sources;
  runner?: CommandRunner;
};

const checkSchema = Schema.Struct({
  state: Schema.Literals(["available", "failed", "unknown"]),
});

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const statusSchema = Schema.Struct({
  checks: Schema.Struct({
    backendRead: checkSchema,
    pinnedSession: checkSchema,
  }),
  history: Schema.Struct({
    state: Schema.Literals(["unknown", "incomplete"]),
    incidents: Schema.Array(Schema.Struct({ count })).check(
      Schema.isMaxLength(100),
    ),
  }),
  openCode: Schema.optional(
    Schema.Struct({
      version: Schema.NullOr(Schema.String),
      activeSessions: Schema.NullOr(count),
      pendingForms: Schema.NullOr(count),
      pendingPermissions: Schema.NullOr(count),
      mcpConnected: Schema.NullOr(count),
      mcpFailed: Schema.NullOr(count),
    }),
  ),
});

// Batch 16 owns these two schemas; until it lands they stay Zod, and this
// File only asks their own decoders.
const reportOutcome = Schema.Literals(reportOutcomes);

const reportsSchema = Schema.Struct({
  reports: Schema.Array(
    Schema.Struct({ startedAt: offsetDateTime, outcome: reportOutcome }),
  ).check(Schema.isMaxLength(1)),
  unreadable: count,
});

const cronState = Schema.Literals([
  "pending",
  "announcing",
  "announced",
  "queued",
  "blocked",
  "done",
  "failed",
  "canceled",
]);

function parsedReady(value: unknown) {
  return Option.getOrNull(Schema.decodeUnknownOption(readySchema)(value));
}

const version = (value: unknown) =>
  typeof value === "string" &&
  /^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[a-zA-Z0-9.-]{1,32})?$/.test(value)
    ? value
    : "unknown";

const identifier = (value: string) =>
  /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : "unknown";

const number = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) || value < 0
    ? "unknown"
    : String(Math.round(value * 100) / 100);

const date = (value: number | null | undefined) =>
  value !== null &&
  value !== undefined &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000
    ? new Date(value).toISOString()
    : "unknown";

const mark = (state: string) =>
  ["active", "available"].includes(state)
    ? "✓"
    : ["failed", "inactive", "not-found"].includes(state)
      ? "✗"
      : "⚠";

const mib = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "unknown"
    : `${number(value / 1_048_576)}MiB`;

/** A deadline bounds reply latency even when a third-party adapter ignores abort. */
async function bounded<T>(work: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
        }, 5500);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parsed<T, E>(schema: Schema.Codec<T, E>, value: unknown): T | null {
  return Option.getOrNull(Schema.decodeUnknownOption(schema)(value));
}

/** The twelve bounded reads of one health request, started together. */
function readHealthSources(
  input: HealthReaderInput,
  request: {
    bot: BotConfig;
    config: HealthConfig;
    now: number;
    sources: Sources;
    want: (section: Section) => boolean;
    readHost: () => Promise<unknown>;
  },
) {
  const { bot, config, now, sources, want, readHost } = request;
  const runner = input.runner ?? processRunner;

  const unit = async (name: string | undefined) =>
    name
      ? ((await bounded(() =>
          readUnit(
            {
              run: (command, options) =>
                runner.run(command, { ...options, timeoutMs: 5000 }),
            },
            name,
          ),
        )) ?? "unknown")
      : "unknown";

  const m = input.maintenance;
  const restart = m?.services.openCodeRestart;

  const opencodeUnit =
    restart?.length === 4 &&
    restart[0] === "systemctl" &&
    restart[1] === "--user" &&
    restart[2] === "restart" &&
    restart[3]?.endsWith(".service")
      ? restart[3]
      : undefined;

  return Promise.all([
    want("host") ? bounded(sources.host ?? readHost) : null,
    want("agents") || want("opencode")
      ? bounded(
          sources.status ??
            (() =>
              botStatusReport(
                bot,
                input.env ?? process.env,
                input.logPath,
                now,
                true,
              )),
        )
      : null,
    want("agents") && input.backend.crewStatus
      ? bounded(
          () =>
            input.backend.crewStatus?.({}, AbortSignal.timeout(5000)) ??
            Promise.resolve(null),
        )
      : null,
    want("proxy") && input.backend.quota
      ? bounded(
          () =>
            input.backend.quota?.(AbortSignal.timeout(5000)) ??
            Promise.resolve(null),
        )
      : null,
    want("stargate")
      ? bounded(sources.ready ?? (() => readReady(input.dataDirectory)))
      : null,
    want("stargate")
      ? bounded(
          sources.reports ??
            (() => readReports(input.dataDirectory, 1, () => "")),
        )
      : null,
    want("stargate")
      ? bounded(
          sources.alert ??
            (async () => {
              const text = await readHealthFile(
                join(input.dataDirectory, "maintenance", "ALERT.json"),
                65_536,
              );

              // No exported alert schema: presence is a warning, absence/read failure unknown.
              return text === null ? null : { present: true };
            }),
        )
      : null,
    want("starfleet")
      ? bounded(
          sources.starfleet ??
            (() =>
              config.starfleetSnapshotFile
                ? readStarfleetSnapshot(config.starfleetSnapshotFile)
                : Promise.resolve(null)),
        )
      : null,
    want("stargate") ? unit(m?.services.gateway) : null,
    want("opencode") ? unit(opencodeUnit) : null,
    want("proxy") ? unit(m?.cliproxyapi?.unit) : null,
    want("stargate")
      ? bounded(
          sources.drain ?? (() => Promise.resolve(readMaintenanceDrain())),
        )
      : null,
  ]);
}

type SectionText = { rows: string[]; summary: string };

function hostSection(host: unknown): SectionText {
  const rows: string[] = [];
  let summary: string;
  const h = parsed(hostHealthSchema, host);
  rows.push(
    h
      ? `${h.load[0] > h.cores ? "⚠" : "✓"} load 1/5/15 ${h.load.map(number).join("/")}; cores ${number(h.cores)}; uptime ${number(h.uptimeSeconds)}s`
      : "⚠ load/cores/uptime unknown",
    `⚠ memory used/available/total ${mib(h?.availableMemory !== null && h?.availableMemory !== undefined ? Math.max(0, h.totalMemory - h.availableMemory) : null)}/${mib(h?.availableMemory)}/${mib(h?.totalMemory)}; swap free/total ${mib(h?.swapFree)}/${mib(h?.swapTotal)}`,
  );

  for (const label of ["root", "stargate", "opencode", "crew"] as const) {
    const d = h?.disks.find((disk) => disk.label === label);
    rows.push(
      `⚠ disk ${label} free/total ${mib(d?.available)}/${mib(d?.total)}; inodes free/total ${number(d?.freeInodes)}/${number(d?.inodes)}`,
    );
  }

  rows.push(
    h?.growth
      ? `⚠ growth ${h.growth.label} ${mib(h.growth.bytes)} over ${number(h.growth.intervalSeconds)}s (free-space change)`
      : "⚠ growth unknown (no prior observation)",
    `⚠ top CPU/memory ${h?.processes?.length ? "sampled, not a complete inventory" : "unknown"}; first CPU rate needs a baseline`,
  );

  for (const process of h?.processes ?? []) {
    rows.push(
      `⚠ ${process.label} PID ${number(process.pid)} CPU ${number(process.cpuPercent)}%; memory ${mib(process.memoryBytes)}`,
    );
  }

  rows.push(
    `⚠ process identities use fixed labels: stargate/opencode/proxy/sourcebot/other; unobserved processes unknown`,
    `⚠ reboot-required marker ${h?.rebootPending === null || h?.rebootPending === undefined ? "unknown" : h.rebootPending ? "present" : "absent"}; time-sync marker ${h?.timeSynchronized === null || h?.timeSynchronized === undefined ? "unknown" : h.timeSynchronized ? "present" : "absent"}`,
  );
  const root = h?.disks.find((disk) => disk.label === "root");
  summary = `load ${h ? h.load.map(number).join("/") : "unknown"}; cores ${number(h?.cores)}; memory free ${mib(h?.availableMemory)}; root free ${mib(root?.available)}; extended coverage unknown`;

  return { rows, summary };
}

type HealthStatus = typeof statusSchema.Type;

function agentsSection(
  s: HealthStatus | null,
  crew: unknown,
  stalledAfterSeconds: number,
  now: number,
): SectionText {
  const rows: string[] = [];
  let summary: string;
  const pin = s?.checks.pinnedSession.state ?? "unknown";
  rows.push(
    `${mark(pin)} captain pinned readiness ${pin}; current task/queued tasks/running duration/last activity unknown`,
    `⚠ native activity unknown; stalled unknown (no last-activity source; limit ${stalledAfterSeconds}s)`,
  );
  const c = parsed(crewStatusSchema, crew);
  rows.push(
    c
      ? `⚠ crew ownership: total ${c.total}; ${c.truncated ? "truncated; " : ""}native availability unknown`
      : "⚠ crew ownership unknown",
  );
  summary = `captain readiness ${pin}; visible ownership ${c ? c.members.filter((member) => member.current !== null).length : "unknown"}/${c?.total ?? "unknown"}; visible queued ${c ? c.members.reduce((sum, member) => sum + member.queuedCount, 0) : "unknown"}; native activity/stalled unknown`;

  for (const member of c?.members ?? [])
    rows.push(
      `⚠ ${identifier(member.id)} ${member.backend} ${member.provisioned}; observed ${member.observed}; ownership ${member.current?.status ?? "none"}${member.current ? ` ${identifier(member.current.id)}` : ""}; queued ${member.queuedCount}; start ${date(member.current?.startedAt)}; running duration ${member.current?.startedAt !== null && member.current?.startedAt !== undefined && member.current.startedAt <= now ? `${number((now - member.current.startedAt) / 1000)}s` : "unknown"}; update ${date(member.current?.updatedAt)}; last activity unknown`,
    );

  return { rows, summary };
}

function opencodeSection(
  s: HealthStatus | null,
  opencodeState: string | null,
): SectionText {
  const rows: string[] = [];
  let summary: string;

  for (const [label, check] of [
    ["backend read", s?.checks.backendRead],
    ["pinned session", s?.checks.pinnedSession],
  ] as const) {
    const state = check?.state ?? "unknown";
    rows.push(`${mark(state)} ${label} ${state}`);
  }

  rows.push(
    `${mark(opencodeState ?? "unknown")} unit ${opencodeState ?? "unknown"}; unit started unknown; version ${version(s?.openCode?.version)}`,
    `⚠ active sessions ${number(s?.openCode?.activeSessions)}; pending forms ${number(s?.openCode?.pendingForms)}; permissions ${number(s?.openCode?.pendingPermissions)}`,
  );
  summary = `backend ${s?.checks.backendRead.state ?? "unknown"}; version ${version(s?.openCode?.version)}; MCP connected ${number(s?.openCode?.mcpConnected)}, failed ${number(s?.openCode?.mcpFailed)}; last-hour metrics unknown`;
  rows.push(
    `${s?.openCode?.mcpFailed ? "✗" : "⚠"} MCP connected ${number(s?.openCode?.mcpConnected)}; failed ${number(s?.openCode?.mcpFailed)}`,
    `⚠ last-hour requests/success/errors/latency unknown; 24h incidents ${s?.history.state === "incomplete" ? s.history.incidents.reduce((sum, incident) => sum + incident.count, 0) : "unknown"}; 24h coverage ${s?.history.state ?? "unknown"}`,
  );

  return { rows, summary };
}

type StargateRead = {
  drainState: unknown;
  ready: unknown;
  reports: unknown;
  alert: unknown;
  gatewayState: string | null;
  now: number;
  uptime: () => number;
  schedules: (() => CronReportRow[]) | undefined;
};

function stargateSection(read: StargateRead): SectionText {
  const rows: string[] = [];
  let summary: string;

  const decoded = Schema.decodeUnknownOption(maintenanceDrainSchema)(
    read.drainState,
  );

  if (Option.isSome(decoded)) {
    const drain = decoded.value;
    rows.push(
      `⚠ restart drain ${drain.phase}; job ${drain.job}; services ${drain.services.join(", ")}; deadline ${date(drain.deadlineAt)}; stragglers ${drain.stragglers?.length ?? 0}`,
    );

    for (const work of drain.stragglers?.slice(0, 8) ?? [])
      rows.push(
        `⚠ drain ${identifier(work.taskID ?? "unknown-task")} ${identifier(work.sessionID ?? "unknown-session")}: ${identifier(work.reason)}`,
      );
  } else rows.push("⚠ restart drain inactive or unknown");
  const r = parsedReady(read.ready);
  const valid = r && r.readyAt <= read.now;
  const alerted = Boolean(read.alert);
  rows.push(
    `${mark(read.gatewayState ?? "unknown")} unit ${read.gatewayState ?? "unknown"}; version ${valid ? version(r.version) : "unknown"}; ready ${valid ? date(r.readyAt) : "unknown"}`,
    "⚠ last delivered unknown; last-hour delivery errors unknown; last-hour refused messages unknown; latest release version unknown",
    `⚠ gateway uptime ${number(read.uptime())}s; ${valid && r.transports ? `transports ${r.transports.filter((transport) => transport.state === "connected").length}/${r.transports.length} connected` : "Slack/IRC connection unknown"}; last alert ${alerted ? "present; state unknown" : "unknown"}`,
  );

  if (valid && r.transports)
    for (const transport of r.transports.slice(0, 30))
      rows.push(
        `${transport.state === "connected" ? "✓" : "✗"} ${transport.kind} ${transport.id.replace(/[^a-zA-Z0-9:_-]/g, "?").slice(0, 80)}: ${transport.state}; observed ${date(r.transportObservedAt ?? r.readyAt)}`,
      );
  const report = parsed(reportsSchema, read.reports);
  const latest = report?.reports[0];
  summary = `installed ${valid ? version(r.version) : "unknown"}; unit ${read.gatewayState ?? "unknown"}; last maintenance ${latest?.outcome ?? "unknown"}; delivery/latest release/coverage unknown`;
  rows.push(
    `${mark(latest?.outcome ?? "unknown")} last maintenance ${latest ? `${latest.outcome} ${latest.startedAt}` : "unknown"}; report coverage ${report?.unreadable ? "unknown" : "unknown beyond latest report"}`,
    "⚠ cron coverage unknown beyond listed rows",
  );
  let schedules: CronReportRow[] = [];
  let cronKnown = false;

  try {
    schedules = read.schedules?.() ?? [];
    cronKnown = read.schedules !== undefined;
  } catch {
    /* Store read failure is unknown, not no schedules. */
  }

  for (const schedule of schedules.slice(0, 20)) {
    const state = parsed(cronState, schedule.lastStatus) ?? "unknown";
    rows.push(
      `${mark(state)} cron ${identifier(schedule.id)} ${state}; last ${date(schedule.lastRunAt)}`,
    );
  }

  if (schedules.some((schedule) => schedule.lastStatus === "failed"))
    rows.push("✗ cron failed; coverage unknown beyond listed rows");
  summary += `; cron failed ${cronKnown ? schedules.filter((schedule) => schedule.lastStatus === "failed").length : "unknown"}`;

  return { rows, summary };
}

function proxySection(
  quota: unknown,
  proxyState: string | null,
  now: number,
): SectionText {
  const rows: string[] = [];
  let summary: string;
  rows.push(
    `${mark(proxyState ?? "unknown")} unit ${proxyState ?? "unknown"}; unit started unknown; version unknown`,
    "⚠ request/error/latency/cache warmth unknown; quota is not token usage or routing availability",
  );
  const q = parsed(quotaSnapshotSchema, quota);
  const firstAccount = q?.accounts[0];
  const firstWindow = firstAccount?.windows[0];
  summary = `unit ${proxyState ?? "unknown"}; first quota ${firstAccount?.account ?? "unknown"} ${firstWindow?.window ?? "unknown"}, used ${number(firstWindow?.usedPercent)}%, remaining ${number(firstWindow?.remainingPercent)}%, reset ${date(firstWindow?.resetAt)}; availability/metrics unknown`;
  rows.push(
    `⚠ quota observed ${q ? date(q.observedAt) : "unknown"}; availability unknown`,
  );

  for (const account of q?.accounts ?? []) {
    rows.push(
      `⚠ ${account.provider} ${account.account}; observed ${date(account.observedAt)}; availability unknown`,
    );

    for (const window of account.windows) {
      const expired = window.resetAt !== null && window.resetAt <= now;
      rows.push(
        `⚠ ${window.scope} ${window.window}: used ${number(window.usedPercent)}%; remaining ${number(window.remainingPercent)}%; reset ${date(window.resetAt)}; availability unknown${expired ? "; reset passed" : ""}${window.active === false ? "; inactive" : ""}`,
      );
    }
  }

  return { rows, summary };
}

function starfleetSection(
  snapshot: unknown,
  now: number,
  maxAgeSeconds: number,
): SectionText {
  const rows: string[] = [];
  let summary: string;
  const remote = parsed(starfleetSnapshotSchema, snapshot);
  const age = remote ? now - Date.parse(remote.observedAt) : null;
  const current = age !== null && age >= 0 && age <= maxAgeSeconds * 1000;
  const states = remote ? Object.values(remote.services) : [];
  summary = `remote cached age ${age === null || age < 0 ? "unknown" : `${number(age / 1000)}s`}; failed/inactive services ${current ? states.filter((state) => state === "failed" || state === "inactive").length : "unknown"}; current ${current ? `${states.filter((state) => state === "unknown").length} unknown services; live reachability unknown` : "unknown"}`;
  rows.push(
    `⚠ remote cached observation ${remote?.observedAt ?? "unknown"}; age ${age === null || age < 0 ? "unknown" : `${number(age / 1000)}s`}; ${current ? "current snapshot, not a live probe" : "current state unknown (missing, invalid, future or stale snapshot)"}`,
  );

  for (const service of [
    "avondale",
    "stargate",
    "opencode",
    "proxy",
  ] as const) {
    const state = current
      ? (remote?.services[service] ?? "unknown")
      : "unknown";

    rows.push(`${mark(state)} ${service} ${state}`);
  }

  return { rows, summary };
}

const aggregate = (rows: string[]) =>
  rows.some((row) => row.startsWith("✗"))
    ? "✗"
    : rows.some((row) => row.startsWith("⚠"))
      ? "⚠"
      : "✓";

function renderHealth(
  requested: string | undefined,
  sections: Partial<Record<Section, SectionText>>,
): string {
  const header = "Health · read-only\n";

  if (requested === undefined)
    return (
      header +
      healthSections
        .map((section) => {
          const text = sections[section];
          const line = `${aggregate(text?.rows ?? [])} ${section}: ${text?.summary ?? "unknown"}`;

          return line.length <= 400
            ? line
            : `${line.slice(0, 370)}; coverage unknown`;
        })
        .join("\n")
    );
  const section = requested as Section;
  const rows = sections[section]?.rows ?? [];
  const detail = `${aggregate(rows)} ${section}\n${rows.join("\n")}`;
  const suffix = "\n⚠ truncated; omitted states unknown";

  return (
    header +
    (detail.length <= 2999 - header.length
      ? detail
      : detail.slice(0, 2999 - header.length - suffix.length) + suffix)
  );
}

/** Only read-only, registration-scoped metadata; no turn, discovery or remote producer. */
export function createHealthReader(
  input: HealthReaderInput,
): (section?: string) => Promise<string> {
  const readHost = createHostHealthReader(
    input.maintenance?.stargate?.root ?? input.dataDirectory,
    () =>
      Schema.decodeUnknownSync(healthConfigSchema)(input.bot().health ?? {}),
  );

  return async (requested?: string) => {
    if (
      requested !== undefined &&
      !healthSections.includes(requested as Section)
    )
      return `Health sections: ${healthSections.join(", ")}.`;
    const bot = input.bot();

    // Parse separately so callers can use the reader before optional config wiring.
    const config = Schema.decodeUnknownSync(healthConfigSchema)(
      "health" in bot ? (bot.health ?? {}) : {},
    );

    const now = (input.now ?? Date.now)();
    const sources = input.sources ?? {};

    const want = (section: Section) =>
      requested === undefined || requested === section;

    const [
      host,
      status,
      crew,
      quota,
      ready,
      reports,
      alert,
      snapshot,
      gatewayState,
      opencodeState,
      proxyState,
      drainState,
    ] = await readHealthSources(input, {
      bot,
      config,
      now,
      sources,
      want,
      readHost,
    });

    const sections: Partial<Record<Section, SectionText>> = {};

    if (want("host")) sections.host = hostSection(host);

    const s = parsed(statusSchema, status);

    if (want("agents"))
      sections.agents = agentsSection(s, crew, config.stalledAfterSeconds, now);

    if (want("opencode")) sections.opencode = opencodeSection(s, opencodeState);

    if (want("stargate"))
      sections.stargate = stargateSection({
        drainState,
        ready,
        reports,
        alert,
        gatewayState,
        now,
        uptime: sources.uptime ?? (() => process.uptime()),
        schedules: input.schedules,
      });

    if (want("proxy")) sections.proxy = proxySection(quota, proxyState, now);

    if (want("services"))
      sections.services = {
        rows: [
          "⚠ Sourcebot health/mirror refresh/index age unknown",
          "⚠ Caddy routes unknown; Tailscale state/peers unknown",
          "⚠ failed units/timers unknown",
        ],
        summary:
          "Sourcebot health/mirror/index age unknown; Caddy routes unknown; Tailscale state/peers unknown; failed units/timers unknown",
      };

    if (want("starfleet"))
      sections.starfleet = starfleetSection(
        snapshot,
        now,
        config.snapshotMaxAgeSeconds,
      );

    return renderHealth(requested, sections);
  };
}
