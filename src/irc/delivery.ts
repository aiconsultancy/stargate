import type { SlackDelivery } from "../gateway";
import type { ReactionName } from "../reactions";
import type { IrcClient } from "./client";
import { isIrcChannel, validMsgid } from "./routing";
import { ircLines, plainText } from "./text";

/** IRCv3 `+draft/react` values for the gateway's reaction names. */
const emoji: Record<ReactionName, string> = {
  eyes: "👀",
  thumbsup: "👍",
  heart: "❤️",
  tada: "🎉",
  white_check_mark: "✅",
  thinking_face: "🤔",
  pray: "🙏",
  joy: "😂",
};

/**
 * Gateway delivery over one IRC connection. A stored reply chunk becomes
 * plain-text lines that fit 512 bytes; the first line replies to the
 * request's message ID. Each line waits for the server's labeled echo when
 * labeled-response is available. A failure throws, so the gateway retries
 * the chunk later without rerunning the agent. IRC cannot edit or delete,
 * so there are no previews, streaming updates or Stop buttons.
 */
export class IrcDelivery implements SlackDelivery {
  constructor(
    private readonly client: IrcClient,
    /** Wait for a reconnect before a delivery attempt fails. */
    private readonly readyMs = 30_000,
  ) {}

  /**
   * Channel, or the nick that WHOIS proves holds the direct-message account
   * right now. Throws (and the gateway retries) when no nick does.
   */
  private target(channel: string) {
    return isIrcChannel(channel)
      ? Promise.resolve(channel)
      : this.client.verifiedNick(channel);
  }

  /**
   * For a direct reply: true while the verified nick still holds the
   * recipient account. Checked when a line is queued and again at the
   * socket write, so a QUIT or NICK seen meanwhile drops the line; the
   * stored reply stays for the gateway's retry.
   */
  private guard(channel: string, target: string) {
    return isIrcChannel(channel)
      ? undefined
      : () => this.client.holds(channel, target);
  }

  private reply(thread: string): Record<string, string> {
    return this.client.hasCap("message-tags") && validMsgid(thread)
      ? { "+draft/reply": thread }
      : {};
  }

  async post(channel: string, thread: string, text: string) {
    await this.client.waitReady(this.readyMs);
    const target = await this.target(channel);
    const reply = this.reply(thread);
    const lines = ircLines(
      plainText(text),
      this.client.budget("PRIVMSG", target, reply),
    );
    // greybeard: a nick that changes hands without a QUIT/NICK/ACCOUNT we
    // can see (no shared channel) after WHOIS is not detected for the
    // lines of this chunk; each delivery attempt revalidates with WHOIS.
    const guard = this.guard(channel, target);
    for (const [index, line] of lines.entries())
      await this.client.privmsg(target, line, index === 0 ? reply : {}, guard);
  }

  async react(channel: string, ts: string, name: ReactionName) {
    await this.client.waitReady(this.readyMs);
    const reply = this.reply(ts);
    if (!("+draft/reply" in reply))
      throw new Error("IRC reactions need message tags");
    const target = await this.target(channel);
    await this.client.tagmsg(
      target,
      { ...reply, "+draft/react": emoji[name] },
      this.guard(channel, target),
    );
  }
}
