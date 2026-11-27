import { type IrcConfig, effectiveIrcConfig } from "../../config";
import {
  FleetError,
  type FleetTarget,
  type PeerMessageInput,
} from "./protocol";
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

  if (!guard()) {
    throw new Error("Fleet dispatch is no longer allowed");
  }

  const budget = client.budget("PRIVMSG", channel, {});

  if (!text.includes("\n") && Buffer.byteLength(text) <= budget) {
    await client.privmsg(channel, text, {}, guard);

    return;
  }

  const limits = client.multiline;

  if (!limits || Buffer.byteLength(text) > limits.maxBytes) {
    throw new Error(
      "Fleet assignment needs negotiated atomic IRC multiline within server limits",
    );
  }

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

  if (lines.length > limits.maxLines) {
    throw new Error("Fleet assignment exceeds atomic IRC multiline limits");
  }

  await client.sendBatch(channel, lines, {}, guard);
}

/** Shown when WHOIS cannot prove the recipient captain holds its account now. */
export const peerRecipientUnconfirmed =
  "IRC could not confirm that the recipient captain is online under its configured account. Try again later or ask in your ship channel.";

/** Shown when this gateway's own IRC connection is down: nothing about the peer. */
export const peerIrcDisconnected =
  "This gateway is not connected to IRC right now. Try again later.";

/** Route through the caller's own gateway, using a verified current nickname. */
export async function sendFleetPeerMessage(
  configuration: () => IrcConfig,
  client: Parameters<typeof sendFleetAssignment>[0] & {
    fold(value: string): string;
    inChannel(channel: string): boolean;
    verifiedNick(account: string): Promise<string>;
    recipientGuard(account: string, nick: string): () => boolean;
    readonly registered: boolean;
  },
  target: FleetTarget,
  input: PeerMessageInput,
  isOpen: () => boolean,
  signal: AbortSignal,
) {
  const account = client.fold(target.account);

  const channel =
    input.via === "ship"
      ? target.channel
      : configuration().fleetChannels?.command;

  const matches = (value: string, expected: string) =>
    value === "*" || client.fold(value) === expected;

  const permitted = () => {
    const { fleetPolicy, access } = effectiveIrcConfig(configuration());

    return (
      channel !== undefined &&
      isOpen() &&
      fleetPolicy?.role === "captain" &&
      fleetPolicy.agentAccounts.some((peer) => client.fold(peer) === account) &&
      access.peerCaptains.some((peer) => client.fold(peer) === account) &&
      (access.allowedAccounts?.some((peer) => matches(peer, account)) ??
        true) &&
      !access.deniedAccounts.some((peer) => matches(peer, account)) &&
      !access.deniedChannels.some((room) =>
        matches(room, client.fold(channel)),
      ) &&
      client.inChannel(channel)
    );
  };

  if (!channel || !permitted()) {
    throw new FleetError(
      "The configured captain or channel is unavailable for peer messages.",
    );
  }

  const nick = await client.verifiedNick(target.account).catch(() => {
    signal.throwIfAborted();

    /*
     * As in agent dispatch, a failure of this connection says nothing about the
     * recipient. verifiedNick rejects with IrcUnavailable only while this client
     * is unregistered: a new lookup is refused then, and a disconnect clears
     * registration before it rejects pending lookups. So reading registered
     * tells the two cases apart without importing the transport's error class
     * into this slice.
     */
    throw new FleetError(
      client.registered ? peerRecipientUnconfirmed : peerIrcDisconnected,
    );
  });

  if (/[@\s\p{Cc}]/u.test(nick)) {
    throw new FleetError(
      "The recipient does not have a supported current nick.",
    );
  }

  const holds = client.recipientGuard(target.account, nick);

  const address =
    client.fold(nick) === account ? `@${nick}` : `@${target.account} @${nick}`;

  await sendFleetAssignment(
    client,
    channel,
    `${address}: ${input.text}`,
    () => holds() && permitted(),
    signal,
  );

  return channel;
}
