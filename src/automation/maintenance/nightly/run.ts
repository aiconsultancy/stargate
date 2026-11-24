import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, realpath, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Result, Schema } from "effect";
import { type Config, pinnedSessionIDs } from "../../../config";
import { settingsStruct } from "../../../config/settings-schema";
import {
  type MaintenanceDrain,
  claimMaintenanceDrain,
  maintenanceDrainDirectory,
  readDrainParticipants,
  writeMaintenanceDrain,
} from "../maintenance-drain";
import { isAllowedChannel } from "../../../shared/registration";
import { type CleanupResult, runCleanup } from "./cleanup/cleanup";
import { cleanupProtection } from "./cleanup/cleanup-protection";
import { type MaintenanceConfig, defaultCronHorizonMinutes } from "./config";
import { type Crew, crewDatabase, discoverCrews } from "./crews";
import { type Clock, waitForMaintenanceDrain } from "./schedule/drain";
import {
  type CommandRunner,
  type Reason,
  StepError,
  processRunner,
  reasonOf,
} from "./exec";
import { atomicWrite, readOptional } from "./files";
import {
  type AgentPlan,
  type ProxyCandidate,
  agentCliInstall,
  agentCliPlan,
  agentCliVerify,
  binaryPath,
  cliProxyCandidate,
  cliProxyCurrent,
  cliProxyPrepare,
  cliProxySwitch,
  needsUpdate,
  probeModel,
  proxyModels,
} from "./update/host";
import {
  type IdleResult,
  type IdleScope,
  checkIdle,
  describeRunningWork,
  queuedCrewTasks,
  queuedTaskAction,
  waitForIdle,
} from "./schedule/idle";
import {
  FileChanges,
  Journal,
  type JournalEntry,
  type UndoContext,
  type UndoEvent,
  type UndoStep,
  backupDirectory,
  currentVersion,
  describeEntry,
  journalEntries,
  journalFiles,
  journalScope,
  undoJournal,
  undoStepScope,
  unitRunning,
} from "./journal";
import {
  type ModelInputs,
  type ModelWork,
  type Session,
  applyLiveModels,
  buildModelWork,
  readModelInputs,
  selectModelUpgrades,
} from "./update/model-step";
import {
  type OpenCodeControl,
  connectOpenCode,
  openCodeCallMs,
} from "./update/opencode";
import { maintenanceDirectory } from "./paths";
import { readPluginDigest } from "./update/plugin-digest";
import { readReady, readyProcessAlive, waitReady } from "./update/ready";
import {
  githubHeaders,
  githubToken,
  linkedRelease,
  namedRelease,
  newerRelease,
  pruneReleases,
  stageRelease,
  switchCurrent,
} from "./update/release";
import {
  type Report,
  ReportRecorder,
  noticeSchemaID,
  queueNotice,
  reportSchemaID,
  summary,
  writeAlert,
  writeReport,
} from "./reports/report";
import { readState, updateState } from "./state";
import { compareVersions, normalizeVersion } from "./update/versions";
import {
  type Occurrence,
  currentWindow,
  defaultInstallID,
  nextWindow,
  stableJitter,
  windowMinutes,
} from "./schedule/window";

export type { Clock } from "./schedule/drain";

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
};

export type Dependencies = {
  runner: CommandRunner;
  clock: Clock;
  connect: () => Promise<OpenCodeControl>;
  env: NodeJS.ProcessEnv;
  uuid: () => string;
  /** Tests only: false simulates a hard kill (no in-process undo). */
  undoOnExit?: boolean;
  /** Injectable filesystem boundary for orchestration tests. */
  cleanup?: typeof runCleanup;
  /** Isolated barrier directory for tests; production uses the host/user scope. */
  drainDirectory?: string;
};

export const defaultDependencies: Dependencies = {
  runner: processRunner,
  clock: systemClock,
  connect: connectOpenCode,
  env: process.env,
  uuid: randomUUID,
};

export type RunInput = {
  config: Config;
  configPath: string;
  mode: "plan" | "run";
  /** Operator-started run outside the window, with the window's length. */
  outsideWindow?: boolean;
  /**
   * Operator-approved update to one Stargate release, now: no window, no idle
   * gate and no cool-off. Only the Stargate release changes. Everything else is
   * the run's own path: verified staging, journal, switch, readiness check
   * and rollback. Refused while a journal is left over.
   */
  update?: {
    version: string;
    retryFailed?: boolean;
    /** Installed code used by this unit and its ExecStopPost recovery. */
    runnerRelease?: string;
  };
  signal: AbortSignal;
};

/** The operator asked for something that an update never does. */
export class UpdateRefused extends Error {}

/** An operator update has this long: staging and tests, then the switch. */
const updateWindowMs = 90 * 60_000;
const updateReserveMs = 10 * 60_000;

export type RunResult = {
  report: Report;
  reportPath?: string;
  /** An operator must look: failure, unrecovered journal or missing report. */
  attention: boolean;
};

type Maintenance = MaintenanceConfig;

/**
 * Upper bounds of each disruptive step, in milliseconds. Every command and
 * OpenCode call uses these timeouts, so the forward apply path cannot take
 * longer than `applyBudgetMs`. Undo after a failure is bounded separately
 * by `recoveryBudgetMs` (timer TimeoutStartSec/TimeoutStopSec margins).
 */
export const bounds = {
  stop: 90_000,
  start: 60_000,
  ready: 120_000,
  proxyRestart: 60_000,
  proxyHealth: 60_000,
  openCodeRestart: 120_000,
  openCodeVerify: 120_000,
  call: openCodeCallMs,
  /**
   * The live-session phase stops switching when this ends. Unswitched
   * sessions keep their (still valid) model and are reported, so the
   * budget never grows with the number of sessions.
   */
  sessions: 5 * 60_000,
};

/** Worst case of the forward path once the gateway stops. */
export function applyBudgetMs(plan: {
  proxy: boolean;
  restart: boolean;
  release: boolean;
  /** Sessions or agents to verify: adds the fixed session-phase cap. */
  live: boolean;
}) {
  return (
    bounds.stop +
    (plan.proxy ? bounds.proxyRestart + bounds.proxyHealth : 0) +
    (plan.restart ? bounds.openCodeRestart + bounds.openCodeVerify : 0) +
    (plan.live ? bounds.sessions : 0) +
    bounds.start +
    bounds.ready +
    // A failed readiness check restores the release and tries once more.
    // OpenCode restarts again only when it loaded the new release.
    (plan.release
      ? (plan.restart ? bounds.openCodeRestart + bounds.openCodeVerify : 0) +
        bounds.start +
        bounds.ready
      : 0)
  );
}

/** Idle work appeared: undo this run's changes and wait for the next window. */
class Defer extends Error {
  public constructor(public readonly reason: Reason) {
    super(reason);
  }
}

function lock(dataDirectory: string) {
  const path = join(maintenanceDirectory(dataDirectory), "run.sqlite");
  const db = new Database(path, { create: true });

  try {
    db.run("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");

    return db;
  } catch {
    db.close();
    throw new Error("Another maintenance run holds the lock.");
  }
}

/**
 * Sessions whose model follows an upgrade: the operator-pinned captain
 * sessions and the OpenCode crew sessions. Per-thread Slack sessions of
 * unpinned bots are not switched; they keep their valid model.
 */
function sessions(config: Config, crews: readonly Crew[]): Session[] {
  const found = new Map<string, Session["scope"]>();

  for (const sessionID of pinnedSessionIDs(config)) {
    found.set(sessionID, "captain-session");
  }

  for (const crew of crews) {
    const path = crewDatabase(crew);

    if (!existsSync(path)) {
      continue;
    }

    const db = new Database(path, { readonly: true });

    try {
      for (const row of db
        .query<{ id: string }, []>(
          "SELECT sessionID AS id FROM peers WHERE sessionID NOT IN (SELECT sessionID FROM pi_peers)",
        )
        .all()) {
        found.set(row.id, "crew-session");
      }
    } catch {
      // Unknown crew state is handled by the idle gate (fails closed).
    } finally {
      db.close();
    }
  }

  return [...found].map(([id, scope]) => ({ id, scope }));
}

const iso = (ms: number) => new Date(ms).toISOString();

function windowReport(
  window: Occurrence,
  spec: Maintenance["window"],
  jitter: number,
): Report["window"] {
  return {
    timeZone: spec.timeZone,
    localStart: spec.start,
    localEnd: spec.end,
    opens: iso(window.opens),
    plannedStart: iso(window.start),
    deadline: iso(window.deadline),
    closes: iso(window.closes),
    jitterMinutes: jitter,
  };
}

function recordUndo(rec: ReportRecorder) {
  return (event: UndoEvent) => {
    if (event.kind === "restart") {
      rec.restart(event.service, event.ok);
    } else if (event.kind === "deferred") {
      rec.step(`recover-before-${event.step}`, "skipped", event.reason);
    } else {
      rec.rollbacks.push({
        component: event.component,
        from: event.from,
        to: event.to,
        status: event.ok ? "ok" : "failed",
        ...(event.reason && { reason: event.reason }),
      });
    }
  };
}

function undoContext(
  config: Config,
  deps: Dependencies,
  rec?: ReportRecorder,
): UndoContext {
  const never = new AbortController().signal;

  return {
    config,
    runner: deps.runner,
    connect: deps.connect,
    sleep: (ms) => deps.clock.sleep(ms, never),
    now: () => deps.clock.now(),
    ...(rec && { record: recordUndo(rec) }),
  };
}

/**
 * The run that last started, with systemd's INVOCATION_ID. ExecStopPost
 * runs in the same invocation, so a matching ID proves the file is not left
 * over from an earlier run that exited before writing its own.
 */
const decodeLastRun = Schema.decodeUnknownSync(
  settingsStruct({
    runID: Schema.String,
    invocationID: Schema.NullOr(Schema.String),
    /** An operator update: its undo never waits for an idle host. */
    operator: Schema.optional(Schema.Boolean),
  }),
);

const decodeAlertRun = Schema.decodeUnknownSync(
  Schema.Struct({ runID: Schema.String }),
);

const lastRunPath = (dataDirectory: string) =>
  join(maintenanceDirectory(dataDirectory), "last-run.json");

export const nothingToRecover = "Nothing to recover.";

/**
 * Undo a journal while the caller holds the run lock. With `gate`, every
 * step that changes live state is idle-checked immediately before it; a
 * busy check stops the undo and is returned as `busy`.
 */
async function recoverJournal(
  config: Config,
  deps: Dependencies,
  record?: (event: UndoEvent) => void,
  gate?: UndoContext["gate"],
): Promise<{ ok: boolean; message: string; busy?: Reason }> {
  const found = await Journal.read(config);

  if (found.kind === "none") {
    return { ok: true, message: nothingToRecover };
  }

  if (found.kind === "corrupt") {
    const unit = config.maintenance?.services.gateway;

    if (unit) {
      await deps.runner.run(["systemctl", "--user", "start", unit], {
        timeoutMs: bounds.start,
      });
    }

    return {
      ok: false,
      message: `Maintenance journal is unreadable, not private or names something outside the configuration; started ${unit ?? "no gateway"}. Inspect ${maintenanceDirectory(config.dataDirectory)} before the next run; see recover --accept-current journal.`,
    };
  }

  const actions: string[] = [];
  let busy: Reason | undefined;

  const done = await undoJournal(found.journal, {
    ...undoContext(config, deps),
    ...(gate && { gate }),
    record: (event) => {
      record?.(event);

      if (event.kind === "deferred") {
        busy = event.reason;
      }

      let line: string;

      switch (event.kind) {
        case "restart":
          line = `${event.service} restart ${event.ok ? "ok" : "failed"}`;
          break;
        case "deferred":
          line = `stopped before ${event.step}: host busy (${event.reason})`;
          break;
        default:
          line = `${event.component} → ${event.to} ${event.ok ? "ok" : `failed${event.reason ? ` (${event.reason})` : ""}`}`;
      }

      actions.push(line);
    },
  });

  return {
    ok: done,
    ...(busy && { busy }),
    message: done
      ? `Recovered an interrupted run: ${actions.join("; ") || "no change needed"}.`
      : busy
        ? `Recovery paused at an idle check; the journal is kept for the next idle boundary: ${actions.join("; ")}.`
        : `Recovery incomplete; the journal is kept: ${actions.join("; ")}. See recover --accept-current <entry>.`,
  };
}

/**
 * Leftover-journal recovery at an idle boundary: the run's first step and
 * the maintenance droid's recover use this one path. The caller holds the
 * run lock. A stopped gateway that the journal names is started first
 * (that interrupts nothing). Then the host must be idle (`idle`), and
 * `gate` checks again immediately before every step of the undo that
 * changes live state, so work that arrives during a long undo stops it
 * before the next restart. A corrupt journal is never undone: recovery only
 * starts the gateway.
 */
async function recoverAtIdle(
  config: Config,
  deps: Dependencies,
  input: {
    /** The check before any undo, at the scope that this journal needs. */
    idle: (scope: IdleScope) => Promise<IdleResult>;
    gate: (step: UndoStep) => Promise<IdleResult>;
    record?: (event: UndoEvent) => void;
    onGatewayStart?: (started: boolean) => void;
  },
): Promise<
  | { kind: "none" }
  | { kind: "busy"; reason: Reason; message: string }
  | { kind: "done"; ok: boolean; message: string }
> {
  const found = await Journal.read(config);

  if (found.kind === "none") {
    return { kind: "none" };
  }

  if (found.kind === "ok") {
    const started = await startStoppedGateway(config, deps, found.journal);

    if (started !== undefined) {
      input.onGatewayStart?.(started);
    }

    const idle = await input.idle(journalScope(found.journal));

    if (!idle.idle) {
      return {
        kind: "busy",
        reason: idle.reason,
        message: `The host is busy (${idle.reason}); nothing was undone.`,
      };
    }
  }

  const result = await recoverJournal(config, deps, input.record, input.gate);

  return result.busy
    ? { kind: "busy", reason: result.busy, message: result.message }
    : { kind: "done", ok: result.ok, message: result.message };
}

/**
 * The maintenance droid's recover: the run's leftover recovery
 * (`recoverAtIdle`) under the run lock, taken first, with a single idle
 * check instead of a wait. Busy: nothing more is undone and the journal
 * waits for the next idle boundary.
 */
export async function recoverWhenIdle(
  config: Config,
  deps: Dependencies,
  signal: AbortSignal,
): Promise<{ ok: boolean; message: string; busy?: Reason }> {
  await mkdir(maintenanceDirectory(config.dataDirectory), {
    recursive: true,
    mode: 0o700,
  });
  let held: Database;

  try {
    held = lock(config.dataDirectory);
  } catch {
    return {
      ok: false,
      message: "A maintenance run holds the lock; nothing was changed.",
    };
  }

  try {
    const result = await recoverAtIdle(config, deps, {
      idle: (scope) => idleNow(config, deps, signal, scope),
      gate: (step) => idleNow(config, deps, signal, undoStepScope(step)),
    });

    if (result.kind === "none") {
      return { ok: true, message: nothingToRecover };
    }

    if (result.kind === "busy") {
      return { ok: false, busy: result.reason, message: result.message };
    }

    return { ok: result.ok, message: result.message };
  } finally {
    held.close();
  }
}

/**
 * A journal that holds `gateway` with the unit not running: start it.
 * Starting a stopped gateway interrupts nothing, and only a running gateway
 * advances its cron schedules, so the idle gate can pass. `undefined`: no
 * start was needed.
 */
async function startStoppedGateway(
  config: Config,
  deps: Dependencies,
  journal: Journal,
) {
  const unit = config.maintenance?.services.gateway;

  if (!unit || !journal.get("gateway")) {
    return;
  }

  if (await unitRunning(deps.runner, unit)) {
    return;
  }

  const since = deps.clock.now();

  const result = await deps.runner.run(["systemctl", "--user", "start", unit], {
    timeoutMs: bounds.start,
  });

  // Ready means it runs its cron loop, which the idle gate relies on.
  const never = new AbortController().signal;

  return (
    result.code === 0 &&
    (await waitReady(
      config.dataDirectory,
      since,
      undefined,
      bounds.ready,
      (ms) => deps.clock.sleep(ms, never),
      () => deps.clock.now(),
    ))
  );
}

/**
 * Whether the gateway advances its cron schedules (idle gate): a ready
 * record whose process is alive, which a crash-looping unit never has, and a
 * unit that is not `inactive` or `failed` (guards a reused PID). Any other
 * unit state, including an unknown one, counts as running.
 */
async function gatewayServing(config: Config, runner: CommandRunner) {
  const unit = config.maintenance?.services.gateway;
  const ready = await readReady(config.dataDirectory);

  if (!unit || !ready || !readyProcessAlive(ready)) {
    return false;
  }

  const state = (
    await runner.run(["systemctl", "--user", "is-active", unit], {
      timeoutMs: 15_000,
    })
  ).stdout.trim();

  return state !== "inactive" && state !== "failed";
}

/**
 * The gateway unit may serve Slack and cron: anything but `inactive` or
 * `failed`, including an unknown state (busy-safe).
 */
async function ingressMayBeOpen(config: Config, runner: CommandRunner) {
  const unit = config.maintenance?.services.gateway ?? "stargate.service";

  try {
    const state = (
      await runner.run(["systemctl", "--user", "is-active", unit], {
        timeoutMs: 15_000,
      })
    ).stdout.trim();

    return state !== "inactive" && state !== "failed";
  } catch {
    return true;
  }
}

/**
 * One read-only idle check at `stargate` scope, as the run's gates make it,
 * without waiting. For callers outside a run (the maintenance droid).
 */
export async function idleNow(
  config: Config,
  deps: Dependencies,
  signal: AbortSignal,
  scope: IdleScope = "stargate",
): Promise<IdleResult> {
  let crews: Crew[];

  try {
    crews = await discoverCrews(config);
  } catch {
    return { idle: false, reason: "idle-unknown" };
  }

  return checkIdle({
    dataDirectory: config.dataDirectory,
    crews,
    pinnedSessions: pinnedSessionIDs(config),
    cronHorizonMs:
      (config.maintenance?.idle.cronHorizonMinutes ??
        defaultCronHorizonMinutes) * 60_000,
    now: deps.clock.now(),
    scope,
    connect: deps.connect,
    signal,
    gatewayRunning: () => gatewayServing(config, deps.runner),
  });
}

/** `recover --after-run`: the caller holds the run lock. */
async function afterRun(
  config: Config,
  deps: Dependencies,
  found: Awaited<ReturnType<typeof Journal.read>>,
): Promise<{ ok: boolean; message: string }> {
  if (found.kind !== "ok") {
    return recoverJournal(config, deps);
  }

  const invocation = deps.env["INVOCATION_ID"];

  const last = await readOptional(lastRunPath(config.dataDirectory))
    .then((text) => decodeLastRun(JSON.parse(text ?? "")))
    .catch(() => {});

  if (
    !invocation ||
    last?.invocationID !== invocation ||
    last.runID !== found.journal.runID
  ) {
    const started = await startStoppedGateway(config, deps, found.journal);

    return {
      ok: started !== false,
      message: `The journal is not this run's; it waits for the next run's idle gate.${
        started === undefined
          ? ""
          : started
            ? " Started the stopped gateway."
            : " The stopped gateway did not become ready."
      }`,
    };
  }

  // This run's own journal: undo with Slack ingress still stopped; the
  // Gateway is started last. If the run had already started the gateway
  // Again, ingress is open: the undo rechecks idle before each step,
  // Like leftover recovery, and a busy check keeps the journal. An
  // Operator update never waits: the operator accepted the interruption,
  // And a busy host must not keep the new release switched in.
  if (!last.operator && (await ingressMayBeOpen(config, deps.runner))) {
    const check = (step: UndoStep) =>
      idleNow(config, deps, AbortSignal.timeout(60_000), undoStepScope(step));

    const result = await recoverJournal(config, deps, undefined, check);

    return { ok: result.ok, message: result.message };
  }

  return recoverJournal(config, deps);
}

/**
 * Finish an interrupted run. Takes the run lock (busy: fails). Only a
 * missing journal means "nothing to do"; an unusable journal starts the
 * configured gateway and fails. `afterRun` (the timer's ExecStopPost) only
 * finishes the journal of the run that just ended in this systemd
 * invocation, which held the idle gate; any other journal waits for the next
 * run's idle gate, and only a stopped gateway is started.
 */
export async function recoverInterruptedRun(
  config: Config,
  overrides: Partial<Dependencies> = {},
  options: { afterRun?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  const deps = { ...defaultDependencies, ...overrides };
  await mkdir(maintenanceDirectory(config.dataDirectory), {
    recursive: true,
    mode: 0o700,
  });
  let held: Database;

  try {
    held = lock(config.dataDirectory);
  } catch {
    return {
      ok: false,
      message: "A maintenance run holds the lock; nothing was changed.",
    };
  }

  try {
    const found = await Journal.read(config);

    if (!options.afterRun) {
      return await recoverJournal(config, deps);
    }

    const result = await afterRun(config, deps, found);
    // A run that was killed wrote no alert. Never leave a journal silently.
    const left = await Journal.read(config);

    if (left.kind !== "none") {
      const runID = left.kind === "ok" ? left.journal.runID : "unknown";

      const known = await readOptional(
        join(maintenanceDirectory(config.dataDirectory), "ALERT.json"),
      )
        .then((text) => decodeAlertRun(JSON.parse(text ?? "")))
        .catch(() => {});

      if (known?.runID !== runID) {
        await writeAlert(config.dataDirectory, {
          runID,
          at: new Date(deps.clock.now()).toISOString(),
          outcome: "failed",
          reason: "recovery-required",
          report: null,
          journal: true,
        }).catch(() => {});
      }
    }

    return result;
  } finally {
    held.close();
  }
}

export async function runMaintenance(
  input: RunInput,
  deps: Dependencies = defaultDependencies,
): Promise<RunResult> {
  const { config, mode, signal } = input;
  const m = config.maintenance;

  if (!m) {
    throw new Error("No maintenance section in configuration.");
  }

  const update = input.update;

  if (mode === "run" && !m.enabled && !update) {
    throw new Error(
      "Maintenance is disabled. Set maintenance.enabled to true.",
    );
  }

  if (update) {
    if (!m.stargate) {
      throw new UpdateRefused(
        "maintenance.stargate is required for an update.",
      );
    }

    if (normalizeVersion(update.version) !== update.version) {
      throw new UpdateRefused("Use a MAJOR.MINOR.PATCH version.");
    }
  }

  const { clock } = deps;
  const installID = m.installID ?? defaultInstallID(resolve(input.configPath));
  const jitter = stableJitter(installID, m.window.jitterMinutes);
  const startedAt = clock.now();
  let current = currentWindow(startedAt, m.window, jitter);

  if (update) {
    current = {
      date: new Date(startedAt).toISOString().slice(0, 10),
      opens: startedAt,
      start: startedAt,
      deadline: startedAt + updateWindowMs - updateReserveMs,
      closes: startedAt + updateWindowMs,
    };
  }

  if (!current && mode === "run") {
    if (!input.outsideWindow) {
      throw new Error("Outside the maintenance window. Nothing was changed.");
    }

    const length = windowMinutes(m.window) * 60_000;
    current = {
      date: new Date(startedAt).toISOString().slice(0, 10),
      opens: startedAt,
      start: startedAt,
      deadline: startedAt + length - m.window.reserveMinutes * 60_000,
      closes: startedAt + length,
    };
  }

  const window = current ?? nextWindow(startedAt, m.window, jitter);
  await mkdir(maintenanceDirectory(config.dataDirectory), {
    recursive: true,
    mode: 0o700,
  });
  const held = mode === "run" ? lock(config.dataDirectory) : undefined;
  const runID = deps.uuid();
  const rec = new ReportRecorder(clock);
  const remaining = () => window.deadline - clock.now();
  const toClose = () => window.closes - clock.now();
  let attention = false;
  let cleanup: CleanupResult | undefined;
  let drain: Report["drain"];
  const drainDirectory = deps.drainDirectory ?? maintenanceDrainDirectory();

  const finish = async (
    result: Report["outcome"],
    reason: Reason | undefined,
    checkpoint = false,
  ): Promise<RunResult> => {
    if (
      drain &&
      !checkpoint &&
      ["draining", "restarting"].includes(drain.state.phase)
    ) {
      const completed =
        !["failed", "deferred"].includes(result) &&
        rec.restarts.some(
          (item) => item.service === "gateway" && item.status === "ok",
        );

      drain.state = {
        ...drain.state,
        phase: completed ? "completed" : "aborted",
      };

      if (!completed && drain.outcome !== "deadline") {
        drain.outcome = "aborted";
      }

      await writeMaintenanceDrain(drain.state, drainDirectory).catch(() => {
        attention = true;
      });

      try {
        const control = await deps.connect();
        drain.notices.push(
          ...((await control.maintenanceNotice?.(
            drain.state,
            AbortSignal.timeout(10_000),
          )) ?? []),
        );
        drain.notices = drain.notices.slice(0, 1000);
      } catch {
        attention = true;
      }
    }

    const ready = await readReady(config.dataDirectory);

    const report: Report = {
      schema: reportSchemaID,
      runID,
      installID,
      mode,
      outcome: result,
      ...(reason && { reason }),
      window: windowReport(window, m.window, jitter),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(clock.now()).toISOString(),
      components: rec.components,
      ...(cleanup && { cleanup }),
      ...(drain && { drain }),
      models: rec.models,
      ...(ready &&
        ready.readyAt >= startedAt &&
        ready.updateNotices && { updateNotices: ready.updateNotices }),
      steps: rec.steps,
      rollbacks: rec.rollbacks,
      restarts: rec.restarts,
      ...(rec.notes.length > 0 && { notes: rec.notes }),
    };

    if (mode === "plan") {
      return { report, attention: false };
    }

    // Writing the report must never hide the outcome.
    let written: Awaited<ReturnType<typeof writeReport>> | undefined;

    try {
      written = await writeReport(config.dataDirectory, report);
    } catch {
      attention = true;
    }

    if (checkpoint) {
      return {
        report: written?.report ?? report,
        ...(written && { reportPath: written.path }),
        attention,
      };
    }

    if (attention || result === "failed") {
      await writeAlert(config.dataDirectory, {
        runID,
        at: new Date(clock.now()).toISOString(),
        outcome: result,
        ...(reason && { reason }),
        report: written?.name ?? null,
        journal: (await Journal.read(config)).kind !== "none",
      }).catch(() => {});
    }

    const notify = m.report;

    const needsLook =
      rec.components.some((c) => c.reason !== undefined) ||
      Boolean(cleanup?.items.length);

    if (written && notify && (result !== "no-op" || needsLook)) {
      const bot = config.bots.find((b) => b.id === notify.bot);

      if (bot && isAllowedChannel(bot, notify.channel)) {
        await queueNotice(config.dataDirectory, {
          schema: noticeSchemaID,
          channel: notify.channel,
          text: summary(written.report, written.name),
          report: written.name,
        }).catch(() => {});
      }
    }

    return {
      report: written?.report ?? report,
      ...(written && { reportPath: written.path }),
      attention,
    };
  };

  try {
    const componentsOf = function (entry: JournalEntry): string[] {
      if (entry === "clis") {
        return (journal.get("clis")?.packages ?? agentUpdates).map(
          (p) => `npm:${p.name}`,
        );
      }

      if (entry === "release") {
        return ["stargate"];
      }

      if (entry === "cliproxyapi") {
        return ["cliproxyapi"];
      }

      return ["models"];
    };

    const gate = async function (name: string) {
      // The operator accepted the interruption.
      if (update || drain) {
        return;
      }

      if (crewsUnknown) {
        throw new Defer("idle-unknown");
      }

      const result = await checkIdle({
        ...idleInput(gateScope),
        now: clock.now(),
      });

      rec.step(
        name,
        result.idle ? "ok" : "skipped",
        result.idle ? undefined : result.reason,
      );

      if (!result.idle) {
        throw new Defer(result.reason);
      }
    };

    const idleInput = function (scope: IdleScope = "stargate") {
      return {
        dataDirectory: config.dataDirectory,
        crews,
        pinnedSessions: sessionList
          .filter((s) => s.scope === "captain-session")
          .map((s) => s.id),
        cronHorizonMs:
          (m?.idle.cronHorizonMinutes ?? defaultCronHorizonMinutes) * 60_000,
        scope,
        connect: deps.connect,
        signal,
        gatewayRunning: () => gatewayServing(config, deps.runner),
      };
    };

    const apply = async function () {
      if (m === undefined) {
        return;
      }

      // Crew profiles that cannot be read: the plugin check cannot run.
      if (crewsUnknown) {
        throw new Defer("idle-unknown");
      }

      if (m.drain.enabled) {
        const startedAt = clock.now();

        const state: MaintenanceDrain = {
          schema: "stargate.maintenance.drain.v1",
          runID,
          pid: process.pid,
          job: update
            ? "operator-update"
            : input.outsideWindow
              ? "outside-window"
              : "nightly",
          services: [
            "gateway",
            ...(!gatewayOnly &&
            (agentUpdates.length > 0 ||
              staged ||
              work?.files.length ||
              inputs?.globalCatalog)
              ? ["opencode" as const]
              : []),
            ...(proxyDigest ? ["cliproxyapi" as const] : []),
          ],
          startedAt,
          deadlineAt: Math.min(
            startedAt + m.drain.deadlineMinutes * 60_000,
            window.deadline,
          ),
          phase: "draining",
        };

        await claimMaintenanceDrain(state, drainDirectory);
        drain = { state, outcome: "aborted", notices: [] };

        const local = () => ({
          ...idleInput(),
          pinnedSessions: [
            ...new Set([
              ...idleInput().pinnedSessions,
              ...(drain?.notices.map((receipt) => receipt.sessionID) ?? []),
            ]),
          ],
          draining: true,
          now: clock.now(),
        });

        const targets = () => [
          ...new Map([
            ...readDrainParticipants(drainDirectory).map(
              (participant) =>
                [
                  participant.dataDirectory,
                  {
                    ...local(),
                    dataDirectory: participant.dataDirectory,
                    crews: participant.crews,
                    pinnedSessions: participant.pinnedSessions,
                    drainUnknown: participant.unknown === true,
                  },
                ] as const,
            ),
            [config.dataDirectory, local()] as const,
          ]).values(),
        ];

        let noticesConfirmed = false;

        try {
          const control = await deps.connect();
          drain.notices = (
            (await control.maintenanceNotice?.(
              state,
              AbortSignal.any([
                signal,
                AbortSignal.timeout(
                  Math.max(1, Math.min(10_000, state.deadlineAt - clock.now())),
                ),
              ]),
            )) ?? []
          ).slice(0, 1000);
          noticesConfirmed =
            control.maintenanceNotice !== undefined &&
            !drain.notices.some((receipt) => receipt.status === "uncertain");
        } catch {
          rec.step("drain-notice", "failed", "health-failed");
        }

        const result = await waitForMaintenanceDrain({
          deadlineAt: state.deadlineAt,
          pollMs: m.idle.pollSeconds * 1000,
          clock,
          signal,
          targets,
          announced: () =>
            noticesConfirmed &&
            readDrainParticipants(drainDirectory).every(
              (participant) =>
                participant.noticeRunID === runID &&
                participant.noticePhase === "draining" &&
                participant.noticeStatus === "queued",
            ),
          describe: async () =>
            (
              await Promise.all(
                targets().map((target) => describeRunningWork(target)),
              )
            )
              .flat()
              .slice(0, 1000),
        });

        drain.outcome = result.outcome;
        drain.state = {
          ...state,
          phase: "restarting",
          stragglers: result.stragglers,
        };
        await writeMaintenanceDrain(drain.state, drainDirectory);
        rec.step(
          result.outcome === "idle" ? "drain-idle" : "drain-deadline",
          "ok",
        );
      } else if (!update) {
        // Gate 1: wait for idle, at most until the deadline.
        const idle = await waitForIdle(
          idleInput(gateScope),
          window.deadline,
          m.idle.pollSeconds * 1000,
          clock,
        );

        rec.step(
          "idle-gate",
          idle.idle ? "ok" : "skipped",
          idle.idle ? undefined : idle.reason,
        );

        if (!idle.idle) {
          throw new Defer(idle.reason);
        }
      }

      if (remaining() <= 0) {
        throw new Defer("deadline");
      }

      // Agent CLIs: the long install happens before the final gates.
      let cliChanged = false;

      if (agentUpdates.length > 0 && m.agentClis) {
        const settings = m.agentClis;

        const cutoff = new Date(
          clock.now() - settings.coolOffHours * 3_600_000,
        ).toISOString();

        await journal.set("clis", {
          packages: agentUpdates.map((plan) => ({
            name: plan.name,
            before: plan.before ?? "",
            cutoff: restoreCutoff(plan, state.npm[plan.name]),
          })),
        });
        let ok = false;

        try {
          await agentCliInstall(
            settings,
            agentUpdates.map((p) => ({
              name: p.name,
              version: p.candidate ?? "",
            })),
            cutoff,
            run,
            Math.max(1000, Math.min(900_000, remaining())),
          );
          ok = await verifyAll(agentUpdates, (p) => p.candidate);
        } catch {
          signal.throwIfAborted();
        }

        if (ok) {
          cliChanged = true;

          for (const plan of agentUpdates) {
            rec.update(`npm:${plan.name}`, { after: plan.candidate, cutoff });
          }

          rec.step("agent-clis", "ok");
        } else {
          rec.step("agent-clis", "failed", "health-failed");
          const restored = await undoJournal(journal, ctx, ["clis"]);

          for (const plan of agentUpdates) {
            rec.update(`npm:${plan.name}`, {
              status: restored ? "rolled-back" : "failed",
              reason: "health-failed",
              after: restored ? plan.before : null,
            });
          }

          if (!restored) {
            throw new StepError("install-failed");
          }
        }

        // Committed after OpenCode restarts with the new binaries.
        if (ok) {
          const committed = async () => {
            await updateState(config.dataDirectory, (s) => {
              for (const plan of agentUpdates) {
                if (plan.candidate) {
                  s.npm[plan.name] = {
                    version: plan.candidate,
                    before: cutoff,
                  };
                }
              }
            });

            for (const plan of agentUpdates) {
              rec.update(`npm:${plan.name}`, { status: "updated" });
            }
          };

          commitClis = committed;
        }
      }

      signal.throwIfAborted();

      const restartNeeded =
        !gatewayOnly &&
        (cliChanged ||
          !!staged ||
          !!work?.files.length ||
          !!inputs?.globalCatalog);

      const needed = applyBudgetMs({
        proxy: !!proxyDigest,
        restart: restartNeeded,
        release: !!staged,
        live: !!(
          (work?.sessions.length ?? 0) > 0 ||
          (work?.agents.length ?? 0) > 0 ||
          inputs?.globalCatalog
        ),
      });

      if (toClose() < needed) {
        throw new Defer("deadline");
      }

      // Gate 2 right before the stop; gate 3 after it (work cannot arrive).
      await gate("idle-before-stop");
      const gatewayUnit = m.services.gateway;

      if (await unitRunning(run, gatewayUnit)) {
        await journal.set("gateway", { restartPending: false });

        const stopped = await run.run(
          ["systemctl", "--user", "stop", gatewayUnit],
          {
            timeoutMs: bounds.stop,
          },
        );

        if (stopped.code !== 0) {
          rec.step("gateway-stop", "failed", "restart-failed");
          throw new StepError("restart-failed");
        }

        rec.step("gateway-stop", "ok");
      }

      await gate("idle-after-stop");

      // CLIProxyAPI: gate immediately before its restart.
      if (proxy && proxyDigest && m.cliproxyapi && m.proxy) {
        await gate("idle-before-proxy");
        await journal.set("cliproxyapi", { previousVersion: proxy.before });

        if (
          await switchProxy(m, proxy.candidate.version, run, deps, rec, signal)
        ) {
          await journal.clear("cliproxyapi");
          const digest = proxyDigest;
          await updateState(config.dataDirectory, (s) => {
            s.cliproxyapi[proxy.candidate.version] = digest;
          });
          rec.update("cliproxyapi", {
            status: "updated",
            after: proxy.candidate.version,
          });

          // Models chosen through the old proxy must still answer.
          if (inputs?.globalCatalog && m.models) {
            const selected = await selectModelUpgrades({
              inputs,
              settings: m.models,
              proxy: m.proxy,
              crews,
              probe: true,
              connect: deps.connect,
              signal,
            });

            work = buildModelWork(inputs, selected.upgrades);
            rec.models.push(...selected.rejected);
            rec.replanModels(work.changes);
            rec.update("models", {
              status:
                work.files.length > 0 || work.sessions.length > 0
                  ? "planned"
                  : "unchanged",
              candidate: [...work.upgrades.values()].join(",") || null,
            });
          } else if (
            work &&
            inputs &&
            work.upgrades.size > 0 &&
            m.proxy !== undefined
          ) {
            const kept = new Map<string, string>();

            for (const [from, to] of work.upgrades) {
              if (await probeModel(m.proxy, to, signal)) {
                kept.set(from, to);
              } else {
                rec.models.push({
                  scope: "catalog",
                  target: "proxy-probe-after-update",
                  from,
                  to,
                  status: "skipped",
                  reason: "probe-failed",
                });
              }
            }

            if (kept.size !== work.upgrades.size) {
              work = buildModelWork(inputs, kept);
              rec.replanModels(work.changes);

              if (kept.size === 0) {
                rec.update("models", {
                  status: "skipped",
                  reason: "probe-failed",
                });
              }
            }
          }
        } else {
          const restored = await undoJournal(journal, ctx, ["cliproxyapi"]);
          rec.update("cliproxyapi", {
            status: restored ? "rolled-back" : "failed",
            reason: "health-failed",
            after: restored ? proxy.before : null,
          });

          // Unknown proxy state: no release or model change tonight.
          if (!restored) {
            throw new StepError("health-failed");
          }
        }
      }

      signal.throwIfAborted();

      // OpenCode: gate, then switch, write and restart without delay.
      let control: OpenCodeControl | undefined;
      const files = work?.files.length ? work : undefined;

      if (gatewayOnly) {
        // The gateway is stopped: the switch interrupts nothing. OpenCode
        // Keeps the plugin that it has loaded, which this release also has.
        await switchRelease();
      } else if (cliChanged || staged || files) {
        await gate("idle-before-opencode");
        await switchRelease();

        if (files) {
          const backup = backupDirectory(config.dataDirectory, runID);
          await journal.set("files", {});

          try {
            const changes = new FileChanges(backup);

            for (const file of files.files) {
              await changes.write(file.path, file.text, file.expected);
            }

            for (const link of files.profileLinks) {
              await changes.link(link.path, link.target);
            }

            rec.step("model-configs", "ok");
          } catch (error) {
            signal.throwIfAborted();
            const reason = reasonOf(error);
            const restored = await undoJournal(journal, ctx, ["files"]);
            rec.step("model-configs", "failed", reason);
            rec.markModels(restored ? "rolled-back" : "failed", reason);
            rec.update("models", {
              status: restored ? "rolled-back" : "failed",
              reason,
            });
            work = undefined;
          }
        }

        await journal.set("openCode", {
          restarted: true,
          restartPending: false,
        });
        control = await restartOpenCode(m, crews, run, deps, rec, signal);
        // Undo suspects one at a time, newest risk first, restarting after each.
        const suspects: JournalEntry[] = ["release", "files", "clis"];

        while (!control) {
          const entry = suspects.find(
            (item) => journal.get(item) !== undefined,
          );

          if (!entry) {
            throw new StepError("plugins-failed");
          }

          suspects.splice(suspects.indexOf(entry), 1);

          if (entry === "release" && staged) {
            await markFailedRelease(staged, "plugins-failed");
          }

          const restored = await undoJournal(journal, ctx, [entry]);

          for (const id of componentsOf(entry)) {
            rec.update(id, {
              status: restored ? "rolled-back" : "failed",
              reason: "plugins-failed",
            });
          }

          if (entry === "files") {
            rec.markModels(
              restored ? "rolled-back" : "failed",
              "plugins-failed",
            );
            work = undefined;
          }

          if (entry === "clis") {
            commitClis = undefined;
          }

          if (!restored) {
            throw new StepError("plugins-failed");
          }

          control = await restartOpenCode(m, crews, run, deps, rec, signal);
        }

        // This restart paid any restart an undo above made necessary.
        await journal.set("openCode", {
          restarted: true,
          restartPending: false,
        });

        // OpenCode now runs the plugin of `current` again.
        if (state.openCodeRelease !== null) {
          await updateState(config.dataDirectory, (s) => {
            s.openCodeRelease = null;
          });
        }

        signal.throwIfAborted();

        if (journal.get("clis")) {
          await journal.clear("clis");
          await commitClis?.();
        }
      }

      signal.throwIfAborted();

      // Live captain/crew sessions and the selected profile's new agents.
      if (
        work &&
        (work.sessions.length > 0 ||
          work.agents.length > 0 ||
          journal.get("files"))
      ) {
        control ??= await deps.connect();

        const live = await applyLiveModels(work, control, journal, signal, {
          now: () => clock.now(),
          until: clock.now() + bounds.sessions,
        });

        // Out of session time: unswitched sessions stay valid and are reported.
        for (const session of live.skipped) {
          const change = rec.models.find(
            (item) => item.target === session.id && item.status === "planned",
          );

          if (change) {
            Object.assign(change, { status: "skipped", reason: "deadline" });
          }
        }

        if (live.ok) {
          await journal.clear("sessions");
          await journal.clear("files");
          rec.step("model-sessions", "ok");
          rec.markModels("applied");
          rec.update("models", {
            status: "updated",
            after: [...work.upgrades.values()].join(","),
          });
        } else {
          signal.throwIfAborted();
          rec.step("model-sessions", "failed", "session-switch-failed");

          const restored = await undoJournal(journal, ctx, [
            "sessions",
            "files",
            "openCode",
          ]);

          rec.markModels(
            restored ? "rolled-back" : "failed",
            "session-switch-failed",
          );
          rec.update("models", {
            status: restored ? "rolled-back" : "failed",
            reason: "session-switch-failed",
          });

          if (!restored) {
            throw new StepError("session-switch-failed");
          }
        }
      }

      signal.throwIfAborted();

      // Gateway back; readiness failure rolls the release back.
      if (journal.get("gateway")) {
        gatewayReturned = true;

        let ready = await startGateway(
          config,
          gatewayUnit,
          run,
          deps,
          rec,
          signal,
        );

        if (!ready && journal.get("release") && staged) {
          await markFailedRelease(staged, "readiness-failed");
          // The gateway is back: idle-gated, like leftover recovery, unless
          // The operator accepted the interruption.
          const afterReturn = update ? ctx : afterIngress;

          const restored = await undoJournal(journal, afterReturn, [
            "release",
            "openCode",
          ]);

          const linkRestored = journal.get("release") === undefined;
          rec.update("stargate", {
            status: linkRestored ? "rolled-back" : "failed",
            reason: "readiness-failed",
            after: linkRestored ? (stargate?.before ?? null) : null,
          });

          const idle = restored
            ? await afterReturn.gate?.("gateway")
            : undefined;

          if (idle && !idle.idle) {
            rec.step("recover-before-gateway", "skipped", idle.reason);
          } else if (restored) {
            ready = await startGateway(
              config,
              gatewayUnit,
              run,
              deps,
              rec,
              signal,
            );
          }
        }

        // Kept in the journal: recover keeps trying and the run fails loudly.
        if (!ready) {
          throw new StepError("readiness-failed");
        }
      }

      // The release is committed before the gateway entry goes: a kill in
      // Between leaves only `gateway`, which a ready gateway satisfies. The
      // Other order would leave `release`, and recovery would undo a verified
      // Release without restarting the gateway that runs it.
      if (journal.get("release") && staged && m.stargate) {
        // After a gateway-only update OpenCode still runs the plugin from
        // An earlier release directory. Record it before the switch is
        // Final, so that no later run removes that directory.
        const loaded = gatewayOnly
          ? (state.openCodeRelease ?? switchedFrom ?? null)
          : null;

        if (gatewayOnly && loaded !== state.openCodeRelease) {
          await updateState(config.dataDirectory, (s) => {
            s.openCodeRelease = loaded;
          });
        }

        await journal.clear("release");

        // A retried release that is ready is no longer known-bad.
        if (update?.retryFailed && state.failedReleases[staged]) {
          await updateState(config.dataDirectory, (s) => {
            s.failedReleases = Object.fromEntries(
              Object.entries(s.failedReleases).filter(
                ([version]) => version !== staged,
              ),
            );
          });
        }

        rec.update("stargate", { status: "updated", after: staged });
        await pruneReleases(m.stargate.root, m.stargate.keep, [
          ...(loaded ? [loaded] : []),
          // Recovery can still need this code until the journal is empty.
          ...(update?.runnerRelease ? [update.runnerRelease] : []),
        ]).catch(() => []);
      }

      await journal.clear("gateway");
      await journal.clear("openCode");
    };

    const switchRelease = async function () {
      if (!staged || !m?.stargate) {
        return;
      }

      const before = await linkedRelease(m.stargate.root, "current");

      if (!before) {
        throw new StepError("switch-failed");
      }

      await journal.set("release", { previous: before.name, version: staged });
      await switchCurrent(m.stargate.root, staged);
      switchedFrom = before.name;
      rec.step("stargate-switch", "ok");
    };

    const verifyAll = async function (
      plans: AgentPlan[],
      version: (plan: AgentPlan) => string | null,
    ) {
      if (!m?.agentClis) {
        return false;
      }

      for (const plan of plans) {
        const expected = version(plan);

        if (
          !expected ||
          !(await agentCliVerify(m.agentClis, plan, expected, run))
        ) {
          return false;
        }
      }

      return true;
    };

    const markFailedRelease = async function (version: string, reason: Reason) {
      await updateState(config.dataDirectory, (s) => {
        s.failedReleases[version] = {
          reason,
          at: new Date(clock.now()).toISOString(),
        };
      }).catch(() => {});
    };

    // An update never undoes an earlier run: the operator runs recover.
    if (update && (await Journal.read(config)).kind !== "none") {
      throw new UpdateRefused(
        "A maintenance journal is left over. Run `stargate maintenance recover` first. Nothing was changed.",
      );
    }

    // Names the kind of run in the report and its summary.
    if (update) {
      rec.step("operator-update", "ok");
    }

    // First, before anything can fail: `recover --after-run` finishes only
    // The journal of the run that this systemd invocation started.
    if (mode === "run") {
      await atomicWrite(
        lastRunPath(config.dataDirectory),
        `${JSON.stringify({
          runID,
          invocationID: deps.env["INVOCATION_ID"] ?? null,
          ...(update && { operator: true }),
        })}\n`,
        0o600,
      );
    }

    // ---- Discovery: read-only ------------------------------------------
    let crews: Crew[] = [];
    let crewsUnknown = false;

    try {
      crews = await discoverCrews(config, m.drain.enabled);
    } catch {
      crewsUnknown = true;
    }

    const sessionList = sessions(config, crews);
    // Named in every report: queued assignments wait for their captain.
    rec.notes = queuedCrewTasks(crews).map((task) => ({
      kind: "queued-crew-task" as const,
      ...task,
      action: queuedTaskAction(task),
    }));

    // A journal left by an interrupted run is finished first, never
    // Replaced, and only at an idle boundary: undo restarts services too.
    if (mode === "run" && !update) {
      const unknown = { idle: false, reason: "idle-unknown" } as const;

      const leftover = await recoverAtIdle(config, deps, {
        idle: async (scope) =>
          crewsUnknown
            ? unknown
            : waitForIdle(
                idleInput(scope),
                window.deadline,
                m.idle.pollSeconds * 1000,
                clock,
              ),
        gate: async (step) =>
          crewsUnknown
            ? unknown
            : checkIdle({
                ...idleInput(undoStepScope(step)),
                now: clock.now(),
              }),
        record: recordUndo(rec),
        onGatewayStart: (started) => {
          rec.step(
            "start-stopped-gateway",
            started ? "ok" : "failed",
            started ? undefined : "readiness-failed",
          );
        },
      });

      if (leftover.kind === "busy") {
        rec.step("recover-previous-run", "skipped", leftover.reason);
        attention = true;

        return await finish("deferred", leftover.reason);
      }

      if (leftover.kind === "done") {
        rec.step(
          "recover-previous-run",
          leftover.ok ? "ok" : "failed",
          leftover.ok ? undefined : "recovery-required",
        );

        if (!leftover.ok) {
          attention = true;

          return await finish("failed", "recovery-required");
        }
      }
    }

    if (m.cleanup?.enabled && !update) {
      if (crewsUnknown) {
        rec.component({
          id: "cleanup",
          before: null,
          after: null,
          candidate: null,
          status: "deferred",
          reason: "idle-unknown",
        });
      } else {
        const idle =
          mode === "plan"
            ? ({ idle: true } as const)
            : await waitForIdle(
                idleInput(),
                window.deadline,
                m.idle.pollSeconds * 1000,
                clock,
              );

        if (!idle.idle) {
          rec.component({
            id: "cleanup",
            before: null,
            after: null,
            candidate: null,
            status: "deferred",
            reason: idle.reason,
          });
        } else {
          cleanup = { items: [], freedBytes: 0, plannedBytes: 0 };
          cleanup = await (deps.cleanup ?? runCleanup)({
            settings: m.cleanup,
            plan: mode === "plan",
            runner: deps.runner,
            now: clock.now(),
            signal,
            ...(mode === "run" && { deadline: window.deadline }),
            protectedPaths: cleanupProtection(config, input.configPath, crews),
            beforeItem: async () => {
              if (remaining() <= 0) {
                throw new Defer("deadline");
              }

              const idle = await checkIdle({
                ...idleInput(),
                now: clock.now(),
              });

              if (!idle.idle) {
                throw new Defer(idle.reason);
              }
            },
            record: async (item) => {
              if (mode === "plan" || !cleanup) {
                return;
              }

              const index = cleanup.items.findIndex(
                (entry) =>
                  entry.kind === item.kind &&
                  entry.path === item.path &&
                  entry.branch === item.branch,
              );

              if (index === -1) {
                cleanup.items.push(item);
              } else {
                cleanup.items[index] = item;
              }

              cleanup.freedBytes = cleanup.items
                .filter((entry) => entry.status === "removed")
                .reduce((sum, entry) => sum + entry.size, 0);
              const checkpoint = await finish("partial", undefined, true);

              if (!checkpoint.reportPath || checkpoint.attention) {
                throw new Error("Cleanup audit unavailable");
              }
            },
          });
          const failed = cleanup.items.some((item) => item.status === "failed");
          rec.component({
            id: "cleanup",
            before: null,
            after: null,
            candidate: null,
            status: failed
              ? "failed"
              : cleanup.items.some((item) => item.status === "removed")
                ? "updated"
                : mode === "plan" &&
                    cleanup.items.some((item) => item.status === "planned")
                  ? "planned"
                  : "unchanged",
            ...(failed && { reason: "command-failed" as const }),
          });
        }
      }
    }

    const state = await readState(config.dataDirectory);

    const stargate = await discoverStargate(
      m,
      deps,
      rec,
      startedAt,
      state,
      update,
    );

    // An operator update changes the Stargate release only.
    const proxy = update ? undefined : await discoverProxy(m, rec, startedAt);

    const agentPlans =
      !update && m.components.agentClis && m.agentClis
        ? await agentCliPlan(m.agentClis, startedAt)
        : [];

    for (const plan of agentPlans) {
      rec.component({
        id: `npm:${plan.name}`,
        before: plan.before,
        after: plan.before,
        candidate: plan.candidate,
        status: needsUpdate(plan)
          ? "planned"
          : plan.candidate && plan.before
            ? "unchanged"
            : "skipped",
        ...(!(plan.candidate && plan.before) && {
          reason: "not-found" as const,
        }),
      });
    }

    let inputs: ModelInputs | undefined;
    let work: ModelWork | undefined;

    if (!update && m.components.models && m.models && m.proxy) {
      try {
        if (crewsUnknown) {
          throw new StepError("idle-unknown");
        }

        inputs = await readModelInputs({
          settings: m.models,
          crews,
          sessions: sessionList,
          connect: deps.connect,
          signal,
        });

        const selected = await selectModelUpgrades({
          inputs,
          settings: m.models,
          proxy: m.proxy,
          crews,
          probe: mode === "run",
          connect: deps.connect,
          signal,
        });

        rec.models.push(...selected.rejected);
        work = buildModelWork(inputs, selected.upgrades);
        rec.models.push(...work.changes);
        rec.component({
          id: "models",
          before: [...selected.upgrades.keys()].join(",") || null,
          after: null,
          candidate: [...selected.upgrades.values()].join(",") || null,
          status:
            work.files.length > 0 || work.sessions.length > 0
              ? "planned"
              : "unchanged",
        });
      } catch (error) {
        rec.component({
          id: "models",
          before: null,
          after: null,
          candidate: null,
          status: "failed",
          reason: reasonOf(error),
        });
      }
    }

    if (mode === "plan") {
      return await finish("planned", undefined);
    }

    if (!rec.components.some((c) => c.status === "planned")) {
      return await finish(rec.outcome(), undefined);
    }

    // Forward path: abort-aware. Undo always uses the plain runner.
    const run: CommandRunner = {
      run: (command, options) => {
        signal.throwIfAborted();

        return deps.runner.run(command, options);
      },
    };

    // ---- Prepare: nothing live changes ---------------------------------
    let staged: string | undefined;

    if (stargate && m.stargate) {
      try {
        staged = (
          await stageRelease({
            config: m.stargate,
            release: stargate.candidate,
            headers: stargate.headers,
            runner: run,
            runID,
            remaining,
            signal,
          })
        ).metadata.version;
        rec.step("stargate-stage", "ok");
      } catch (error) {
        signal.throwIfAborted();
        rec.step("stargate-stage", "failed", reasonOf(error));
        rec.update("stargate", { status: "failed", reason: reasonOf(error) });
      }
    }

    let proxyDigest: { asset: string; binary: string } | undefined;

    if (proxy && m.cliproxyapi) {
      try {
        proxyDigest = await cliProxyPrepare(
          m.cliproxyapi,
          proxy.candidate,
          join(maintenanceDirectory(config.dataDirectory), `staging-${runID}`),
          run,
          signal,
        );
        rec.update("cliproxyapi", { digest: proxyDigest.asset });
        rec.step("cliproxyapi-prepare", "ok");
      } catch (error) {
        signal.throwIfAborted();
        rec.step("cliproxyapi-prepare", "failed", reasonOf(error));
        rec.update("cliproxyapi", {
          status: "failed",
          reason: reasonOf(error),
        });
      }
    }

    // A package whose previous dependency set cannot be pinned for a
    // Rollback (no recorded cutoff, no publication time) is not updated.
    const agentUpdates = agentPlans.filter((plan) => {
      if (!needsUpdate(plan)) {
        return false;
      }

      try {
        restoreCutoff(plan, state.npm[plan.name]);

        return true;
      } catch {
        rec.update(`npm:${plan.name}`, {
          status: "skipped",
          reason: "not-found",
        });

        return false;
      }
    });

    const modelWork = () =>
      (work?.files.length ?? 0) > 0 || (work?.sessions.length ?? 0) > 0;

    if (!staged && !proxyDigest && agentUpdates.length === 0 && !modelWork()) {
      return await finish(rec.outcome(), undefined);
    }

    // A release with the crew plugin that OpenCode already runs changes the
    // Gateway only: OpenCode is not restarted and crew work can continue.
    // Any other change tonight, or an unknown plugin, takes the full path.
    const gatewayOnly =
      staged !== undefined &&
      m.stargate !== undefined &&
      !proxyDigest &&
      agentUpdates.length === 0 &&
      !modelWork() &&
      (await samePlugin(m.stargate.root, staged));

    if (gatewayOnly) {
      rec.step("crew-plugin-unchanged", "ok");
    }

    const gateScope: IdleScope = gatewayOnly ? "gateway" : "stargate";
    /** `current` before this run switched it. */
    let switchedFrom: string | undefined;

    const journal = Journal.create(config.dataDirectory, runID);
    const ctx = undoContext(config, deps, rec);
    /**
     * Set when the run starts the gateway again: Slack and cron may arrive
     * from then on (a schedule that came due while the gateway was stopped
     * starts at once). After that, every undo step that changes live state
     * rechecks idle first, as leftover recovery does; a busy check keeps the
     * journal for recover, the droid or the next run. While the gateway unit
     * is inactive or failed, nothing can arrive and the step is not gated.
     */
    let gatewayReturned = false;

    const afterIngress: UndoContext = {
      ...ctx,
      gate: async (step) => {
        if (drain) {
          return { idle: true };
        }

        if (!(await ingressMayBeOpen(config, deps.runner))) {
          return { idle: true };
        }

        if (crewsUnknown) {
          return { idle: false, reason: "idle-unknown" };
        }

        return checkIdle({
          ...idleInput(undoStepScope(step)),
          now: clock.now(),
          signal: AbortSignal.timeout(30_000),
        });
      },
    };

    // Set when an agent CLI install verified; runs after OpenCode restarts.
    let commitClis: (() => Promise<void>) | undefined;
    let endReason: Reason | undefined;
    let deferred = false;

    try {
      await apply();
    } catch (error) {
      if (error instanceof Defer) {
        deferred = true;
        endReason = error.reason;
      } else {
        endReason = signal.aborted ? "aborted" : reasonOf(error);
        rec.step("apply", "failed", endReason);
      }
    } finally {
      const entries = (
        [
          "clis",
          "cliproxyapi",
          "release",
          "files",
          "sessions",
        ] as JournalEntry[]
      )
        .values()
        .filter((entry) => journal.get(entry) !== undefined)
        .map((entry) => ({ entry, ids: componentsOf(entry) }))
        .toArray();

      if (!journal.empty && deps.undoOnExit !== false) {
        await undoJournal(
          journal,
          gatewayReturned && !update ? afterIngress : ctx,
        );
      }

      for (const { entry, ids } of entries) {
        const restored = journal.get(entry) === undefined;

        for (const id of ids) {
          rec.update(id, {
            status: !restored
              ? "failed"
              : deferred
                ? "deferred"
                : "rolled-back",
            ...(endReason && { reason: endReason }),
          });
        }

        if (entry === "files" || entry === "sessions") {
          rec.markModels(
            restored ? (deferred ? "skipped" : "rolled-back") : "failed",
            endReason,
          );
        }
      }

      for (const c of rec.components) {
        if (c.status === "planned") {
          Object.assign(c, {
            status: "deferred",
            ...(endReason && { reason: endReason }),
          });
        }
      }

      rec.markModels("skipped", endReason);

      if (!journal.empty) {
        attention = true;
      }
    }

    if (endReason === "readiness-failed" || endReason === "aborted") {
      attention = true;
    }

    return await finish(
      deferred && !rec.components.some((c) => c.status === "updated")
        ? "deferred"
        : rec.outcome(),
      endReason,
    );
  } catch (error) {
    if (error instanceof UpdateRefused) {
      throw error;
    }

    rec.step("run", "failed", signal.aborted ? "aborted" : reasonOf(error));
    attention = true;

    return await finish("failed", signal.aborted ? "aborted" : reasonOf(error));
  } finally {
    if (drain && ["draining", "restarting"].includes(drain.state.phase)) {
      await writeMaintenanceDrain(
        { ...drain.state, phase: "aborted" },
        drainDirectory,
      ).catch(() => {});
    }

    held?.close();
  }
}

/**
 * The npm cutoff for reinstalling `before`: the cutoff recorded when
 * maintenance installed it, else that version's own publication time. Never
 * "now": a fresh cutoff could pull new transitive dependencies.
 */
export function restoreCutoff(
  plan: Pick<AgentPlan, "before" | "beforePublished">,
  recorded: { version: string; before: string } | undefined,
) {
  if (recorded && recorded.version === plan.before) {
    return recorded.before;
  }

  if (plan.beforePublished) {
    return new Date(plan.beforePublished).toISOString();
  }

  throw new StepError("install-failed");
}

async function discoverStargate(
  m: Maintenance,
  deps: Dependencies,
  rec: ReportRecorder,
  now: number,
  state: Awaited<ReturnType<typeof readState>>,
  update?: RunInput["update"],
) {
  if ((!m.components.stargate && !update) || !m.stargate) {
    return;
  }

  const current = await linkedRelease(m.stargate.root, "current");
  const before = current?.metadata.version ?? null;
  const base = { id: "stargate", before, after: before };

  if (!current) {
    rec.component({
      ...base,
      candidate: null,
      status: "skipped",
      reason: "migration-required",
    });

    return;
  }

  if (m.stargate.requireTreeCheck && !m.stargate.checkout) {
    rec.component({
      ...base,
      candidate: null,
      status: "failed",
      reason: "not-configured",
    });

    return;
  }

  try {
    const headers = githubHeaders(
      await githubToken(m.stargate.tokenEnv, deps.runner, deps.env),
    );

    if (update) {
      // Same version: nothing to do. Lower: rollback is `recover`, never this.
      const order = compareVersions(update.version, current.metadata.version);

      if (order <= 0) {
        rec.component({
          ...base,
          candidate: update.version,
          status: order === 0 ? "unchanged" : "skipped",
          ...(order !== 0 && { reason: "version-mismatch" as const }),
        });

        return;
      }
    }

    const candidate = update
      ? await namedRelease(m.stargate, headers, update.version)
      : await newerRelease(m.stargate, headers, current.metadata.version, now);

    if (
      candidate &&
      state.failedReleases[candidate.version] &&
      !update?.retryFailed
    ) {
      // Known bad here: wait for a newer release.
      rec.component({
        ...base,
        candidate: candidate.version,
        status: "skipped",
        reason: "known-bad",
      });

      return;
    }

    rec.component({
      ...base,
      candidate: candidate?.version ?? null,
      status: candidate ? "planned" : "unchanged",
    });

    return candidate
      ? { candidate, headers, before: current.metadata.version }
      : undefined;
  } catch (error) {
    rec.component({
      ...base,
      candidate: null,
      status: "failed",
      reason: reasonOf(error),
    });

    return;
  }
}

async function discoverProxy(
  m: Maintenance,
  rec: ReportRecorder,
  now: number,
): Promise<{ candidate: ProxyCandidate; before: string } | undefined> {
  if (!m.components.cliproxyapi || !m.cliproxyapi) {
    return undefined;
  }

  const before = await cliProxyCurrent(m.cliproxyapi);

  if (!before) {
    rec.component({
      id: "cliproxyapi",
      before: null,
      after: null,
      candidate: null,
      status: "skipped",
      reason: "migration-required",
    });

    return undefined;
  }

  try {
    const candidate = await cliProxyCandidate(m.cliproxyapi, now);

    const newer =
      candidate !== null && compareVersions(candidate.version, before) > 0;

    rec.component({
      id: "cliproxyapi",
      before,
      after: before,
      candidate: candidate?.version ?? null,
      status: newer ? "planned" : "unchanged",
    });

    return newer && candidate !== null ? { candidate, before } : undefined;
  } catch (error) {
    rec.component({
      id: "cliproxyapi",
      before,
      after: before,
      candidate: null,
      status: "failed",
      reason: reasonOf(error),
    });

    return undefined;
  }
}

async function switchProxy(
  m: Maintenance,
  version: string,
  run: CommandRunner,
  deps: Dependencies,
  rec: ReportRecorder,
  signal: AbortSignal,
) {
  const cpa = m.cliproxyapi;
  const proxy = m.proxy;

  if (!cpa || !proxy || !existsSync(binaryPath(cpa, version))) {
    return false;
  }

  try {
    await cliProxySwitch(cpa, version);
  } catch {
    return false;
  }

  const restarted = await run.run(
    ["systemctl", "--user", "restart", cpa.unit],
    {
      timeoutMs: bounds.proxyRestart,
    },
  );

  let healthy = false;
  const until = deps.clock.now() + bounds.proxyHealth;

  while (restarted.code === 0 && !healthy) {
    healthy = await proxyModels(proxy, signal).then(
      () => true,
      () => false,
    );

    if (healthy || deps.clock.now() >= until) {
      break;
    }

    await deps.clock.sleep(3000, signal);
  }

  rec.restart("cliproxyapi", healthy);
  rec.step(
    `cliproxyapi-${version}`,
    healthy ? "ok" : "failed",
    healthy ? undefined : "health-failed",
  );

  return healthy;
}

const real = (path: string) => realpath(path).catch(() => resolve(path));

/** The configured package, or the release it resolves to, is active. */
async function pluginLoaded(
  plugins: { path: string; active: boolean }[],
  configured: string,
) {
  const expected = new Set([resolve(configured), await real(configured)]);

  for (const plugin of plugins) {
    if (
      plugin.active &&
      (expected.has(resolve(plugin.path)) ||
        expected.has(await real(plugin.path)))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * True when the staged release records the crew plugin digest that the
 * `current` release records. A missing record on either side is false.
 */
export async function samePlugin(root: string, staged: string) {
  const current = await linkedRelease(root, "current");

  if (!current) {
    return false;
  }

  const [running, next] = await Promise.all([
    readPluginDigest(current.directory),
    readPluginDigest(join(root, "releases", staged)),
  ]);

  return running !== undefined && running === next;
}

/** Restart, reconnect, and confirm every crew location loaded its Stargate plugin. */
async function restartOpenCode(
  m: Maintenance,
  crews: readonly Crew[],
  run: CommandRunner,
  deps: Dependencies,
  rec: ReportRecorder,
  signal: AbortSignal,
) {
  const result = await run.run(m.services.openCodeRestart, {
    timeoutMs: bounds.openCodeRestart,
  });

  let control: OpenCodeControl | undefined;
  const until = deps.clock.now() + bounds.openCodeVerify;

  while (result.code === 0 && !control) {
    try {
      const candidate = await deps.connect();
      let loaded = true;

      for (const crew of crews) {
        for (const root of crew.roots) {
          const plugins = await candidate.plugins(root.directory, signal);

          if (!(await pluginLoaded(plugins, root.pluginPackage))) {
            loaded = false;
          }
        }
      }

      if (loaded) {
        control = candidate;
      }
    } catch {
      signal.throwIfAborted();
    }

    if (control || deps.clock.now() >= until) {
      break;
    }

    await deps.clock.sleep(3000, signal);
  }

  rec.restart("opencode", control !== undefined);
  rec.step(
    "opencode-restart",
    control ? "ok" : "failed",
    control ? undefined : "plugins-failed",
  );

  return control;
}

/** Restart the gateway; ready means a new process of the current release. */
async function startGateway(
  config: Config,
  unit: string,
  run: CommandRunner,
  deps: Dependencies,
  rec: ReportRecorder,
  signal: AbortSignal,
) {
  const version = await currentVersion(config);
  const since = deps.clock.now();

  const result = await run.run(["systemctl", "--user", "restart", unit], {
    timeoutMs: bounds.start,
  });

  const ready =
    result.code === 0 &&
    (await waitReady(
      config.dataDirectory,
      since,
      version,
      bounds.ready,
      (ms) => deps.clock.sleep(ms, signal),
      () => deps.clock.now(),
    ));

  rec.restart("gateway", ready);
  rec.step(
    "gateway-ready",
    ready ? "ok" : "failed",
    ready ? undefined : "readiness-failed",
  );

  return ready;
}

const acceptable = Schema.Literals([...journalEntries, "journal"]);
const decodeAcceptable = Schema.decodeUnknownResult(acceptable);

/**
 * The operator's way out of an undo that cannot proceed (`external-change`)
 * or a corrupt journal: keep the current state and drop one entry, or move
 * the whole journal aside. Without `confirm`, only lists what the entry
 * covers. Takes the run lock. Never deletes the journal or a backup.
 */
export async function acceptCurrent(
  config: Config,
  entry: string,
  confirm: boolean,
): Promise<{ ok: boolean; message: string }> {
  const parsed = decodeAcceptable(entry);

  if (Result.isFailure(parsed)) {
    return {
      ok: false,
      message: `Unknown entry. Use one of: ${acceptable.literals.join(", ")}.`,
    };
  }

  const name = parsed.success;
  await mkdir(maintenanceDirectory(config.dataDirectory), {
    recursive: true,
    mode: 0o700,
  });
  let held: Database;

  try {
    held = lock(config.dataDirectory);
  } catch {
    return {
      ok: false,
      message: "A maintenance run holds the lock; nothing was changed.",
    };
  }

  try {
    const found = await Journal.read(config);

    if (found.kind === "none") {
      return { ok: true, message: nothingToRecover };
    }

    const confirmHint = `Nothing changed. Add --yes to keep the current state and drop ${name === "journal" ? "the whole journal" : `the ${name} entry`}.`;

    if (name === "journal") {
      const files = [];

      for (const path of journalFiles(config.dataDirectory)) {
        if (
          await access(path).then(
            () => true,
            () => false,
          )
        ) {
          files.push(path);
        }
      }

      if (!confirm) {
        return {
          ok: true,
          message: [
            ...files.map((path) => `journal ${path}`),
            confirmHint,
          ].join("\n"),
        };
      }

      const stamp = new Date().toISOString().replaceAll(":", "");
      const moved = [];

      for (const path of files) {
        const target = join(
          maintenanceDirectory(config.dataDirectory),
          `${basename(path, ".json")}.accepted-${stamp}.json`,
        );

        await rename(path, target);
        moved.push(target);
      }

      return {
        ok: true,
        message: `Moved the journal aside: ${moved.join(", ")}. Recovery no longer undoes anything it named.`,
      };
    }

    if (found.kind === "corrupt") {
      return {
        ok: false,
        message:
          "The journal is corrupt; only --accept-current journal applies.",
      };
    }

    const journal = found.journal;

    if (journal.get(name) === undefined) {
      return { ok: false, message: `The journal has no ${name} entry.` };
    }

    const lines = await describeEntry(config, journal, name);

    if (!confirm) {
      return { ok: true, message: [...lines, confirmHint].join("\n") };
    }

    await journal.clear(name);

    return {
      ok: true,
      message: [
        ...lines,
        `Dropped the ${name} entry${name === "files" ? `; the backup stays in ${backupDirectory(config.dataDirectory, journal.runID)}` : ""}. Run stargate maintenance recover to finish the rest.`,
      ].join("\n"),
    };
  } finally {
    held.close();
  }
}
