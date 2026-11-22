import { join } from "node:path";
import { Schema } from "effect";
import { z } from "zod";
import type { AgentBackend } from "../backends/backend";
import type { BotConfig, Config } from "../config";
import { crewStatusSchema } from "../shared/crew-status";
import type { CronReportRow } from "../cron/store";
import { healthConfigSchema } from "./health-config";
import {
  createHostHealthReader,
  hostHealthSchema,
  readHealthFile,
} from "./health-host";
import {
  maintenanceDrainSchema,
  readMaintenanceDrain,
} from "../maintenance/maintenance-drain";
import { readReports, readUnit } from "../maintenance/nightly/droid-facts";
import { type CommandRunner, processRunner } from "../maintenance/nightly/exec";
import { readReady, readySchema } from "../maintenance/nightly/update/ready";
import { reportSchema } from "../maintenance/nightly/reports/report";
import { quotaSnapshotSchema } from "../quota/quota";
import { botStatusReport } from "../app/status-report";

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
const serviceState = z.enum(["active", "inactive", "failed", "unknown"]);
export const starfleetSnapshotSchema = z.strictObject({
  schema: z.literal("stargate.health.starfleet.v1"),
  observedAt: z.iso.datetime({ offset: true }),
  services: z.strictObject({
    avondale: serviceState,
    stargate: serviceState,
    opencode: serviceState,
    proxy: serviceState,
  }),
});
export async function readStarfleetSnapshot(path: string) {
  const text = await readHealthFile(path, 65536, true);
  try {
    return starfleetSnapshotSchema.parse(JSON.parse(text ?? ""));
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
const checkSchema = z.object({
  state: z.enum(["available", "failed", "unknown"]),
});
const statusSchema = z.object({
  checks: z.object({ backendRead: checkSchema, pinnedSession: checkSchema }),
  history: z.object({
    state: z.enum(["unknown", "incomplete"]),
    incidents: z
      .array(z.object({ count: z.number().int().nonnegative() }))
      .max(100),
  }),
  openCode: z
    .object({
      version: z.string().nullable(),
      activeSessions: z.number().int().nonnegative().nullable(),
      pendingForms: z.number().int().nonnegative().nullable(),
      pendingPermissions: z.number().int().nonnegative().nullable(),
      mcpConnected: z.number().int().nonnegative().nullable(),
      mcpFailed: z.number().int().nonnegative().nullable(),
    })
    .optional(),
});
const version = (value: unknown) =>
  typeof value === "string" &&
  /^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[a-zA-Z0-9.-]{1,32})?$/.test(value)
    ? value
    : "unknown";
const identifier = (value: string) =>
  /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : "unknown";
const number = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) || value < 0
    ? "unknown"
    : String(Math.round(value * 100) / 100);
const date = (value: number | null | undefined) =>
  value != null &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8640000000000000
    ? new Date(value).toISOString()
    : "unknown";
const mark = (state: string) =>
  ["active", "available"].includes(state)
    ? "✓"
    : ["failed", "inactive", "not-found"].includes(state)
      ? "✗"
      : "⚠";
const mib = (value: number | null | undefined) =>
  value == null ? "unknown" : `${number(value / 1048576)}MiB`;

/** A deadline bounds reply latency even when a third-party adapter ignores abort. */
async function bounded<T>(work: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5500);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
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
    ] = await Promise.all([
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
                  65536,
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
        ? bounded(sources.drain ?? (async () => readMaintenanceDrain()))
        : null,
    ]);
    const rows: Record<Section, string[]> = {
      host: [],
      agents: [],
      stargate: [],
      opencode: [],
      proxy: [],
      services: [],
      starfleet: [],
    };
    const summaries: Partial<Record<Section, string>> = {};
    if (want("host")) {
      const h = parsed(hostHealthSchema, host);
      rows.host.push(
        h
          ? `${h.load[0] > h.cores ? "⚠" : "✓"} load 1/5/15 ${h.load.map(number).join("/")}; cores ${number(h.cores)}; uptime ${number(h.uptimeSeconds)}s`
          : "⚠ load/cores/uptime unknown",
      );
      rows.host.push(
        `⚠ memory used/available/total ${mib(h?.availableMemory != null ? Math.max(0, h.totalMemory - h.availableMemory) : null)}/${mib(h?.availableMemory)}/${mib(h?.totalMemory)}; swap free/total ${mib(h?.swapFree)}/${mib(h?.swapTotal)}`,
      );
      for (const label of ["root", "stargate", "opencode", "crew"] as const) {
        const d = h?.disks.find((disk) => disk.label === label);
        rows.host.push(
          `⚠ disk ${label} free/total ${mib(d?.available)}/${mib(d?.total)}; inodes free/total ${number(d?.freeInodes)}/${number(d?.inodes)}`,
        );
      }
      rows.host.push(
        h?.growth
          ? `⚠ growth ${h.growth.label} ${mib(h.growth.bytes)} over ${number(h.growth.intervalSeconds)}s (free-space change)`
          : "⚠ growth unknown (no prior observation)",
      );
      rows.host.push(
        `⚠ top CPU/memory ${h?.processes?.length ? "sampled, not a complete inventory" : "unknown"}; first CPU rate needs a baseline`,
      );
      for (const process of h?.processes ?? []) {
        rows.host.push(
          `⚠ ${process.label} PID ${number(process.pid)} CPU ${number(process.cpuPercent)}%; memory ${mib(process.memoryBytes)}`,
        );
      }
      rows.host.push(
        `⚠ process identities use fixed labels: stargate/opencode/proxy/sourcebot/other; unobserved processes unknown`,
      );
      rows.host.push(
        `⚠ reboot-required marker ${h?.rebootPending == null ? "unknown" : h.rebootPending ? "present" : "absent"}; time-sync marker ${h?.timeSynchronized == null ? "unknown" : h.timeSynchronized ? "present" : "absent"}`,
      );
      const root = h?.disks.find((disk) => disk.label === "root");
      summaries.host = `load ${h ? h.load.map(number).join("/") : "unknown"}; cores ${number(h?.cores)}; memory free ${mib(h?.availableMemory)}; root free ${mib(root?.available)}; extended coverage unknown`;
    }
    const s = parsed(statusSchema, status);
    if (want("agents")) {
      const pin = s?.checks.pinnedSession.state ?? "unknown";
      rows.agents.push(
        `${mark(pin)} captain pinned readiness ${pin}; current task/queued tasks/running duration/last activity unknown`,
      );
      rows.agents.push(
        `⚠ native activity unknown; stalled unknown (no last-activity source; limit ${config.stalledAfterSeconds}s)`,
      );
      const c = parsed(crewStatusSchema, crew);
      rows.agents.push(
        c
          ? `⚠ crew ownership: total ${c.total}; ${c.truncated ? "truncated; " : ""}native availability unknown`
          : "⚠ crew ownership unknown",
      );
      summaries.agents = `captain readiness ${pin}; visible ownership ${c ? c.members.filter((member) => member.current !== null).length : "unknown"}/${c?.total ?? "unknown"}; visible queued ${c ? c.members.reduce((sum, member) => sum + member.queuedCount, 0) : "unknown"}; native activity/stalled unknown`;
      for (const member of c?.members ?? [])
        rows.agents.push(
          `⚠ ${identifier(member.id)} ${member.backend} ${member.provisioned}; observed ${member.observed}; ownership ${member.current?.status ?? "none"}${member.current ? ` ${identifier(member.current.id)}` : ""}; queued ${member.queuedCount}; start ${date(member.current?.startedAt)}; running duration ${member.current?.startedAt != null && member.current.startedAt <= now ? `${number((now - member.current.startedAt) / 1000)}s` : "unknown"}; update ${date(member.current?.updatedAt)}; last activity unknown`,
        );
    }
    if (want("opencode")) {
      for (const [label, check] of [
        ["backend read", s?.checks.backendRead],
        ["pinned session", s?.checks.pinnedSession],
      ] as const) {
        const state = check?.state ?? "unknown";
        rows.opencode.push(`${mark(state)} ${label} ${state}`);
      }
      rows.opencode.push(
        `${mark(opencodeState ?? "unknown")} unit ${opencodeState ?? "unknown"}; unit started unknown; version ${version(s?.openCode?.version)}`,
      );
      rows.opencode.push(
        `⚠ active sessions ${number(s?.openCode?.activeSessions)}; pending forms ${number(s?.openCode?.pendingForms)}; permissions ${number(s?.openCode?.pendingPermissions)}`,
      );
      summaries.opencode = `backend ${s?.checks.backendRead.state ?? "unknown"}; version ${version(s?.openCode?.version)}; MCP connected ${number(s?.openCode?.mcpConnected)}, failed ${number(s?.openCode?.mcpFailed)}; last-hour metrics unknown`;
      rows.opencode.push(
        `${s?.openCode?.mcpFailed ? "✗" : "⚠"} MCP connected ${number(s?.openCode?.mcpConnected)}; failed ${number(s?.openCode?.mcpFailed)}`,
      );
      rows.opencode.push(
        `⚠ last-hour requests/success/errors/latency unknown; 24h incidents ${s?.history.state === "incomplete" ? s.history.incidents.reduce((sum, incident) => sum + incident.count, 0) : "unknown"}; 24h coverage ${s?.history.state ?? "unknown"}`,
      );
    }
    if (want("stargate")) {
      const decoded = Schema.decodeUnknownOption(maintenanceDrainSchema)(
        drainState,
      );
      if (decoded._tag === "Some") {
        const drain = decoded.value;
        rows.stargate.push(
          `⚠ restart drain ${drain.phase}; job ${drain.job}; services ${drain.services.join(", ")}; deadline ${date(drain.deadlineAt)}; stragglers ${drain.stragglers?.length ?? 0}`,
        );
        for (const work of drain.stragglers?.slice(0, 8) ?? [])
          rows.stargate.push(
            `⚠ drain ${identifier(work.taskID ?? "unknown-task")} ${identifier(work.sessionID ?? "unknown-session")}: ${identifier(work.reason)}`,
          );
      } else rows.stargate.push("⚠ restart drain inactive or unknown");
      const r = parsed(readySchema, ready);
      const valid = r && r.readyAt <= now;
      rows.stargate.push(
        `${mark(gatewayState ?? "unknown")} unit ${gatewayState ?? "unknown"}; version ${valid ? version(r.version) : "unknown"}; ready ${valid ? date(r.readyAt) : "unknown"}`,
      );
      rows.stargate.push(
        "⚠ last delivered unknown; last-hour delivery errors unknown; last-hour refused messages unknown; latest release version unknown",
      );
      rows.stargate.push(
        `⚠ gateway uptime ${number((sources.uptime ?? process.uptime)())}s; ${valid && r.transports ? `transports ${r.transports.filter((transport) => transport.state === "connected").length}/${r.transports.length} connected` : "Slack/IRC connection unknown"}; last alert ${alert ? "present; state unknown" : "unknown"}`,
      );
      if (valid && r.transports)
        for (const transport of r.transports.slice(0, 30))
          rows.stargate.push(
            `${transport.state === "connected" ? "✓" : "✗"} ${transport.kind} ${transport.id.replace(/[^a-zA-Z0-9:_-]/g, "?").slice(0, 80)}: ${transport.state}; observed ${date(r.transportObservedAt ?? r.readyAt)}`,
          );
      const report = parsed(
        z.object({
          reports: z
            .array(
              z.object({
                startedAt: z.iso.datetime({ offset: true }),
                outcome: reportSchema.shape.outcome,
              }),
            )
            .max(1),
          unreadable: z.number().int().nonnegative(),
        }),
        reports,
      );
      const latest = report?.reports[0];
      summaries.stargate = `installed ${valid ? version(r.version) : "unknown"}; unit ${gatewayState ?? "unknown"}; last maintenance ${latest?.outcome ?? "unknown"}; delivery/latest release/coverage unknown`;
      rows.stargate.push(
        `${mark(latest?.outcome ?? "unknown")} last maintenance ${latest ? `${latest.outcome} ${latest.startedAt}` : "unknown"}; report coverage ${report?.unreadable ? "unknown" : "unknown beyond latest report"}`,
      );
      rows.stargate.push("⚠ cron coverage unknown beyond listed rows");
      let schedules: CronReportRow[] = [];
      let cronKnown = false;
      try {
        schedules = input.schedules?.() ?? [];
        cronKnown = input.schedules !== undefined;
      } catch {
        /* Store read failure is unknown, not no schedules. */
      }
      for (const schedule of schedules.slice(0, 20)) {
        const state =
          parsed(
            z.enum([
              "pending",
              "announcing",
              "announced",
              "queued",
              "blocked",
              "done",
              "failed",
              "canceled",
            ]),
            schedule.lastStatus,
          ) ?? "unknown";
        rows.stargate.push(
          `${mark(state)} cron ${identifier(schedule.id)} ${state}; last ${date(schedule.lastRunAt)}`,
        );
      }
      if (schedules.some((schedule) => schedule.lastStatus === "failed"))
        rows.stargate.push(
          "✗ cron failed; coverage unknown beyond listed rows",
        );
      summaries.stargate += `; cron failed ${cronKnown ? schedules.filter((schedule) => schedule.lastStatus === "failed").length : "unknown"}`;
    }
    if (want("proxy")) {
      rows.proxy.push(
        `${mark(proxyState ?? "unknown")} unit ${proxyState ?? "unknown"}; unit started unknown; version unknown`,
      );
      rows.proxy.push(
        "⚠ request/error/latency/cache warmth unknown; quota is not token usage or routing availability",
      );
      const q = parsed(quotaSnapshotSchema, quota);
      const firstAccount = q?.accounts[0];
      const firstWindow = firstAccount?.windows[0];
      summaries.proxy = `unit ${proxyState ?? "unknown"}; first quota ${firstAccount?.account ?? "unknown"} ${firstWindow?.window ?? "unknown"}, used ${number(firstWindow?.usedPercent)}%, remaining ${number(firstWindow?.remainingPercent)}%, reset ${date(firstWindow?.resetAt)}; availability/metrics unknown`;
      rows.proxy.push(
        `⚠ quota observed ${q ? date(q.observedAt) : "unknown"}; availability unknown`,
      );
      for (const account of q?.accounts ?? []) {
        rows.proxy.push(
          `⚠ ${account.provider} ${account.account}; observed ${date(account.observedAt)}; availability unknown`,
        );
        for (const window of account.windows) {
          const expired = window.resetAt !== null && window.resetAt <= now;
          rows.proxy.push(
            `⚠ ${window.scope} ${window.window}: used ${number(window.usedPercent)}%; remaining ${number(window.remainingPercent)}%; reset ${date(window.resetAt)}; availability unknown${expired ? "; reset passed" : ""}${window.active === false ? "; inactive" : ""}`,
          );
        }
      }
    }
    if (want("services")) {
      rows.services.push(
        "⚠ Sourcebot health/mirror refresh/index age unknown",
        "⚠ Caddy routes unknown; Tailscale state/peers unknown",
        "⚠ failed units/timers unknown",
      );
      summaries.services =
        "Sourcebot health/mirror/index age unknown; Caddy routes unknown; Tailscale state/peers unknown; failed units/timers unknown";
    }
    if (want("starfleet")) {
      const remote = parsed(starfleetSnapshotSchema, snapshot);
      const age = remote ? now - Date.parse(remote.observedAt) : null;
      const current =
        age !== null && age >= 0 && age <= config.snapshotMaxAgeSeconds * 1000;
      const states = remote ? Object.values(remote.services) : [];
      summaries.starfleet = `remote cached age ${age === null || age < 0 ? "unknown" : `${number(age / 1000)}s`}; failed/inactive services ${current ? states.filter((state) => state === "failed" || state === "inactive").length : "unknown"}; current ${current ? `${states.filter((state) => state === "unknown").length} unknown services; live reachability unknown` : "unknown"}`;
      rows.starfleet.push(
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
        rows.starfleet.push(`${mark(state)} ${service} ${state}`);
      }
    }
    const aggregate = (section: Section) =>
      rows[section].some((row) => row.startsWith("✗"))
        ? "✗"
        : rows[section].some((row) => row.startsWith("⚠"))
          ? "⚠"
          : "✓";
    const header = "Health · read-only\n";
    if (requested === undefined)
      return (
        header +
        healthSections
          .map((section) => {
            const line = `${aggregate(section)} ${section}: ${summaries[section] ?? "unknown"}`;
            return line.length <= 400
              ? line
              : `${line.slice(0, 370)}; coverage unknown`;
          })
          .join("\n")
      );
    const section = requested as Section;
    const detail = `${aggregate(section)} ${section}\n${rows[section].join("\n")}`;
    const suffix = "\n⚠ truncated; omitted states unknown";
    return (
      header +
      (detail.length <= 2999 - header.length
        ? detail
        : detail.slice(0, 2999 - header.length - suffix.length) + suffix)
    );
  };
}
