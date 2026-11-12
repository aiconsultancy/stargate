import { dirname, isAbsolute } from "node:path";
import { quote } from "../service";
import {
  addClock,
  timerCalendar,
  type WindowSpec,
  windowMinutes,
} from "./window";

const marker = "# Managed by Pogo CLI";

export function timerName(name = "pogo-maintenance") {
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
Description=Pogo nightly maintenance (${window})
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
Description=Pogo nightly maintenance window (${window})

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
Description=Pogo maintenance droid (checks ${times.join(", ")} ${input.spec.timeZone})
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
Description=Pogo maintenance droid checks

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
