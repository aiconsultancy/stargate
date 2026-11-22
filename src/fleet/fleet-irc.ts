import type { IrcClient } from "../irc/client";
import { ircParts } from "../irc/text";

/** An assignment is one IRC message: never several independently actionable turns. */
export async function sendFleetAssignment(
  client: Pick<
    IrcClient,
    "waitReady" | "budget" | "multiline" | "privmsg" | "sendBatch"
  >,
  channel: string,
  text: string,
  allowed: () => boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await client.waitReady(10_000, signal);
  const guard = () => !signal.aborted && allowed();
  if (!guard()) throw new Error("Fleet dispatch is no longer allowed");
  const budget = client.budget("PRIVMSG", channel, {});
  if (!text.includes("\n") && Buffer.byteLength(text) <= budget) {
    await client.privmsg(channel, text, {}, guard);
    return;
  }
  const limits = client.multiline;
  if (!limits || Buffer.byteLength(text) > limits.maxBytes)
    throw new Error(
      "Fleet assignment needs negotiated atomic IRC multiline within server limits",
    );
  const partBudget = Math.min(
    limits.maxBytes,
    client.budget("PRIVMSG", channel, {
      batch: `stargate${"9".repeat(12)}`,
      "draft/multiline-concat": "",
    }),
  );
  const lines = text.split("\n").flatMap((line) =>
    (line ? ircParts(line, partBudget) : [""]).map((text, index) => ({
      text,
      concat: index > 0,
    })),
  );
  if (lines.length > limits.maxLines)
    throw new Error("Fleet assignment exceeds atomic IRC multiline limits");
  await client.sendBatch(channel, lines, {}, guard);
}
