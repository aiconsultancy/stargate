import { z } from "zod";
import { saveWaitingDelay } from "../waiting";
import type { CrewCaller } from "./engine";
import { CrewError } from "./state";

export const waitingInputSchema = z.strictObject({
  seconds: z.union([z.number().int().min(0).max(3600), z.literal("off")]),
});

interface WaitingAuthority {
  options: {
    captainDirectory: string;
    team: { captain: { id: string } };
  };
  captain(caller: CrewCaller): Promise<void>;
}

export class CrewWaiting {
  constructor(private readonly authority: WaitingAuthority) {}

  async run(raw: unknown, caller: CrewCaller) {
    const parsed = waitingInputSchema.safeParse(raw);
    if (!parsed.success) throw new CrewError("Invalid waiting settings.");
    caller.signal.throwIfAborted();
    await this.authority.captain(caller);
    const delayMs =
      parsed.data.seconds === "off" ? null : parsed.data.seconds * 1000;
    try {
      await saveWaitingDelay(
        this.authority.options.captainDirectory,
        this.authority.options.team.captain.id,
        delayMs,
        caller.signal,
      );
    } catch {
      throw new CrewError(
        "Waiting setting change unconfirmed; check private workspace access.",
      );
    }
    return { delayMs, effect: "subsequent-turns" as const };
  }
}
