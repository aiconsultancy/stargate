import type { Plugin } from "@opencode/plugin/effect";
import { Session } from "@opencode/schema";
import { type Context, Effect } from "effect";
import type { CrewSessions } from "./engine";

export function nativeWait(
  wait: Plugin.Context["session"]["wait"],
  runtime: Context.Context<never>,
): CrewSessions["wait"] {
  return (input, request) =>
    Effect.runPromiseWith(runtime)(
      wait({ sessionID: Session.ID.make(input.sessionID) }),
      request?.signal ? { signal: request.signal } : undefined,
    );
}
