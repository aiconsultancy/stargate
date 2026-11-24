import { diffEvents } from "./diff";
import { type OpenCodeVersionLookup, gatewayVersion } from "./gateway";
import { type ApiV1Deps, createApiV1Source } from "./projection";
import { startApiV1Server } from "./server";

type RuntimeApiOptions = Pick<
  Parameters<typeof startApiV1Server>[0],
  "config" | "dataDirectory" | "signal" | "composeRoutes"
> & {
  projection: ApiV1Deps;
  opencodeVersion: OpenCodeVersionLookup;
};

/** Compose the Fleet API without making its implementation modules public. */
export async function startRuntimeApi({
  projection,
  opencodeVersion,
  ...server
}: RuntimeApiOptions) {
  return startApiV1Server({
    ...server,
    source: createApiV1Source(projection),
    diff: diffEvents,
    gateway: {
      version: await gatewayVersion(),
      startedAt: Math.round(performance.timeOrigin),
      opencodeVersion,
    },
  });
}
