import type { MaintenanceDrain } from "../maintenance-drain";
import { checkIdle, type IdleInput, type IdleResult } from "./idle";
import type { Clock } from "./run";

/** One bounded wait within the existing maintenance runner, not a scheduler. */
export async function waitForMaintenanceDrain(input: {
  deadlineAt: number;
  pollMs: number;
  signal: AbortSignal;
  clock: Clock;
  targets: () => IdleInput[];
  announced: () => boolean;
  describe: () => Promise<NonNullable<MaintenanceDrain["stragglers"]>>;
  observe?: (target: IdleInput) => Promise<IdleResult>;
}) {
  for (;;) {
    input.signal.throwIfAborted();
    let idle = true;
    // Do not short circuit: every installation must be observed.
    for (const target of input.targets())
      if (!(await (input.observe ?? checkIdle)(target)).idle) idle = false;
    input.signal.throwIfAborted();
    if (idle && input.announced())
      return { outcome: "idle" as const, stragglers: [] };
    if (input.clock.now() >= input.deadlineAt)
      return {
        outcome: "deadline" as const,
        stragglers: [
          ...(await input.describe()),
          ...(!input.announced() ? [{ reason: "notice-unconfirmed" }] : []),
        ].slice(0, 1000),
      };
    await input.clock.sleep(
      Math.min(input.pollMs, input.deadlineAt - input.clock.now()),
      input.signal,
    );
  }
}
