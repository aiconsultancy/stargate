import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { type Config, pinnedSessionIDs } from "../../../config";
import { settingsStruct } from "../../../config/settings-schema";
import { defaultCronHorizonMinutes } from "./config";
import { type Dependencies, bounds, defaultDependencies } from "./context";
import { type Crew, discoverCrews } from "./crews";
import { type CommandRunner, type Reason } from "./exec";
import { readOptional } from "./files";
import {
  Journal,
  type UndoContext,
  type UndoEvent,
  type UndoStep,
  journalScope,
  undoJournal,
  undoStepScope,
  unitRunning,
} from "./journal";
import { maintenanceDirectory } from "./paths";
import { type ReportRecorder, writeAlert } from "./reports/report";
import { type IdleResult, type IdleScope, checkIdle } from "./schedule/idle";
import { readReady, readyProcessAlive, waitReady } from "./update/ready";

/**
 * Recovery orchestration: finishing a journal that an interrupted run left
 * behind, at an idle boundary. One path serves the run's own first step, the
 * CLI's `recover` commands and the maintenance droid. Callers hold the run
 * lock; every function takes the same injectable dependencies as the run.
 */

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
export async function recoverAtIdle(
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
export async function gatewayServing(config: Config, runner: CommandRunner) {
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
export async function ingressMayBeOpen(config: Config, runner: CommandRunner) {
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

export { lastRunPath, lock, recordUndo, undoContext };
