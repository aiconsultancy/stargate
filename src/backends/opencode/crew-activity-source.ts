import { CrewReporting } from "../../coordination/crew/reporting/report-rpc";
import type { CrewTurnRecorder } from "../backend";
import { nativeActivityReads } from "./activity-family";
import { CrewActivityCollector } from "./crew-activity";
import { owningInput } from "./input-origin";
import type { OpenCodeCrewActivity } from "./opencode";

/** Collect one registration's crew turns over its OpenCode client and plugin. */
export const crewActivityStarter =
  (recorder: CrewTurnRecorder): OpenCodeCrewActivity =>
  (client, directory, signal) => {
    new CrewActivityCollector(recorder, {
      events: client.event,
      family: nativeActivityReads(client),
      turns: (input, readSignal) =>
        client.rpc(CrewReporting).crewTurns(input, {
          location: { directory: directory() },
          signal: readSignal,
        }),
      owner: (sessionID, assistant, readSignal) =>
        owningInput(client, sessionID, readSignal, assistant),
    }).start(signal);
  };
