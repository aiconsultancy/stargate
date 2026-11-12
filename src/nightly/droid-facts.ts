import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config";
import type { CommandRunner } from "./exec";
import { proxyModels } from "./host";
import { Journal, journalEntries } from "./journal";
import { maintenanceDirectory } from "./paths";
import { readReady, readyProcessAlive } from "./ready";
import { linkedRelease } from "./release";
import {
  alertSchemaID,
  listReports,
  type Report,
  reportSchema,
} from "./report";
import { readState } from "./state";
import { compareVersions } from "./versions";
import {
  defaultInstallID,
  nextWindow,
  previousWindow,
  stableJitter,
} from "./window";

/**
 * Read-only facts for the maintenance droid. Everything here is collected by
 * Pogo code, never by the model, and holds only states, versions, reason
 * codes, times and private local paths: no file contents beyond schema-checked
 * fields, no command output, no environment values and no credentials.
 */

const unitStates = [
  "active",
  "reloading",
  "refreshing",
  "activating",
  "deactivating",
  "inactive",
  "failed",
  "not-found",
  "unknown",
] as const;
export type UnitState = (typeof unitStates)[number];
export const runningUnit = (state: UnitState) =>
  state === "active" || state === "reloading" || state === "refreshing";
const busyUnit = (state: UnitState) =>
  runningUnit(state) || state === "activating" || state === "deactivating";

/** `systemctl --user show` with an allowlist of properties; null: no answer. */
async function showUnit(
  runner: CommandRunner,
  unit: string,
  properties: readonly string[],
) {
  const result = await runner
    .run(
      [
        "systemctl",
        "--user",
        "show",
        unit,
        `--property=${properties.join(",")}`,
        "--timestamp=unix",
      ],
      { timeoutMs: 15_000 },
    )
    .catch(() => null);
  if (result?.code !== 0) return null;
  const values: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const equals = line.indexOf("=");
    const key = line.slice(0, equals);
    if (equals > 0 && properties.includes(key))
      values[key] = line.slice(equals + 1).trim();
  }
  return values;
}

function unitState(values: Record<string, string> | null): UnitState {
  if (!values) return "unknown";
  if (values["LoadState"] === "not-found") return "not-found";
  const state = values["ActiveState"] ?? "";
  return (unitStates as readonly string[]).includes(state)
    ? (state as UnitState)
    : "unknown";
}

export async function readUnit(runner: CommandRunner, unit: string) {
  return unitState(await showUnit(runner, unit, ["LoadState", "ActiveState"]));
}

/** `@<seconds>` (systemctl --timestamp=unix) to ISO; anything else: null. */
function unixTime(value: string | undefined) {
  const match = /^@(\d{1,12})$/.exec(value ?? "");
  return match ? new Date(Number(match[1]) * 1000).toISOString() : null;
}

/** OpenCode's unit, when its restart command is a plain systemctl restart. */
function openCodeUnit(command: readonly string[]) {
  const [tool, scope, action, unit] = command;
  return command.length === 4 &&
    tool === "systemctl" &&
    scope === "--user" &&
    action === "restart" &&
    unit?.endsWith(".service")
    ? unit
    : undefined;
}

export type Scrub = (text: string) => string;

/**
 * Scrub first, then bound: a cut never lands inside a secret that the
 * scrubber would have recognised whole.
 */
const cleaner =
  (scrub: Scrub) =>
  (text: string, max = 200) =>
    Array.from(scrub(text.replace(/\p{Cc}+/gu, " ")))
      .slice(0, max)
      .join("");

const alertSchema = z.strictObject({
  schema: z.literal(alertSchemaID),
  runID: z.string().max(100),
  at: z.iso.datetime({ offset: true }),
  outcome: z.string().max(50),
  reason: z.string().max(50).optional(),
  report: z.string().max(200).nullable(),
  journal: z.boolean(),
});

/** One report reduced to what explains the night; bounded. */
export function digestReport(name: string, report: Report, scrub: Scrub) {
  const clean = cleaner(scrub);
  const models = { applied: 0, rolledBack: 0, failed: 0, skipped: 0 };
  for (const change of report.models)
    if (change.status === "applied") models.applied++;
    else if (change.status === "rolled-back") models.rolledBack++;
    else if (change.status === "failed") models.failed++;
    else if (change.status === "skipped") models.skipped++;
  return {
    name: clean(name),
    startedAt: report.startedAt,
    outcome: report.outcome,
    ...(report.reason ? { reason: report.reason } : {}),
    changed: report.components
      .filter((c) => c.status !== "unchanged")
      .slice(0, 12)
      .map((c) => ({
        id: clean(c.id, 80),
        status: c.status,
        before: c.before === null ? null : clean(c.before, 40),
        after: c.after === null ? null : clean(c.after, 40),
        ...(c.reason ? { reason: c.reason } : {}),
      })),
    failedSteps: report.steps
      .filter((s) => s.status === "failed")
      .slice(0, 8)
      .map((s) => ({
        name: clean(s.name, 60),
        ...(s.reason ? { reason: s.reason } : {}),
      })),
    rollbacks: report.rollbacks.slice(0, 8).map((r) => ({
      component: clean(r.component, 80),
      status: r.status,
    })),
    failedRestarts: report.restarts
      .filter((r) => r.status === "failed")
      .map((r) => r.service),
    models,
  };
}
export type ReportDigest = ReturnType<typeof digestReport>;

/** Newest first; unreadable or foreign reports are counted, not shown. */
export async function readReports(
  dataDirectory: string,
  limit: number,
  scrub: Scrub,
) {
  const names = (await listReports(dataDirectory)).slice(-limit).reverse();
  const reports: ReportDigest[] = [];
  let unreadable = 0;
  for (const name of names) {
    try {
      const parsed = reportSchema.safeParse(
        JSON.parse(
          await readFile(
            join(maintenanceDirectory(dataDirectory), "reports", name),
            "utf8",
          ),
        ),
      );
      if (parsed.success) reports.push(digestReport(name, parsed.data, scrub));
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return { reports, unreadable };
}

export async function collectFacts(input: {
  config: Config;
  configPath: string;
  runner: CommandRunner;
  now: number;
  /** Applied to every free-text field before it is bounded. */
  scrub: Scrub;
}) {
  const clean = cleaner(input.scrub);
  const { config, runner, now } = input;
  const m = config.maintenance;
  if (!m) throw new Error("No maintenance section in configuration.");
  const droid = m.droid;
  const data = config.dataDirectory;
  const installID = m.installID ?? defaultInstallID(resolve(input.configPath));
  const jitter = stableJitter(installID, m.window.jitterMinutes);
  const last = previousWindow(now, m.window, jitter);
  const next = nextWindow(now, m.window, jitter);
  const timerName = droid?.timer ?? "pogo-maintenance";
  const timerValues = await showUnit(runner, `${timerName}.timer`, [
    "LoadState",
    "ActiveState",
    "LastTriggerUSec",
    "NextElapseUSecRealtime",
    "Result",
    "ActiveEnterTimestamp",
  ]);
  const run = await readUnit(runner, `${timerName}.service`);
  const gateway = await readUnit(runner, m.services.gateway);
  const proxyUnit = m.cliproxyapi?.unit;
  const openCode = openCodeUnit(m.services.openCodeRestart);
  const ready = await readReady(data);
  const journal = await Journal.read(config);
  const state = await readState(data);
  const current = m.pogo
    ? ((await linkedRelease(m.pogo.root, "current"))?.metadata.version ?? null)
    : null;
  const alertText = await readFile(
    join(maintenanceDirectory(data), "ALERT.json"),
    "utf8",
  ).catch(() => null);
  const alert =
    alertText === null
      ? null
      : (() => {
          try {
            const parsed = alertSchema.safeParse(JSON.parse(alertText));
            return parsed.success
              ? {
                  runID: clean(parsed.data.runID, 100),
                  at: parsed.data.at,
                  outcome: clean(parsed.data.outcome, 50),
                  ...(parsed.data.reason
                    ? { reason: clean(parsed.data.reason, 50) }
                    : {}),
                  report: parsed.data.report && clean(parsed.data.report),
                  journal: parsed.data.journal,
                }
              : { unreadable: true as const };
          } catch {
            return { unreadable: true as const };
          }
        })();
  const lastRunPath = join(maintenanceDirectory(data), "last-run.json");
  const lastRun = await Promise.all([
    readFile(lastRunPath, "utf8"),
    stat(lastRunPath),
  ])
    .then(([text, info]) => {
      const parsed = z.object({ runID: z.uuid() }).safeParse(JSON.parse(text));
      return parsed.success
        ? { runID: parsed.data.runID, startedAt: info.mtime.toISOString() }
        : null;
    })
    .catch(() => null);
  const { reports, unreadable } = await readReports(
    data,
    droid?.reports ?? 7,
    input.scrub,
  );
  const proxyHealthy = m.proxy
    ? await proxyModels(m.proxy, AbortSignal.timeout(20_000)).then(
        () => true,
        () => false,
      )
    : null;
  return {
    now: new Date(now).toISOString(),
    enabled: m.enabled,
    alertPath: join(maintenanceDirectory(data), "ALERT.json"),
    window: {
      timeZone: m.window.timeZone,
      localStart: m.window.start,
      localEnd: m.window.end,
      lastPlannedStart: new Date(last.start).toISOString(),
      nextPlannedStart: new Date(next.start).toISOString(),
    },
    timer: {
      name: `${timerName}.timer`,
      state: unitState(timerValues),
      lastTrigger: unixTime(timerValues?.["LastTriggerUSec"]),
      nextElapse: unixTime(timerValues?.["NextElapseUSecRealtime"]),
      activeSince: unixTime(timerValues?.["ActiveEnterTimestamp"]),
      result: timerValues?.["Result"] ? clean(timerValues["Result"], 40) : null,
      runActive: busyUnit(run),
    },
    units: {
      gateway: { unit: m.services.gateway, state: gateway },
      ...(proxyUnit
        ? {
            proxy: {
              unit: proxyUnit,
              state: await readUnit(runner, proxyUnit),
            },
          }
        : {}),
      ...(openCode
        ? {
            openCode: {
              unit: openCode,
              state: await readUnit(runner, openCode),
            },
          }
        : {}),
    },
    ready: ready
      ? {
          alive: readyProcessAlive(ready),
          version: ready.version === null ? null : clean(ready.version, 40),
          readyAt: new Date(ready.readyAt).toISOString(),
        }
      : null,
    proxyHealthy,
    lastRun,
    journal:
      journal.kind === "ok"
        ? {
            state: "present" as const,
            runID: journal.journal.runID,
            entries: journalEntries.filter(
              (entry) => journal.journal.get(entry) !== undefined,
            ),
          }
        : {
            state:
              journal.kind === "none"
                ? ("none" as const)
                : ("corrupt" as const),
          },
    alert,
    release: {
      current,
      knownBad: Object.entries(state.failedReleases)
        .filter(
          ([version]) =>
            current === null || compareVersions(version, current) > 0,
        )
        .slice(0, 5)
        .map(([version, entry]) => ({
          version: clean(version, 40),
          reason: clean(entry.reason, 50),
          at: entry.at,
        })),
    },
    reports,
    unreadableReports: unreadable,
  };
}
export type DroidFacts = Awaited<ReturnType<typeof collectFacts>>;

export const findingCodes = [
  "timer-inactive",
  "timer-missed",
  "alert",
  "journal",
  "journal-corrupt",
  "gateway-down",
  "opencode-down",
  "proxy-unhealthy",
  "runs-failing",
  "known-bad",
  "reports-unreadable",
] as const;
export type Finding = {
  code: (typeof findingCodes)[number];
  text: string;
  /** Operator commands, deterministic; the droid never runs them. */
  commands: string[];
};

/**
 * The deterministic problem list. Authoritative: the post always carries it,
 * whatever the model writes. While a maintenance run is active, its own
 * stops and journal are expected and not reported.
 */
export function findings(
  facts: DroidFacts,
  settings: { configPath: string; failedNights: number },
): Finding[] {
  const list: Finding[] = [];
  const pogo = (operation: string, extra = "") =>
    `pogo maintenance ${operation} --config ${settings.configPath}${extra}`;
  const status = (unit: string) => `systemctl --user status ${unit}`;
  const logs = (unit: string) => `journalctl --user -u ${unit} -n 50`;
  const { timer } = facts;
  const running = timer.runActive;
  if (facts.enabled) {
    if (!runningUnit(timer.state))
      list.push({
        code: "timer-inactive",
        text: `The maintenance timer ${timer.name} is ${timer.state}; no nightly run will start.`,
        commands:
          timer.state === "not-found"
            ? [pogo("install-timer", " --print")]
            : [
                status(timer.name),
                `systemctl --user enable --now ${timer.name}`,
              ],
      });
    else {
      const planned = Date.parse(facts.window.lastPlannedStart);
      const since = timer.activeSince ? Date.parse(timer.activeSince) : null;
      const fired = timer.lastTrigger ? Date.parse(timer.lastTrigger) : null;
      if (
        !running &&
        since !== null &&
        since <= planned &&
        Date.parse(facts.now) >= planned + 30 * 60_000 &&
        (fired === null || fired < planned - 5 * 60_000)
      )
        list.push({
          code: "timer-missed",
          text: `The maintenance timer did not fire for the window planned at ${facts.window.lastPlannedStart}.`,
          commands: [status(timer.name), "systemctl --user list-timers"],
        });
    }
  }
  if (facts.alert)
    list.push({
      code: "alert",
      text:
        "unreadable" in facts.alert
          ? "maintenance/ALERT.json exists but cannot be read."
          : `ALERT.json: run ${facts.alert.runID} ended ${facts.alert.outcome}${facts.alert.reason ? ` (${facts.alert.reason})` : ""}${facts.alert.journal ? " and left a journal" : ""}. Review the report, then delete ALERT.json.`,
      commands: [`cat ${facts.alertPath}`],
    });
  if (!running && facts.journal.state === "present")
    list.push({
      code: "journal",
      text: `An interrupted run left a journal (${facts.journal.entries.join(", ")}). The next run recovers it after its idle gate.`,
      commands: [pogo("recover")],
    });
  if (facts.journal.state === "corrupt")
    list.push({
      code: "journal-corrupt",
      text: "The maintenance journal is corrupt or not private. Runs refuse to proceed until an operator inspects it.",
      commands: [pogo("recover", " --accept-current journal")],
    });
  const gateway = facts.units.gateway;
  if (!running && (!runningUnit(gateway.state) || !facts.ready?.alive))
    list.push({
      code: "gateway-down",
      text: runningUnit(gateway.state)
        ? `The gateway unit ${gateway.unit} is ${gateway.state} but has no live readiness record.`
        : `The gateway unit ${gateway.unit} is ${gateway.state}; Slack messages are not handled.`,
      commands: [status(gateway.unit), logs(gateway.unit)],
    });
  const openCode = facts.units.openCode;
  if (!running && openCode && !runningUnit(openCode.state))
    list.push({
      code: "opencode-down",
      text: `The OpenCode unit ${openCode.unit} is ${openCode.state}.`,
      commands: [status(openCode.unit), logs(openCode.unit)],
    });
  const proxy = facts.units.proxy;
  if (
    !running &&
    (facts.proxyHealthy === false || (proxy && !runningUnit(proxy.state)))
  )
    list.push({
      code: "proxy-unhealthy",
      text: `CLIProxyAPI ${proxy ? `(${proxy.unit}, ${proxy.state}) ` : ""}does not answer GET /v1/models.`,
      commands: proxy ? [status(proxy.unit), logs(proxy.unit)] : [],
    });
  const recent = facts.reports.slice(0, settings.failedNights);
  if (
    recent.length === settings.failedNights &&
    recent.every((r) => r.outcome === "failed" || r.outcome === "deferred")
  )
    list.push({
      code: "runs-failing",
      text: `The last ${recent.length} run(s) ended ${recent.map((r) => `${r.outcome}${r.reason ? ` (${r.reason})` : ""}`).join(", ")}.`,
      commands: [pogo("plan")],
    });
  if (facts.release.knownBad.length)
    list.push({
      code: "known-bad",
      text: `Known-bad Pogo release(s) newer than the current ${facts.release.current ?? "release"}: ${facts.release.knownBad.map((r) => `${r.version} (${r.reason})`).join(", ")}. Updates wait for a newer release.`,
      commands: [],
    });
  if (facts.unreadableReports)
    list.push({
      code: "reports-unreadable",
      text: `${facts.unreadableReports} recent report(s) cannot be read or have an unknown schema.`,
      commands: [],
    });
  return list;
}
