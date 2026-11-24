import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { runCleanup } from "./cleanup/cleanup";
import { type CommandRunner, processRunner } from "./exec";
import type { Clock } from "./schedule/drain";
import {
  type OpenCodeControl,
  connectOpenCode,
  openCodeCallMs,
} from "./update/opencode";

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
