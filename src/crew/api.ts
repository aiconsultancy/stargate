import { resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { CrewSession } from "./engine";
import type { HistorySession } from "./history";
import { CrewError, type Peer } from "./state";
import type { Team } from "./team";

export function historyVisible(
  options: {
    team: Team;
    namespace: string;
    captainDirectory: string;
    projectDirectory: string;
    worktrees: Record<string, string>;
  },
  peer: Peer | null,
  session: HistorySession,
): boolean {
  if (options.team.historyScope === "server") return true;
  const identity = session.metadata?.["pogoCrew"];
  const metadata =
    typeof identity === "object" &&
    identity !== null &&
    !Array.isArray(identity)
      ? identity
      : undefined;
  if (metadata && metadata["namespace"] !== options.namespace) return false;
  const directory = resolve(session.location.directory);
  if (
    !session.parentID &&
    session.agent === options.team.captain.id &&
    directory === resolve(options.captainDirectory)
  )
    return true;
  if (peer) {
    const worktree = options.worktrees[peer.crewID];
    return (
      !session.parentID &&
      session.id === peer.sessionID &&
      session.agent === peer.crewID &&
      !!worktree &&
      directory === resolve(worktree) &&
      metadata?.["namespace"] === options.namespace &&
      metadata["crewID"] === peer.crewID
    );
  }
  const project = resolve(options.projectDirectory);
  return (
    options.team.historyScope === "project" &&
    (directory === project || directory.startsWith(`${project}/`))
  );
}

/** Plugins run on the server host; never discover a service on the Slack client. */
export async function connectHistoryAPI(
  team: Team,
  caller: CrewSession,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    let baseUrl: string;
    let headers: Record<string, string>;
    if (team.historyAPI) {
      baseUrl = team.historyAPI.url;
      headers = Object.fromEntries(
        Object.entries(team.historyAPI.headersEnv ?? {}).map(
          ([header, name]) => {
            const value = process.env[name];
            if (!value)
              throw new CrewError(
                "History API authentication environment is missing in the OpenCode service.",
              );
            return [header, value];
          },
        ),
      );
    } else {
      const endpoint = await Service.discover();
      if (!endpoint)
        throw new CrewError(
          "History API unavailable; configure team.historyAPI for this OpenCode server.",
        );
      baseUrl = endpoint.url;
      headers =
        Service.headers({
          url: endpoint.url,
          ...(endpoint.auth ? { auth: endpoint.auth } : {}),
        }) ?? {};
    }
    const client = OpenCode.make({ baseUrl, headers });
    const observed = await client.session.get(
      { sessionID: caller.id },
      { signal },
    );
    if (
      observed.id !== caller.id ||
      observed.agent !== caller.agent ||
      observed.parentID !== caller.parentID ||
      resolve(observed.location.directory) !==
        resolve(caller.location.directory) ||
      JSON.stringify(observed.metadata?.["pogoCrew"]) !==
        JSON.stringify(caller.metadata?.["pogoCrew"])
    )
      throw new CrewError(
        "History endpoint must address the same OpenCode server and caller session.",
      );
    return client;
  } catch (error) {
    if (error instanceof CrewError) throw error;
    throw new CrewError(
      "History API connection unconfirmed; check the same OpenCode server and authentication. Raw details withheld.",
    );
  }
}
