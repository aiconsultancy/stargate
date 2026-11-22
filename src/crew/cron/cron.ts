import {
  CronControlError,
  cronOperationSchema,
  runCronOperation,
} from "../../cron/control";
import type { CrewCaller } from "../execution/engine";
import { CrewError } from "../execution/state";

interface CronAuthority {
  options: {
    captainDirectory: string;
    cron?: { configPath: string; bot: string } | undefined;
  };
  captain(caller: CrewCaller): Promise<void>;
}

export class CrewCron {
  constructor(
    private readonly authority: CronAuthority,
    private readonly runner: typeof runCronOperation = runCronOperation,
  ) {}

  async run(raw: unknown, caller: CrewCaller): Promise<unknown> {
    const parsed = cronOperationSchema.safeParse(raw);
    if (!parsed.success)
      throw new CrewError(
        "Invalid stargate_cron input. Use the declared fields.",
      );
    const cancelled = () => {
      if (caller.signal.aborted)
        throw new CrewError(
          "Cronjob operation cancelled; inspect retained status before retrying.",
        );
    };
    cancelled();
    try {
      await this.authority.captain(caller);
    } catch (error) {
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Captain verification unavailable; raw details withheld.",
      );
    }
    cancelled();
    const { captainDirectory, cron } = this.authority.options;
    if (!cron)
      throw new CrewError(
        "Cronjobs unavailable: configure this captain's cron configPath and bot binding first.",
      );
    const input = parsed.data;
    // Stable host tool identity makes a retry reuse its durable admission.
    const operation =
      input.op === "run" && !input.requestId && caller.id
        ? { ...input, requestId: caller.id }
        : input;
    try {
      const result = await this.runner(
        operation,
        {
          configPath: cron.configPath,
          bot: cron.bot,
          expectedDirectory: captainDirectory,
        },
        caller.signal,
      );
      cancelled();
      return result;
    } catch (error) {
      cancelled();
      throw new CrewError(
        error instanceof CronControlError
          ? error.message
          : "Cronjob operation unconfirmed; raw details withheld. Inspect retained status before retrying.",
      );
    }
  }
}
