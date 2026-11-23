import {
  NotificationControlError,
  runNotificationOperation,
} from "../../notifications/preferences/notification-control";
import { notificationInputSchema } from "../../notifications/preferences/notification-store";
import type { CrewCaller } from "../execution/engine";
import { CrewError } from "../execution/state";

interface NotificationAuthority {
  options: {
    captainDirectory: string;
    cron?: { configPath: string; bot: string } | undefined;
  };
  captain(caller: CrewCaller): Promise<void>;
}

export class CrewNotifications {
  constructor(
    private readonly authority: NotificationAuthority,
    private readonly runner: typeof runNotificationOperation = runNotificationOperation,
  ) {}

  async run(raw: unknown, caller: CrewCaller): Promise<unknown> {
    const parsed = notificationInputSchema.safeParse(raw);

    if (!parsed.success)
      throw new CrewError(
        "Invalid notification operation; targets must be explicit.",
      );
    caller.signal.throwIfAborted();
    await this.authority.captain(caller);
    caller.signal.throwIfAborted();
    const binding = this.authority.options.cron;

    if (!binding)
      throw new CrewError(
        "stargate_notifications unavailable: bind the captain's cron configPath and bot first.",
      );

    try {
      return await this.runner(
        parsed.data,
        {
          ...binding,
          expectedDirectory: this.authority.options.captainDirectory,
          captainSessionID: caller.sessionID,
          operationID: caller.id,
        },
        caller.signal,
      );
    } catch (error) {
      throw new CrewError(
        error instanceof NotificationControlError
          ? error.message
          : "Notification operation unconfirmed; private details withheld.",
      );
    }
  }
}
