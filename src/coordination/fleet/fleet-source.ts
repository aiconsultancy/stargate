import { createHash } from "node:crypto";
import type { PromptSourceContext } from "../../backends/backend";
import type { FleetJob } from "./protocol";

/** Immutable source identity; content and authority live only in the ledger. */
export function fleetSourceReference(
  transport: "teams" | "irc",
  namespace: string,
  channel: string,
  messageID: string,
) {
  return `${transport}-${createHash("sha256")
    .update(JSON.stringify([namespace, channel, messageID]))
    .digest("hex")}`;
}

export function fleetResultSource(job: {
  fleet?: FleetJob | undefined;
}): PromptSourceContext["source"] | undefined {
  if (job.fleet?.kind !== "result") return;
  const result = job.fleet.completion;
  const reference = `fleet-result-${result.dispatchID}`;

  return {
    transport: "fleet",
    authority: "agent",
    reference,
    user: result.actor,
    sender: "captain",
    channel: result.channel,
    thread: result.inputID ?? reference,
    message: reference,
  };
}
