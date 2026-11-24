import type { Logger } from "pino";
import { officerFleetSockets } from "../../../../config/composition";
import { diffEvents } from "./diff";
import { type OpenCodeVersionLookup, gatewayVersion } from "./gateway";
import {
  type ConfiguredSocket,
  OfficerSocketError,
  checkOfficerSocketPaths,
} from "./officers";
import { type ApiV1Deps, createApiV1Source } from "./projection";
import { startApiV1Server } from "./server";

type RuntimeApiOptions = Pick<
  Parameters<typeof startApiV1Server>[0],
  "config" | "dataDirectory" | "signal" | "composeRoutes"
> & {
  projection: ApiV1Deps;
  opencodeVersion: OpenCodeVersionLookup;
  log: Pick<Logger, "info" | "error">;
};

/** The configuration's other sockets, which officers' sockets must not be. */
function otherSockets(config: ReturnType<ApiV1Deps["config"]>) {
  return [
    ...(config.irc ?? []).flatMap((registration) =>
      registration.fleetControl
        ? [
            {
              path: registration.fleetControl.socketPath,
              name: `the Fleet Control socket of IRC registration ${registration.id}`,
            },
          ]
        : [],
    ),
    ...(config.teams ?? []).map((team) => ({
      path: team.socketPath,
      name: `the socket of Teams registration ${team.id}`,
    })),
    ...(config.dashboardSocket
      ? [{ path: config.dashboardSocket.path, name: "the dashboard socket" }]
      : []),
  ] satisfies ConfiguredSocket[];
}

/**
 * Compose the Fleet API without making its implementation modules public:
 * the operator listener when `api` is configured, and officers' read-only
 * sockets whenever officers have socket directories (docs/api.md#officers).
 */
export async function startRuntimeApi({
  projection,
  opencodeVersion,
  log,
  ...server
}: RuntimeApiOptions) {
  // Each officer with a Subspace socket also gets a Fleet API socket. The
  // Section needs a restart to change, so the loaded settings decide.
  const config = projection.config();
  const officers = officerFleetSockets(config.subspaceAgents);

  const started = await (async () => {
    checkOfficerSocketPaths(officers, otherSockets(config));

    return startApiV1Server({
      ...server,
      officers,
      source: createApiV1Source(projection),
      diff: diffEvents,
      gateway: {
        version: await gatewayVersion(),
        startedAt: Math.round(performance.timeOrigin),
        opencodeVersion,
      },
    });
  })().catch((error: unknown) => {
    // Name the officer whose socket or directory stopped start-up.
    if (error instanceof OfficerSocketError) {
      log.error(error.message);
    }

    throw error;
  });

  log.info(
    {
      ...(server.config && { listen: server.config.listen }),
      officers: officers.length,
    },
    "Fleet API listening",
  );

  return started;
}
