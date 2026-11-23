import { ircParts } from "../../transports/irc/protocol";

/** An assignment is one IRC message: never several independently actionable turns. */
export async function sendFleetAssignment(
  client: {
    waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void>;
    budget(
      command: string,
      target: string,
      tags: Record<string, string>,
    ): number;
    readonly multiline: { maxBytes: number; maxLines: number } | undefined;
    privmsg(
      target: string,
      text: string,
      tags?: Record<string, string>,
      guard?: () => boolean,
    ): Promise<void>;
    sendBatch(
      target: string,
      lines: readonly { text: string; concat: boolean }[],
      tags?: Record<string, string>,
      guard?: () => boolean,
    ): Promise<void>;
  },
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
