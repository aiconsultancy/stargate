import { Result, Schema } from "effect";
import {
  CaptainPostError,
  postInputSchema,
  runCaptainPost,
} from "../captain-post/captain-post";
import type { CrewCaller } from "./engine";
import { CrewError } from "./state";

interface PostAuthority {
  options: {
    captainDirectory: string;
    captainSessionID?: string | undefined;
    cron?: { configPath: string; bot: string } | undefined;
  };
  captain(caller: CrewCaller): Promise<void>;
}

/** Captain-only `stargate_post`; crew and child sessions are refused. */
export class CrewPost {
  constructor(
    private readonly authority: PostAuthority,
    private readonly runner: typeof runCaptainPost = runCaptainPost,
  ) {}

  async run(raw: unknown, caller: CrewCaller): Promise<unknown> {
    const parsed = Schema.decodeUnknownResult(postInputSchema)(raw);
    if (Result.isFailure(parsed))
      throw new CrewError(
        "Invalid stargate_post input. Use the declared fields; nothing was posted.",
      );
    const cancelled = () => {
      if (caller.signal.aborted)
        throw new CrewError(
          "Post cancelled; retry with the same key to read any recorded outcome.",
        );
    };
    cancelled();
    try {
      await this.authority.captain(caller);
    } catch (error) {
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Captain verification unavailable; nothing was posted.",
      );
    }
    cancelled();
    const { captainDirectory, captainSessionID, cron } = this.authority.options;
    if (!cron)
      throw new CrewError(
        "stargate_post unavailable: bind this captain to its gateway config and bot (plugin option cron: { configPath, bot }) first.",
      );
    // Stable host tool identity makes a retry read its recorded outcome.
    const input =
      !parsed.success.key && caller.id
        ? { ...parsed.success, key: caller.id }
        : parsed.success;
    try {
      return await this.runner(
        input,
        {
          configPath: cron.configPath,
          bot: cron.bot,
          expectedDirectory: captainDirectory,
          captainSessionID,
        },
        caller.signal,
      );
    } catch (error) {
      throw new CrewError(
        error instanceof CaptainPostError
          ? error.message
          : "Post outcome unconfirmed; raw details withheld. Retry with the same key to read the recorded outcome.",
      );
    }
  }
}
