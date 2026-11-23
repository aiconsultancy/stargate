import { Result, Schema } from "effect";
import { settingsStruct } from "../../../config/settings-schema";
import { saveWaitingDelay } from "../../../gateway/waiting";
import type { CrewCaller } from "../execution/engine";
import { CrewError } from "../execution/state";

export const waitingInputSchema = settingsStruct({
  seconds: Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3600 })),
    Schema.Literal("off"),
  ]),
});

interface WaitingAuthority {
  options: {
    captainDirectory: string;
    team: { captain: { id: string } };
  };
  captain(caller: CrewCaller): Promise<void>;
}

export class CrewWaiting {
  public constructor(private readonly authority: WaitingAuthority) {}

  public async run(raw: unknown, caller: CrewCaller) {
    const parsed = Schema.decodeUnknownResult(waitingInputSchema)(raw);

    if (Result.isFailure(parsed))
      throw new CrewError("Invalid waiting settings.");
    caller.signal.throwIfAborted();
    await this.authority.captain(caller);

    const delayMs =
      parsed.success.seconds === "off" ? null : parsed.success.seconds * 1000;

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
