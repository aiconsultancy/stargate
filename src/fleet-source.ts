import { createHash } from "node:crypto";

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
