import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { type Config, loadConfig } from "../config";
import { runCleanup } from "./cleanup";
import { cleanupProtection } from "./cleanup-protection";
import type { MaintenanceConfig } from "./config";
import { discoverCrews } from "./crews";
import { runDroid } from "./droid";
import { processRunner } from "./exec";
import { nightlyInstructions } from "./instructions";
import { recoveryBudgetMs } from "./journal";
import { packageDirectory } from "./ready";
import { adoptRelease, layout } from "./release";
import { reportSchema, summary } from "./report";
import {
  acceptCurrent,
  recoverInterruptedRun,
  runMaintenance,
  UpdateRefused,
} from "./run";
import { buildDroidUnits, buildMaintenanceUnits, timerName } from "./timer";
import { maintenanceUpdate, updateUnit } from "./update";
import {
  currentWindow,
  defaultInstallID,
  nextWindow,
  stableJitter,
} from "./window";

export const maintenanceHelp = `Usage: stargate maintenance <command> [--config PATH] [options]
Commands:
  plan            Read-only dry run: print what tonight's run would change
                  (--json prints the full report). No probes, no writes.
  cleanup --plan  Read-only cleanup dry run; list guarded scratch, branch and
                  worktree candidates. Changes run only through maintenance run.
  run             Apply changes inside the configured window, idle-gated, with
                  health checks and automatic rollback. Writes a private
                  report and queues one Slack summary. Exit 1 and
                  maintenance/ALERT.json when an operator must look.
                  --outside-window runs now with the window's length.
  update          --version X.Y.Z with --plan or --now. Operator-approved
                  update to one Stargate release, now: no window, no idle gate,
                  no cool-off. Stages and verifies the release (origin,
                  checksum, tree), installs and tests it, switches, checks
                  readiness and rolls back on failure. Restarts only the
                  gateway when the crew plugin is unchanged, otherwise
                  OpenCode and the gateway. --now starts a transient user
                  unit and returns; the report says what happened. --now
                  runs only from the installed, verified release
                  (<root>/current/src/main.ts), never a checkout. --plan
                  changes nothing. Refuses a downgrade, a leftover journal
                  (run recover first) and a release that failed here before
                  (--retry-failed allows that one).
  recover         Undo every change left in the maintenance journal
                  (sessions, configs, release, CLIs, proxy), restart what
                  they need and start the gateway. Takes the run lock (busy:
                  exit 1). No journal: no-op. Exit 1 if incomplete.
                  --after-run (the timer's ExecStopPost) only finishes the
                  journal of the run this systemd invocation started; for
                  any other journal it only starts a stopped gateway.
                  --accept-current ENTRY lists what one journal entry (files,
                  sessions, release, clis, cliproxyapi, gateway, openCode)
                  still covers; with --yes it keeps the current state and
                  drops that entry. ENTRY journal moves a corrupt journal
                  aside. See docs/maintenance.md before you use it.
  droid           One maintenance droid check (the droid timer runs it):
                  facts, findings, a Pi Durable model explanation and one
                  Slack post through the report bot, when there is
                  something to say. The model may only run plan and
                  recover, within Stargate's preconditions and limits.
                  --print shows the facts' deterministic post; no model,
                  actions or writes.
  window          Print the window, this install's jitter and next start.
  instructions    Print the captain/crew paragraph for the configured window.
  install-timer   Write ~/.config/systemd/user/<name>.timer and .service
                  (--name NAME, default stargate-maintenance), then daemon-reload.
                  Does not enable or start. --print shows units, writes none.
  install-droid-timer
                  Same for the droid (--name NAME, default
                  stargate-maintenance-droid): checks at the window end plus
                  droid.afterRunMinutes and at droid.healthCheck.
  adopt           One-time migration: --release DIR [--version X.Y.Z] marks an
                  existing release under <stargate.root>/releases as managed and
                  creates <stargate.root>/current if absent.
  schema          Print the JSON Schema of the report (stargate.maintenance.report.v1).
Configuration: the top-level "maintenance" section of stargate.json; every
component is off by default. See docs/maintenance.md.
Enable the timer after review:
  systemctl --user enable --now stargate-maintenance.timer
Tokens are never accepted as arguments; use environment references.`;

function windowText(config: Config, configPath: string) {
  const m = config.maintenance;
  if (!m) throw new Error("No maintenance section in configuration.");
  const installID = m.installID ?? defaultInstallID(configPath);
  const jitter = stableJitter(installID, m.window.jitterMinutes);
  const now = Date.now();
  const current = currentWindow(now, m.window, jitter);
  const next = nextWindow(now, m.window, jitter);
  return {
    m,
    installID,
    jitter,
    text: [
      `Window: ${m.window.start}–${m.window.end} ${m.window.timeZone} (enabled: ${m.enabled})`,
      `Install ID: ${installID}; stable jitter: ${jitter} min of max ${m.window.jitterMinutes}`,
      current
        ? `Now inside tonight's window; deadline ${new Date(current.deadline).toISOString()}`
        : `Next planned start: ${new Date(next.start).toISOString()}`,
    ].join("\n"),
  };
}

/** Bun, the entrypoint that follows release switches, and PATH. */
function unitCommand(m: MaintenanceConfig, configPath: string) {
  return {
    configPath,
    executable: process.execPath,
    entrypoint: m.stargate
      ? join(layout(m.stargate.root).current, "src", "main.ts")
      : join(packageDirectory, "src", "main.ts"),
    path: [
      dirname(process.execPath),
      process.env["PATH"] ?? "/usr/bin:/bin",
    ].join(":"),
  };
}

/** Write both units (never overwriting), then daemon-reload. */
async function installUnits(
  name: string,
  units: { timer: string; service: string },
) {
  if (process.platform !== "linux")
    throw new Error("User timers require Linux with systemd.");
  const directory = join(homedir(), ".config/systemd/user");
  await mkdir(directory, { recursive: true });
  for (const [suffix, contents] of [
    ["timer", units.timer],
    ["service", units.service],
  ] as const) {
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(join(directory, `${name}.${suffix}`), "wx", 0o600);
    } catch {
      throw new Error(
        `${name}.${suffix} exists or cannot be created. Refusing to overwrite it.`,
      );
    }
    try {
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
  }
  const reload = await processRunner.run(
    ["systemctl", "--user", "daemon-reload"],
    {
      timeoutMs: 30_000,
    },
  );
  if (reload.code !== 0)
    throw new Error(
      "systemctl --user daemon-reload failed. Check the user session bus.",
    );
  console.log(
    `Installed ${name}.timer and ${name}.service (not enabled).\nReview, then: systemctl --user enable --now ${name}.timer`,
  );
  return 0;
}

export async function maintenanceCli(
  operation: string | undefined,
  options: {
    configPath: string;
    json?: boolean;
    plan?: boolean;
    name?: string;
    print?: boolean;
    release?: string;
    version?: string;
    outsideWindow?: boolean;
    afterRun?: boolean;
    acceptCurrent?: string;
    yes?: boolean;
    now?: boolean;
    foreground?: boolean;
    retryFailed?: boolean;
  },
) {
  if (
    (options.now || options.foreground || options.retryFailed) &&
    operation !== "update"
  )
    throw new Error("--now and --retry-failed apply only to update.");
  if (operation === "cleanup" && !options.plan)
    throw new Error(
      "Use maintenance cleanup --plan; cleanup applies only through maintenance run.",
    );
  if (options.plan && operation !== "cleanup" && operation !== "update")
    throw new Error("--plan applies only to cleanup and update.");
  if (
    (options.acceptCurrent !== undefined || options.yes) &&
    (operation !== "recover" ||
      options.afterRun ||
      options.acceptCurrent === undefined)
  )
    throw new Error(
      "--accept-current ENTRY [--yes] applies only to recover, without --after-run.",
    );
  if (operation === "schema") {
    console.log(JSON.stringify(z.toJSONSchema(reportSchema), null, 2));
    return 0;
  }
  const { loadEnvironment } = await import("../runtime");
  await loadEnvironment(options.configPath);
  const config = await loadConfig(options.configPath);
  if (operation === "cleanup") {
    const settings = config.maintenance?.cleanup;
    if (!settings)
      throw new Error("Configure maintenance.cleanup before planning cleanup.");
    const crews = await discoverCrews(config);
    const result = await runCleanup({
      settings,
      plan: true,
      runner: processRunner,
      now: Date.now(),
      signal: AbortSignal.timeout(120_000),
      protectedPaths: cleanupProtection(config, options.configPath, crews),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.items.some((item) => item.status === "failed") ? 1 : 0;
  }
  if (operation === "update") {
    const m = config.maintenance;
    if (!m) throw new Error("No maintenance section in configuration.");
    process.umask(0o077);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      return await maintenanceUpdate(
        config,
        {
          configPath: resolve(options.configPath),
          ...(options.version ? { version: options.version } : {}),
          ...(options.plan ? { plan: true } : {}),
          ...(options.now ? { now: true } : {}),
          ...(options.foreground ? { foreground: true } : {}),
          ...(options.retryFailed ? { retryFailed: true } : {}),
          ...(options.json ? { json: true } : {}),
        },
        {
          unit: updateUnit(),
          launcher: processRunner,
          print: (text) => console.log(text),
          now: () => Date.now(),
          signal: controller.signal,
        },
      );
    } catch (error) {
      // A refusal is an answer, not a crash; its text is fixed and safe.
      if (!(error instanceof UpdateRefused)) throw error;
      console.log(error.message);
      return 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  if (operation === "recover") {
    const result =
      options.acceptCurrent !== undefined
        ? await acceptCurrent(config, options.acceptCurrent, !!options.yes)
        : await recoverInterruptedRun(
            config,
            {},
            options.afterRun ? { afterRun: true } : {},
          );
    console.log(result.message);
    return result.ok ? 0 : 1;
  }
  if (operation === "window") {
    console.log(windowText(config, options.configPath).text);
    return 0;
  }
  if (operation === "instructions") {
    const { m } = windowText(config, options.configPath);
    console.log(nightlyInstructions(m.window));
    return 0;
  }
  if (operation === "adopt") {
    const root = config.maintenance?.stargate?.root;
    if (!root)
      throw new Error("maintenance.stargate.root is required for adopt.");
    if (!options.release) throw new Error("--release DIR is required.");
    const result = await adoptRelease(
      root,
      resolve(options.release),
      options.version ?? "0.0.0",
    );
    console.log(JSON.stringify({ root, ...result }, null, 2));
    return 0;
  }
  if (operation === "install-timer") {
    const { m, jitter } = windowText(config, options.configPath);
    const name = timerName(options.name);
    const units = buildMaintenanceUnits({
      name,
      ...unitCommand(m, options.configPath),
      spec: m.window,
      jitter,
      recoveryMinutes: Math.ceil(recoveryBudgetMs(m) / 60_000) + 5,
    });
    if (options.print) {
      console.log(
        `# ${name}.timer\n${units.timer}\n# ${name}.service\n${units.service}`,
      );
      return 0;
    }
    return installUnits(name, units);
  }
  if (operation === "install-droid-timer") {
    const { m } = windowText(config, options.configPath);
    const droid = m.droid;
    if (!droid)
      throw new Error("No maintenance.droid section in configuration.");
    const name = timerName(options.name ?? "stargate-maintenance-droid");
    const units = buildDroidUnits({
      name,
      ...unitCommand(m, options.configPath),
      spec: m.window,
      afterRunMinutes: droid.afterRunMinutes,
      healthCheck: droid.healthCheck,
      // Model answer, a plan (3 min) and a full undo, with margin.
      timeoutMinutes:
        droid.timeoutMinutes + 3 + Math.ceil(recoveryBudgetMs(m) / 60_000) + 5,
    });
    if (options.print) {
      console.log(
        `# ${name}.timer\n${units.timer}\n# ${name}.service\n${units.service}`,
      );
      return 0;
    }
    return installUnits(name, units);
  }
  if (operation === "droid") {
    process.umask(0o077);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const result = await runDroid({
        config,
        configPath: options.configPath,
        signal: controller.signal,
        ...(options.print ? { preview: true } : {}),
      });
      if (result.text) console.log(result.text);
      console.log(
        result.skipped
          ? "Another droid check is running; nothing was done."
          : `Droid ${result.trigger} check: ${result.findings.length ? result.findings.join(", ") : "all clear"}; ${result.posted ? `post queued (${result.model ? "model" : "deterministic"})` : "no post"}.`,
      );
      return 0;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  if (operation === "plan" || operation === "run") {
    process.umask(0o077);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const { report, reportPath, attention } = await runMaintenance({
        config,
        configPath: options.configPath,
        mode: operation,
        ...(options.outsideWindow ? { outsideWindow: true } : {}),
        signal: controller.signal,
      });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else console.log(summary(report, reportPath ?? "not written (plan)"));
      // Non-zero makes the unit visibly failed when an operator must look.
      return report.outcome === "failed" || attention ? 1 : 0;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  throw new Error("Unknown maintenance command. Use maintenance --help.");
}
