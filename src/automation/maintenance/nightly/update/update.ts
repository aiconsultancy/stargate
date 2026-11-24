import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "../../../../config";
import type { CommandRunner } from "../exec";
import { recoveryBudgetMs } from "../journal";
import { maintenanceDirectory } from "../paths";
import { packageDirectory } from "./ready";
import { layout } from "./release";
import { readMetadata } from "./release-record";
import { type Report, summary } from "../reports/report";
import {
  type Dependencies,
  type RunInput,
  type RunResult,
  UpdateRefused,
  defaultDependencies,
  runMaintenance,
  samePlugin,
} from "../run";
import { buildUpdateCommand } from "../schedule/timer";
import { normalizeVersion } from "./versions";

/**
 * `stargate maintenance update --version X.Y.Z (--plan | --now)`: an
 * operator-approved update of the Stargate release, outside the window and
 * without the idle gate or the cool-off. It is the nightly run's own path
 * for one named release: verified staging, install and tests, journal,
 * switch, readiness check and automatic rollback.
 *
 * `--now` starts the update as a transient systemd user unit and returns:
 * the update may restart OpenCode, which ends the session that asked for it.
 * `--foreground` is what that unit runs.
 */
export type UpdateOptions = {
  configPath: string;
  version?: string;
  plan?: boolean;
  now?: boolean;
  foreground?: boolean;
  retryFailed?: boolean;
  json?: boolean;
};

export type UpdateDependencies = {
  /** Bun, the entrypoint and PATH of the unit; see `updateUnit`. */
  unit: { executable: string; entrypoint: string; path: string };
  /** Starts the transient unit. */
  launcher: CommandRunner;
  run?: Partial<Dependencies>;
  maintenance?: (input: RunInput, deps?: Dependencies) => Promise<RunResult>;
  print: (text: string) => void;
  now: () => number;
  signal: AbortSignal;
};

/**
 * What the update unit runs: this release's own entrypoint, which has the
 * command (the `current` release can be older), and a fixed PATH, never the
 * caller's. `maintenanceUpdate` refuses when this is not an installed,
 * verified release.
 */
export function updateUnit() {
  return {
    executable: process.execPath,
    entrypoint: join(packageDirectory, "src", "main.ts"),
    path: [
      dirname(process.execPath),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
  };
}

/**
 * Name when the unit's code is a managed release that maintenance verified:
 * a real directory directly in `<root>/releases`. A checkout, a link to
 * one, or an adopted release is not: its code was never checked, and a
 * removed worktree would take the unit's `ExecStopPost` recovery with it.
 */
async function installedRelease(
  root: string,
  unit: { entrypoint: string },
): Promise<string | null> {
  try {
    const directory = await realpath(resolve(dirname(unit.entrypoint), ".."));

    return dirname(directory) === (await realpath(layout(root).releases)) &&
      (await readMetadata(directory))?.verification === "verified"
      ? basename(directory)
      : null;
  } catch {
    return null;
  }
}

/** Last-resort limit of the unit: the update's own window, with margin. */
const runMinutes = 100;

const stargateOf = (report: Report) =>
  report.components.find((component) => component.id === "stargate");

/** Which services a switch to `version` restarts, as far as is known now. */
async function restartText(config: Config, version: string) {
  const root = config.maintenance?.stargate?.root;

  if (!root) return "";
  const staged = await readMetadata(join(root, "releases", version));

  if (staged?.verification !== "verified")
    return "Restart: decided after staging. The gateway only when the crew plugin is unchanged; otherwise OpenCode and the gateway.";

  return (await samePlugin(root, version))
    ? "Restart: the gateway only (the crew plugin is unchanged)."
    : "Restart: OpenCode and the gateway (the crew plugin changed or is unknown).";
}

function refusal(report: Report, version: string) {
  const stargate = stargateOf(report);

  if (!stargate) return "No managed Stargate release is configured.";

  if (stargate.status === "unchanged")
    return `Stargate ${version} is the current release. Nothing to do.`;

  if (stargate.reason === "version-mismatch")
    return `Refused: ${version} is older than the current release ${stargate.before}. To go back after a failed update, use stargate maintenance recover.`;

  if (stargate.reason === "known-bad")
    return `Refused: ${version} failed here after an earlier switch. Use --retry-failed to try it again.`;

  if (stargate.reason === "not-found")
    return `Refused: no published release ${version} was found.`;

  return `Refused: Stargate ${version} cannot be installed (${stargate.reason ?? stargate.status}).`;
}

export async function maintenanceUpdate(
  config: Config,
  options: UpdateOptions,
  deps: UpdateDependencies,
): Promise<number> {
  const m = config.maintenance;

  if (!m?.stargate)
    throw new UpdateRefused("maintenance.stargate is required for an update.");
  const version = options.version;

  if (!version || normalizeVersion(version) !== version)
    throw new UpdateRefused("--version MAJOR.MINOR.PATCH is required.");

  if (options.plan === options.now)
    throw new UpdateRefused("Use exactly one of --plan and --now.");

  if (options.foreground && !options.now)
    throw new UpdateRefused("--foreground applies only with --now.");

  // The code that switches, rolls back and recovers is this release's.
  const runnerRelease = options.now
    ? await installedRelease(m.stargate.root, deps.unit)
    : null;

  if (options.now && !runnerRelease)
    throw new UpdateRefused(
      `This Stargate is not an installed release: an update runs only from a verified release in ${layout(m.stargate.root).releases}. Run the installed stargate (${join(layout(m.stargate.root).current, "src", "main.ts")}). Nothing was changed.`,
    );
  const maintenance = deps.maintenance ?? runMaintenance;

  const input = (mode: "plan" | "run"): RunInput => ({
    config,
    configPath: options.configPath,
    mode,
    update: {
      version,
      ...(options.retryFailed && { retryFailed: true }),
      ...(runnerRelease && { runnerRelease }),
    },
    signal: deps.signal,
  });

  const run = (mode: "plan" | "run") =>
    maintenance(input(mode), { ...defaultDependencies, ...deps.run });

  if (options.foreground) {
    const { report, reportPath, attention } = await run("run");

    if (options.json) deps.print(JSON.stringify(report, null, 2));
    else deps.print(summary(report, reportPath ?? "not written"));

    return report.outcome === "failed" ||
      attention ||
      stargateOf(report)?.status !== "updated"
      ? 1
      : 0;
  }

  // Read-only: the same checks that the update makes first.
  const { report } = await run("plan");
  const planned = stargateOf(report)?.status === "planned";

  if (options.plan) {
    if (options.json) deps.print(JSON.stringify(report, null, 2));
    else if (planned) {
      deps.print(
        `Stargate ${stargateOf(report)?.before} → ${version}: would stage, verify (origin, checksum, tree), install, test and switch now, without the window or cool-off${m.drain.enabled ? `, after an idle-or-deadline restart drain (at most ${m.drain.deadlineMinutes} minutes)` : " or the idle gate"}.`,
      );
      deps.print(await restartText(config, version));
      deps.print("Nothing was changed.");
    } else deps.print(refusal(report, version));

    return planned || stargateOf(report)?.status === "unchanged" ? 0 : 1;
  }

  if (!planned) {
    deps.print(refusal(report, version));

    return stargateOf(report)?.status === "unchanged" ? 0 : 1;
  }

  const unit = `stargate-update-${version.replaceAll(".", "-")}-${Math.floor(deps.now() / 1000)}`;

  const started = await deps.launcher.run(
    buildUpdateCommand({
      unit,
      configPath: options.configPath,
      ...deps.unit,
      version,
      retryFailed: !!options.retryFailed,
      runMinutes,
      recoveryMinutes: Math.ceil(recoveryBudgetMs(m) / 60_000) + 5,
    }),
    { timeoutMs: 30_000 },
  );

  if (started.code !== 0)
    throw new UpdateRefused(
      "systemd-run could not start the update unit. Check the user session bus and that Bun can run. Nothing was changed.",
    );
  const directory = maintenanceDirectory(config.dataDirectory);
  deps.print(
    [
      `Started ${unit}.service: Stargate ${stargateOf(report)?.before} → ${version}.`,
      await restartText(config, version),
      "The update continues if it restarts OpenCode and this session ends.",
      `Progress: journalctl --user -u ${unit}.service`,
      `Result: the newest report in ${join(directory, "reports")}; ${join(directory, "ALERT.json")} exists when an operator must look.`,
      `Verify: ${join(config.dataDirectory, "ready.json")} names version ${version}.`,
    ].join("\n"),
  );

  return 0;
}
