import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { IrcConfig } from "../../../config";
import { type IrcClient, IrcUnavailable } from "../../../transports/irc/client";
import {
  type IrcMessage,
  fold,
  validMsgid,
} from "../../../transports/irc/protocol";
import {
  type CaptainRef,
  type DispatchAnswerInput,
  type DispatchEvent,
  type DispatchMessenger,
  UndeliverableIssue,
} from "./dispatcher";
import {
  type DispatchAnswer,
  type DispatchMarker,
  type IssueLabel,
  dispatchTag,
  dispatchText,
  dispatchTurnText,
  formatDispatchMarker,
  isMarkerIssue,
  parseDispatchMarker,
} from "./protocol";

type DispatchClient = Pick<
  IrcClient,
  | "waitReady"
  | "verifiedNick"
  | "hasCap"
  | "budget"
  | "publish"
  | "privmsg"
  | "send"
  | "inChannel"
  | "registered"
>;

const joinWaitMs = 10_000;

/** Cut text to at most `bytes` UTF-8 bytes on a code point boundary. */
function fitBytes(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) return text;
  let out = "";

  for (const character of text) {
    if (Buffer.byteLength(out + character) > bytes - 3) break;
    out += character;
  }

  return `${out}…`;
}

/**
 * IRC side of agent dispatch on the rear admiral's own connection: requests
 * to captains are PRIVMSGs in the command channel addressed by verified
 * nick, so people see them, with fixed text from the marker alone. The
 * issue title and status lines are NOTICEs, which wake no agent.
 */
export class IrcDispatchMessenger implements DispatchMessenger {
  private warnedTags = false;
  private joinWaitExpired = false;
  public constructor(
    private readonly client: DispatchClient,
    private readonly channel: string,
    private readonly allowed: () => boolean,
    private readonly log: Logger,
  ) {}

  private async ready(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.client.waitReady(joinWaitMs, signal);

    if (this.client.inChannel(this.channel)) {
      this.joinWaitExpired = false;

      return;
    }

    // The first poll races the channel JOIN after (re)connecting. Wait for it
    // Once; a channel that stays unjoined then fails fast until it is joined.
    if (!this.joinWaitExpired)
      for (let waited = 0; waited < joinWaitMs; waited += 100) {
        await delay(100, undefined, { signal });

        if (this.client.inChannel(this.channel)) return;
      }

    this.joinWaitExpired = true;
    throw new Error("Agent dispatch channel is not joined");
  }

  /**
   * The nick that the server proves holds the captain's account now, or
   * undefined when the captain is not online. A failure of this connection
   * is thrown: it says nothing about the captain.
   */
  private async nick(captain: CaptainRef) {
    try {
      return await this.client.verifiedNick(captain.account);
    } catch (error) {
      if (error instanceof IrcUnavailable || !this.client.registered)
        throw error;

      return;
    }
  }

  private tags(marker: DispatchMarker, replyTo?: string) {
    if (!this.client.hasCap("message-tags")) return {};
    const value = formatDispatchMarker(marker);

    if (!parseDispatchMarker(value)) return {};

    return {
      [dispatchTag]: value,
      ...(replyTo && validMsgid(replyTo) && { "+draft/reply": replyTo }),
    };
  }

  /** Cut to the line budget; titles shorten first, on code point boundaries. */
  private fit(
    command: "PRIVMSG" | "NOTICE",
    tags: Record<string, string>,
    build: (maxTitle: number) => string,
  ) {
    const budget = this.client.budget(command, this.channel, tags);

    for (const maxTitle of [120, 80, 48, 24, 12]) {
      const text = build(maxTitle);

      if (Buffer.byteLength(text) <= budget) return text;
    }

    return fitBytes(build(12), budget);
  }

  /**
   * The issue title for people, as a NOTICE after the request: a NOTICE
   * never starts a turn, so the user-editable title never reaches a
   * captain's agent. Best effort: the request is already sent, so a failure
   * here is logged (without the title) and neither fails nor repeats it.
   */
  private async title(issue: IssueLabel, replyTo: string | undefined) {
    try {
      const tags =
        replyTo && validMsgid(replyTo) && this.client.hasCap("message-tags")
          ? { "+draft/reply": replyTo }
          : {};

      const text = this.fit("NOTICE", tags, (max) =>
        dispatchText.title(issue, max),
      );

      await this.client.send(
        "NOTICE",
        [this.channel, text],
        tags,
        this.allowed,
      );
    } catch {
      this.log.warn(
        { issue: issue.identifier },
        "Agent dispatch issue title notice was not delivered",
      );
    }
  }

  /**
   * A request's marker names its issue, and the captain's turn is built from
   * that marker alone. An identifier the marker cannot carry is refused
   * before anything is sent: a request is never sent untagged.
   */
  private carried(issue: IssueLabel) {
    if (!isMarkerIssue(issue.identifier))
      throw new UndeliverableIssue(
        "Issue identifier cannot be carried in a dispatch marker",
      );
  }

  public async assigned(
    captain: CaptainRef,
    issue: IssueLabel,
    signal: AbortSignal,
  ) {
    this.carried(issue);
    await this.ready(signal);

    // Without message-tags the notice would go out untagged, so the
    // Captain's gateway could not tell it from an ordinary peer message.
    // Holding it (by throwing) retries it once the server supports tags.
    if (!this.client.hasCap("message-tags")) {
      if (!this.warnedTags)
        this.log.warn(
          "Agent dispatch requests need IRC message-tags and echo-message; requests are held",
        );
      this.warnedTags = true;
      throw new Error("IRC message-tags unavailable");
    }

    const nick = await this.nick(captain);

    if (!nick) return false;
    const tags = this.tags({ kind: "assigned", issue: issue.identifier });

    const text = fitBytes(
      dispatchText.assigned(nick, issue.identifier),
      this.client.budget("PRIVMSG", this.channel, tags),
    );

    await this.client.privmsg(this.channel, text, tags, this.allowed);
    await this.title(issue, undefined);

    return true;
  }

  public async offer(
    captain: CaptainRef,
    offer: { id: string; issue: IssueLabel; timeoutSeconds: number },
    signal: AbortSignal,
  ) {
    this.carried(offer.issue);
    await this.ready(signal);

    // Without both, no answer could ever be matched to this offer. Holding
    // The offer (by throwing) keeps captains and rounds for a working server.
    if (
      !this.client.hasCap("message-tags") ||
      !this.client.hasCap("echo-message")
    ) {
      if (!this.warnedTags)
        this.log.warn(
          "Agent dispatch offers need IRC message-tags and echo-message; offers are held",
        );
      this.warnedTags = true;
      throw new Error("IRC message-tags or echo-message unavailable");
    }

    const nick = await this.nick(captain);

    if (!nick) return;

    const tags = this.tags({
      kind: "offer",
      offerID: offer.id,
      issue: offer.issue.identifier,
    });

    const text = fitBytes(
      dispatchText.offer(
        nick,
        offer.id,
        offer.issue.identifier,
        offer.timeoutSeconds,
      ),
      this.client.budget("PRIVMSG", this.channel, tags),
    );

    // Answers reply to this PRIVMSG: the title NOTICE never carries the ID.
    const messageID = await this.client.publish(
      this.channel,
      text,
      tags,
      this.allowed,
    );

    await this.title(offer.issue, messageID);

    return { messageID };
  }

  public async announce(event: DispatchEvent, signal: AbortSignal) {
    await this.ready(signal);

    const marker: DispatchMarker | undefined =
      event.kind === "gave-up"
        ? { kind: "gave-up", issue: event.issue }
        : event.offerID
          ? { kind: event.kind, offerID: event.offerID }
          : undefined;

    const tags = marker ? this.tags(marker, event.replyTo) : {};

    const text = fitBytes(
      event.text,
      this.client.budget("NOTICE", this.channel, tags),
    );

    await this.client.send("NOTICE", [this.channel, text], tags, this.allowed);
  }
}

/**
 * A captain's answer as the rear admiral receives it, or undefined. The
 * account is the server's `account` tag; the dispatcher still checks that it
 * is the asked captain and that the reply names that offer's message.
 */
export function ircDispatchAnswer(
  message: IrcMessage,
  channel: string,
  now: number,
  caseFold: (value: string) => string = (value) => fold(value),
): DispatchAnswerInput | undefined {
  if (!["NOTICE", "PRIVMSG", "TAGMSG"].includes(message.command)) return;
  const marker = parseDispatchMarker(message.tags.get(dispatchTag));

  if (!marker || (marker.kind !== "accept" && marker.kind !== "decline"))
    return;
  const account = message.tags.get("account");

  if (!account || account === "*") return;

  if (caseFold(message.params[0] ?? "") !== caseFold(channel)) return;
  const reply = message.tags.get("+draft/reply") ?? message.tags.get("+reply");

  if (!validMsgid(reply)) return;
  const time = Date.parse(message.tags.get("time") ?? "");

  return {
    account,
    offerID: marker.offerID,
    answer: marker.kind,
    replyTo: reply,
    at: Number.isFinite(time) ? time : now,
  };
}

/** A message carrying a request marker; who sent it is checked separately. */
export function isDispatchRequest(message: IrcMessage) {
  if (message.command !== "PRIVMSG") return false;
  const marker = parseDispatchMarker(message.tags.get(dispatchTag));

  return marker?.kind === "offer" || marker?.kind === "assigned";
}

/**
 * Whether `account` (the server's `account` tag) is this captain's rear
 * admiral: an enrolled fleet agent (`fleetPolicy.agentAccounts`) that is
 * also a `fleetControl.targets` entry with `role: "rear_admiral"`. Only
 * that account's requests pass the peer turn limit or record an offer;
 * a marker from any other agent is an ordinary peer message.
 */
export function isRearAdmiral(
  config: Pick<IrcConfig, "fleetPolicy" | "fleetControl">,
  account: string,
  caseFold: (value: string) => string,
) {
  const policy = config.fleetPolicy;

  if (policy?.role !== "captain") return false;
  const key = caseFold(account);

  return (
    policy.agentAccounts.some((agent) => caseFold(agent) === key) &&
    !!config.fleetControl?.targets.some(
      (target) =>
        target.role === "rear_admiral" && caseFold(target.account) === key,
    )
  );
}

/**
 * The agent turn for a rear admiral request, or undefined when the message
 * carries no request marker. Only the leading address of the admitted text
 * is kept, so intake rechecks see the same recipient; the rest is fixed text
 * from the marker. The issue title, which anyone who can edit the issue
 * controls, never reaches the turn. Call only for a verified rear admiral.
 */
export function dispatchRequestTurn(
  message: IrcMessage,
  admittedText: string,
): string | undefined {
  if (message.command !== "PRIVMSG") return;
  const marker = parseDispatchMarker(message.tags.get(dispatchTag));
  const address = /^@[^\s:,]+[:,] ?/.exec(admittedText)?.[0] ?? "";

  if (marker?.kind === "assigned")
    return `${address}${dispatchTurnText(marker.issue)}`;

  if (marker?.kind === "offer")
    return `${address}${dispatchTurnText(marker.issue, marker.offerID)}`;

  return;
}

/** An offer addressed to this captain, as recorded for the answer tool. */
export function ircDispatchOffer(message: IrcMessage) {
  if (message.command !== "PRIVMSG") return;
  const marker = parseDispatchMarker(message.tags.get(dispatchTag));
  const messageID = message.tags.get("msgid");

  if (marker?.kind !== "offer" || !validMsgid(messageID)) return;

  return { offerID: marker.offerID, messageID };
}

/** The captain's answer: a NOTICE that replies to the offer, from its own account. */
export async function sendDispatchAnswer(
  client: Pick<IrcClient, "waitReady" | "hasCap" | "budget" | "send">,
  offer: { offerID: string; channel: string; messageID: string },
  answer: DispatchAnswer,
  reason: string | undefined,
  allowed: () => boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await client.waitReady(10_000, signal);

  if (!client.hasCap("message-tags"))
    throw new Error("IRC message tags unavailable");

  const tags = {
    "+draft/reply": offer.messageID,
    [dispatchTag]: formatDispatchMarker({
      kind: answer,
      offerID: offer.offerID,
    }),
  };

  const text = fitBytes(
    dispatchText.answer(answer, offer.offerID, reason),
    client.budget("NOTICE", offer.channel, tags),
  );

  signal.throwIfAborted();
  await client.send("NOTICE", [offer.channel, text], tags, allowed);
}
