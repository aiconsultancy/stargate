import { createHash } from "node:crypto";
import type { IrcConfig } from "../config";
import { findMention } from "../mentions";
import { peerTurnsPerHour } from "../peers";
import type { Incoming, Job } from "../store";
import { cleanText, fold, type IrcMessage } from "./protocol";

/** One IRC connection of a ship: its captain or one crew member. */
export type IrcMember = {
  /** Registration ID: `<irc id>` or `<irc id>-<crew id>`. */
  id: string;
  role: "captain" | "crew";
  account: string;
  /** Configured nick; the server may hold a fallback for a while. */
  nick: string;
  /** The only channels this connection joins and answers in. */
  channels: readonly string[];
  /** Queue, session and outbox namespace. */
  key: string;
};

export type IrcAdmission = Incoming & {
  received: number;
  sender?: "captain" | "crew";
};

export type IrcRouteContext = {
  config: IrcConfig;
  member: IrcMember;
  currentNick: string;
  /** True for a message ID that this connection sent. */
  sent(msgid: string): boolean;
  now(): number;
  /** Case folding under the server's CASEMAPPING. */
  fold(value: string): string;
};

/** Case folding for names: the server's CASEMAPPING, rfc1459 by default. */
export type Fold = (value: string) => string;
const rfc1459: Fold = (value) => fold(value);

const nickCharacters = "A-Za-z0-9\\[\\]\\\\`_^{|}\\-";

/** Channel names start with `#` or `&`; accounts and nicks never do. */
export function isIrcChannel(target: string) {
  return target.startsWith("#") || target.startsWith("&");
}

/** Message IDs used in tags and event IDs: printable ASCII, bounded. */
export function validMsgid(value: string | undefined): value is string {
  return value !== undefined && /^[!-~]{1,128}$/.test(value);
}

/** Folded accounts of this ship: the captain and every crew member. */
export function shipAccounts(config: IrcConfig, caseFold: Fold = rfc1459) {
  return new Set(
    [config.account, ...config.crew.map((member) => member.account)].map(
      caseFold,
    ),
  );
}

function listed(rules: readonly string[], value: string, caseFold: Fold) {
  const key = caseFold(value);
  return rules.some((rule) => rule === "*" || caseFold(rule) === key);
}

/**
 * Access rechecked before work and delivery. Any SASL account may write
 * unless denied. Channels must be this member's configured channels. Direct
 * messages reach only the captain; `deniedChannels: ["*"]` blocks them too.
 * Crew channels must also be captain channels. Every name compares under
 * the server's case folding.
 */
export function ircAllowed(
  config: IrcConfig,
  member: Pick<IrcMember, "role" | "channels">,
  account: string,
  channel: string,
  caseFold: Fold = rfc1459,
) {
  const access = config.access;
  if (listed(access.deniedAccounts, account, caseFold)) return false;
  if (!isIrcChannel(channel))
    return member.role === "captain" && !access.deniedChannels.includes("*");
  const key = caseFold(channel);
  return (
    member.channels.some((name) => caseFold(name) === key) &&
    (member.role === "captain" ||
      config.channels.some((name) => caseFold(name) === key)) &&
    !listed(access.deniedChannels, channel, caseFold)
  );
}

function mentions(text: string, nick: string) {
  const escaped = nick.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(
    `(?<![${nickCharacters}])${escaped}(?![${nickCharacters}])`,
    "i",
  ).test(text);
}

/** `nick: text` or `nick, text` addresses the bot; keep only the text. */
function withoutAddress(
  text: string,
  nicks: readonly string[],
  caseFold: Fold,
) {
  for (const nick of nicks) {
    const prefix = text.slice(0, nick.length);
    if (
      caseFold(prefix) === caseFold(nick) &&
      /^[:,]\s*/.test(text.slice(nick.length))
    )
      return text.slice(nick.length).replace(/^[:,]\s*/, "");
  }
  return text;
}

/**
 * Admission for one received IRC message, or undefined. Identity is the
 * IRCv3 `account` tag, never the nick: a message without it is rejected.
 * The connection's own account (its echoes, other sessions of the same
 * account) is never admitted. Channels need a nick mention, a configured
 * text mention (captain only) or a `+draft/reply` to this connection's own
 * message; direct messages to the captain always start a turn. NOTICE,
 * TAGMSG and CTCP never start one. Turn limits are applied by the caller.
 * Channel and account keys are folded, so every spelling of a channel
 * shares one conversation and one turn limit.
 */
export function routeIrcMessage(
  message: IrcMessage,
  context: IrcRouteContext,
): IrcAdmission | undefined {
  const { config, member } = context;
  const caseFold = context.fold;
  if (message.command !== "PRIVMSG") return;
  const account = message.tags.get("account");
  if (!account || account === "*") return;
  const user = caseFold(account);
  if (user === caseFold(member.account)) return;
  const [target = "", raw = ""] = message.params;
  if (raw.startsWith("\u0001")) return;
  const direct = !isIrcChannel(target);
  if (direct && caseFold(target) !== caseFold(context.currentNick)) return;
  const channel = caseFold(direct ? account : target);
  if (!ircAllowed(config, member, user, channel, caseFold)) return;
  const body = cleanText(raw).trim();
  const nicks = [...new Set([context.currentNick, member.nick])];
  const mentioned = nicks.some((nick) =>
    mentions(caseFold(body), caseFold(nick)),
  );
  const reply = message.tags.get("+draft/reply") ?? message.tags.get("+reply");
  const replied = validMsgid(reply) && context.sent(reply);
  const textRule = config.access.textMentions;
  const named =
    !direct && !mentioned && !replied && member.role === "captain" && textRule
      ? findMention([body], textRule)
      : undefined;
  if (!direct && !mentioned && !replied && named === undefined) return;
  const text = withoutAddress(body, nicks, caseFold).trim();
  if (!text) return;
  const ship = shipAccounts(config, caseFold);
  const sender = ship.has(user)
    ? ("crew" as const)
    : config.access.peerCaptains.some((peer) => caseFold(peer) === user)
      ? ("captain" as const)
      : undefined;
  const time = Date.parse(message.tags.get("time") ?? "");
  const received = Number.isFinite(time) ? time : context.now();
  const tagged = message.tags.get("msgid");
  const msgid = validMsgid(tagged)
    ? tagged
    : `pogo-${createHash("sha256")
        .update(JSON.stringify([received, user, target, raw]))
        .digest("hex")
        .slice(0, 32)}`;
  return {
    eventId: `${channel}:${msgid}`,
    botKey: member.key,
    conversation: JSON.stringify([member.key, channel]),
    channel,
    thread: msgid,
    user,
    text,
    received,
    ...(sender ? { sender } : {}),
    ...(named ? { textMention: named } : {}),
  };
}

/** Rolling-hour turn limits for one admission. */
export type IrcLimits = {
  /** Every registration key of this ship: crew limits are per ship channel. */
  shipKeys: readonly string[];
  count(input: {
    botKeys: readonly string[];
    sender: "captain" | "crew";
    since: number;
    scope: { conversation: string } | { channel: string };
  }): number;
};

export const ircWindowMs = 60 * 60_000;

/**
 * Peer captains: at most five messages per conversation (channel or direct
 * message) in a rolling hour. Ship accounts (captain and crew): at most
 * `crewTurnsPerHour` messages per channel across the whole ship.
 */
export function withinLimits(
  admission: IrcAdmission,
  config: IrcConfig,
  limits: IrcLimits,
) {
  const since = admission.received - ircWindowMs;
  if (admission.sender === "captain")
    return (
      limits.count({
        botKeys: [admission.botKey],
        sender: "captain",
        since,
        scope: { conversation: admission.conversation },
      }) < peerTurnsPerHour
    );
  if (admission.sender === "crew")
    return (
      limits.count({
        botKeys: limits.shipKeys,
        sender: "crew",
        since,
        scope: { channel: admission.channel },
      }) < config.access.crewTurnsPerHour
    );
  return true;
}

/** Prompt prefix for sessions without a source line (crew and Pi). */
export function ircNote(job: Pick<Job, "channel" | "user" | "sender">) {
  const where = isIrcChannel(job.channel) ? job.channel : "a direct message";
  const who =
    job.sender === "crew"
      ? `${job.user}, an account of this ship (captain or crew). Reply only if the message needs your action; answer [[pogo:silent]] to acknowledgements and thanks`
      : job.sender === "captain"
        ? `${job.user}, another fleet captain's bot, not an operator`
        : job.user;
  return `[IRC ${where}, from account ${who}. IRC shows plain text only.]`;
}

/** Persistent captain instructions, never a per-message user prefix. */
export const ircInstructions = `IRC messages:
A source line that starts with s=irc came from the fleet IRC network, not
Slack. c is the channel (percent-encoded, for example %23galactica) or, for a
direct message, the sender's account; t and m are IRC message IDs; u is the
sender's SASL account, which is the identity, never the nick. IRC shows plain
text only: write short paragraphs and lists, no tables or headings. ;k=captain
marks another fleet captain (peer rules apply). ;k=crew marks this ship's own
crew account in a shared channel: answer only when the message needs your
action, and answer acknowledgements with [[pogo:silent]]. Pogo admits only a
few ship messages per channel per hour, so keep crew exchanges short.`;
