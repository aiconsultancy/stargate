import { dirname, isAbsolute } from "node:path";
import { quote } from "../../../app/service";
import {
  type WindowSpec,
  addClock,
  timerCalendar,
  windowMinutes,
} from "./window";

const marker = "# Managed by Stargate CLI";

export function timerName(name = "stargate-maintenance") {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
    throw new Error("Invalid timer name.");

  return name;
}

/**
 * A user timer that starts one oneshot run at the window start plus this
 * install's stable jitter, in the window's time zone (systemd applies DST).
 * The run stops itself before the window closes; TimeoutStartSec is only a
 * last resort a little after the window end.
 */
/**
 * Last-resort kill timer. The run itself stops starting changes by the
 * window end; this covers the longest real window (a fall-back night adds
 * up to an hour to a window that spans the repeated hour) and the undo.
 */
export function startTimeoutMinutes(
  spec: Pick<WindowSpec, "start" | "end">,
  jitter: number,
  recoveryMinutes: number,
) {
  return windowMinutes(spec) + 60 - jitter + recoveryMinutes;
}

export function buildMaintenanceUnits(input: {
  name: string;
  configPath: string;
  executable: string;
  entrypoint: string;
  path: string;
  spec: WindowSpec;
  jitter: number;
  /** Journal undo worst case: derived from the configured packages (N7). */
  recoveryMinutes: number;
}) {
  for (const path of [input.configPath, input.executable, input.entrypoint])
    if (!isAbsolute(path)) throw new Error("Unit paths must be absolute.");
  const name = timerName(input.name);
  const window = `${input.spec.start}–${input.spec.end} ${input.spec.timeZone}`;

  const timeout = startTimeoutMinutes(
    input.spec,
    input.jitter,
    input.recoveryMinutes,
  );

  const service = `${marker}
[Unit]
Description=Stargate nightly maintenance (${window})
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${dirname(input.configPath).replaceAll("%", "%%")}/
EnvironmentFile=-${`${input.configPath}.env`.replaceAll("%", "%%")}
Environment=${quote(`PATH=${input.path}`)}
ExecStart=${quote(input.executable, true)} ${quote(input.entrypoint, true)} maintenance run --config ${quote(input.configPath, true)}
ExecStopPost=${quote(input.executable, true)} ${quote(input.entrypoint, true)} maintenance recover --after-run --config ${quote(input.configPath, true)}
UMask=0077
TimeoutStartSec=${timeout}min
TimeoutStopSec=${input.recoveryMinutes}min
`;

  const timer = `${marker}
[Unit]
Description=Stargate nightly maintenance window (${window})

[Timer]
OnCalendar=${timerCalendar(input.spec, input.jitter)}
AccuracySec=1min
Persistent=false
Unit=${name}.service

[Install]
WantedBy=timers.target
`;

  return { service, timer };
}

/**
 * The droid's timer: one check after the window (end plus
 * `afterRunMinutes`) and one daily health check, both local times in the
 * window's time zone. The oneshot service runs `maintenance droid`, which
 * decides from the reports whether this is a post-run check.
 */
export function buildDroidUnits(input: {
  name: string;
  configPath: string;
  executable: string;
  entrypoint: string;
  path: string;
  spec: WindowSpec;
  afterRunMinutes: number;
  healthCheck: string;
  /** Model answer, plan and a full journal undo, with margin. */
  timeoutMinutes: number;
}) {
  for (const path of [input.configPath, input.executable, input.entrypoint])
    if (!isAbsolute(path)) throw new Error("Unit paths must be absolute.");
  const name = timerName(input.name);

  const times = [
    ...new Set([
      addClock(input.spec.end, input.afterRunMinutes),
      input.healthCheck,
    ]),
  ];

  const service = `${marker}
[Unit]
Description=Stargate maintenance droid (checks ${times.join(", ")} ${input.spec.timeZone})
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${dirname(input.configPath).replaceAll("%", "%%")}/
EnvironmentFile=-${`${input.configPath}.env`.replaceAll("%", "%%")}
Environment=${quote(`PATH=${input.path}`)}
ExecStart=${quote(input.executable, true)} ${quote(input.entrypoint, true)} maintenance droid --config ${quote(input.configPath, true)}
UMask=0077
TimeoutStartSec=${input.timeoutMinutes}min
`;

  const timer = `${marker}
[Unit]
Description=Stargate maintenance droid checks

[Timer]
${times.map((time) => `OnCalendar=*-*-* ${time}:00 ${input.spec.timeZone}`).join("\n")}
AccuracySec=1min
Persistent=false
Unit=${name}.service

[Install]
WantedBy=timers.target
`;

  return { service, timer };
}

/**
 * `systemd-run` arguments for one operator update as a transient user
 * unit. The unit is separate from the session that starts it, so the update
 * continues when it restarts OpenCode. As for the nightly service, the
 * unit's ExecStopPost finishes the journal of a run that was killed.
 */
export function buildUpdateCommand(input: {
  unit: string;
  configPath: string;
  executable: string;
  entrypoint: string;
  path: string;
  version: string;
  retryFailed: boolean;
  /** Last-resort limit of the run itself. */
  runMinutes: number;
  recoveryMinutes: number;
}) {
  for (const path of [input.configPath, input.executable, input.entrypoint]) {
    if (!isAbsolute(path)) throw new Error("Unit paths must be absolute.");

    // The service manager expands these in a transient unit's command.
    if (/[%$]/.test(path)) throw new Error("Unit paths cannot contain % or $.");
  }

  if (!/^\d+\.\d+\.\d+$/.test(input.version))
    throw new Error("Use a MAJOR.MINOR.PATCH version.");
  const unit = timerName(input.unit);
  const main = [quote(input.executable, true), quote(input.entrypoint, true)];

  return [
    "systemd-run",
    "--user",
    // Systemd-run returns when the command has started; a command that
    // Cannot be executed is an error here, not a silent failed unit.
    "--service-type=exec",
    "--collect",
    `--unit=${unit}`,
    `--description=Stargate operator update to ${input.version}`,
    `--working-directory=${dirname(input.configPath)}`,
    `--property=EnvironmentFile=-${input.configPath}.env`,
    "--property=UMask=0077",
    `--property=RuntimeMaxSec=${input.runMinutes}min`,
    `--property=TimeoutStopSec=${input.recoveryMinutes}min`,
    `--property=ExecStopPost=${main.join(" ")} maintenance recover --after-run --config ${quote(input.configPath, true)}`,
    `--setenv=PATH=${input.path}`,
    "--",
    input.executable,
    input.entrypoint,
    "maintenance",
    "update",
    "--version",
    input.version,
    "--now",
    "--foreground",
    "--config",
    input.configPath,
    ...(input.retryFailed ? ["--retry-failed"] : []),
  ];
}
