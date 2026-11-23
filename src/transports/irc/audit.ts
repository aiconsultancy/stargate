import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import { containsCredential } from "../../lib/credentials";
import {
  type IrcClient,
  IrcSendExpired,
  IrcUnavailable,
  Recent,
} from "./client";
import { packBatches } from "./delivery";
import { cleanText, fold, ircParts } from "./protocol";
import { ircLines } from "./text";

/** One direct message that a ship connection received or sent. */
export type DmEvent = {
  direction: "in" | "out";
  /** Account of the ship connection (captain or crew). */
  agent: string;
  /**
   * The other party: its nick, and its account (`null`: not logged in;
   * absent: not known).
   */
  peer: { nick: string; account?: string | null };
  text: string;
  /** Server time of a message that catch-up replayed. */
  replayed?: string;
};

const withheld = "[not mirrored: may contain credentials]";

/**
 * A CTCP message (`\x01VERB args\x01`): its upper-case verb and text, or
 * undefined for ordinary text.
 */
export function ctcp(text: string) {
  if (!text.startsWith("\u0001")) return;
  const body = text.endsWith("\u0001") ? text.slice(1, -1) : text.slice(1);
  const space = body.indexOf(" ");

  return {
    verb: (space === -1 ? body : body.slice(0, space)).toUpperCase(),
    text: space === -1 ? "" : body.slice(space + 1),
  };
}

/** NickServ, ChanServ, any other *Serv, and bouncer modules like *status. */
export function serviceNick(nick: string) {
  return /serv$/i.test(nick) || nick.startsWith("*");
}

/**
 * Lines that look like services traffic typed into a direct message: a
 * command that carries a password (`identify hunter2`, optionally after
 * `/msg <nick>`), a message to a *Serv (`/msg NickServ …`, `nickserv …`)
 * or a services alias (`/ns …`, `/cs …`).
 */
const serviceLines = [
  /^\s*(?:\/?msg\s+\S+\s+)?(?:identify|register|login|ghost|regain|recover|passwd|saregister|sapasswd|set\s+pass(?:word)?)\s+\S/i,
  /^\s*\/?(?:msg|query|notice)\s+\S*serv\s/i,
  /^\s*\/?[a-z]*serv\s+\S/i,
  /^\s*\/(?:ns|cs|hs|ms|os|bs)\s+\S/i,
];

/**
 * The lines a check reads: each line without control characters and IRC
 * formatting, and each part that follows a CTCP delimiter (`\x01`), with
 * and without its leading verb, so `\x01ACTION identify secret\x01` (or
 * any other wrapper, anywhere in a line) cannot hide a command.
 */
function checkedLines(text: string) {
  return text.split("\n").flatMap((line) => [
    cleanText(line),
    ...line
      .split("\u0001")
      .slice(1)
      .flatMap((part) => {
        const body = cleanText(part).trimStart();
        const verb = /^[A-Za-z]+(?:\s+|$)/.exec(body)?.[0];

        return verb ? [body, body.slice(verb.length)] : [body];
      }),
  ]);
}

/**
 * True when any line, or any CTCP part of one, may carry a credential or
 * services command; the whole entry is then withheld, never a part of it.
 * Takes the raw text: callers never check text after unwrapping it.
 */
export function sensitive(text: string) {
  const lines = checkedLines(text);

  return (
    containsCredential(text) ||
    containsCredential(lines.join("\n")) ||
    lines.some((line) => serviceLines.some((pattern) => pattern.test(line)))
  );
}

function name(peer: DmEvent["peer"]) {
  const nick = cleanText(peer.nick);

  if (peer.account === null) return `${nick} (no account)`;

  if (peer.account === undefined || fold(peer.account) === fold(peer.nick))
    return nick;

  return `${nick} (${cleanText(peer.account)})`;
}

/**
 * The audit line for one direct message, or undefined when it is not
 * mirrored: service traffic and CTCP other than ACTION. Text loses IRC
 * formatting and control characters; when any line may carry a credential
 * or a services command, the whole text is withheld. `[dm] from → to: text`, `[dm] * from text (→ to)`
 * for ACTION, and `[dm <time>]` for a replayed message.
 */
export function auditLine(event: DmEvent): string | undefined {
  if (serviceNick(event.peer.nick)) return;
  const command = ctcp(event.text);

  if (command && command.verb !== "ACTION") return;
  const action = command !== undefined;
  const text = command ? command.text : event.text;

  const clean = text
    .split("\n")
    .map((item) => cleanText(item))
    .join("\n")
    .trim();

  if (!clean) return;
  const shown = sensitive(event.text) || sensitive(clean) ? withheld : clean;
  const peer = name(event.peer);
  const agent = cleanText(event.agent);
  const [from, to] = event.direction === "in" ? [peer, agent] : [agent, peer];
  const at = event.replayed === undefined ? NaN : Date.parse(event.replayed);

  const tag = Number.isFinite(at)
    ? `[dm ${new Date(at).toISOString().slice(0, 16)}Z]`
    : "[dm]";

  return action
    ? `${tag} * ${from} ${shown} (→ ${to})`
    : `${tag} ${from} → ${to}: ${shown}`;
}

/** Drop reports at most this often; a final one comes at shutdown. */
const reportMs = 10_000;

/** A lost connection retries the same line this often before dropping it. */
const reconnectRetries = 3;

/**
 * Posts DM audit lines to one channel over the captain connection, one
 * entry at a time and in order. Entries use the connection's low-priority
 * send lane, so replies and other traffic always go first. `record` only
 * queues and never throws, so a mirror never delays or blocks the message
 * it copies. A full queue drops the new entry and counts it; so does an
 * entry that expires in the send queue (the client removes it, so at most
 * one entry is ever in the client's queue). A refused or unconfirmed post
 * drops that entry. Logs carry counts, never text.
 */
export class IrcAudit {
  private readonly queue: string[] = [];
  /** Message IDs already mirrored, per agent: replays and duplicates. */
  private readonly seen = new Recent(4096);
  private wake: (() => void) | undefined;
  private dropped = 0;
  private reported = 0;
  private lastReport = 0;
  private failed = 0;

  public constructor(
    private readonly client: IrcClient,
    public readonly channel: string,
    private readonly log: Logger,
    private readonly limit = 256,
  ) {}

  /** Queue the audit line for one DM; false when skipped or dropped. */
  public record(event: DmEvent, msgid?: string) {
    try {
      if (msgid !== undefined) {
        const key = `${fold(event.agent)} ${msgid}`;

        if (this.seen.has(key)) return false;
        this.seen.set(key, true);
      }

      const line = auditLine(event);

      if (line === undefined) return false;

      if (this.queue.length >= this.limit) {
        this.dropped++;
        this.report(false);

        return false;
      }

      this.queue.push(line);
      this.wake?.();

      return true;
    } catch {
      this.log.warn("IRC DM audit entry failed");

      return false;
    }
  }

  /** Post queued entries until `signal` aborts; then report what is left. */
  public async run(signal: AbortSignal) {
    let retries = 0;

    while (!signal.aborted) {
      const line = this.queue[0];

      if (line === undefined) {
        await this.idle(signal);
        continue;
      }

      try {
        await this.ready(signal);
        await this.post(line);
        this.queue.shift();
        retries = 0;
      } catch (error) {
        if (signal.aborted) break;

        // Lost before the write: post the same entry after the reconnect.
        if (error instanceof IrcUnavailable && ++retries <= reconnectRetries)
          continue;
        this.queue.shift();
        retries = 0;

        // Expired in the send queue behind other traffic: never written, so
        // It counts as dropped, like an entry the full queue refused.
        if (error instanceof IrcSendExpired) {
          this.dropped++;
          this.report(false);
          continue;
        }

        this.failed++;
        this.log.warn({ failed: this.failed }, "IRC DM audit line not posted");
      }
    }

    this.report(true);

    if (this.queue.length > 0)
      this.log.warn(
        { pending: this.queue.length },
        "IRC DM audit lines not posted at shutdown",
      );
    this.queue.length = 0;
  }

  private report(force: boolean) {
    if (this.dropped === this.reported) return;
    const now = Date.now();

    if (!force && now - this.lastReport < reportMs) return;
    this.lastReport = now;
    this.reported = this.dropped;
    this.log.warn(
      { dropped: this.dropped, limit: this.limit },
      "IRC DM audit lines dropped (queue full or expired before sending)",
    );
  }

  private idle(signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.wake = undefined;
        signal.removeEventListener("abort", done);
        resolve();
      };

      this.wake = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Registered and in the audit channel; waits through reconnects. */
  private async ready(signal: AbortSignal) {
    while (!(this.client.registered && this.client.inChannel(this.channel))) {
      signal.throwIfAborted();
      await delay(250, undefined, { signal });
    }
  }

  /**
   * One entry: a single line as one PRIVMSG; several lines as one
   * draft/multiline batch when offered (more only past max-bytes or
   * max-lines), otherwise as lines split like replies.
   */
  private async post(line: string) {
    const { client, channel } = this;
    const limits = client.multiline;

    if (limits) {
      const budget = Math.min(
        limits.maxBytes,
        client.budget("PRIVMSG", channel, {
          batch: `stargate${"9".repeat(12)}`,
          "draft/multiline-concat": "",
        }),
      );

      const parts = line
        .split("\n")
        .map((text) => text.trimEnd())
        .filter((text) => text.trim())
        .flatMap((text) =>
          ircParts(text, budget).map((piece, index) => ({
            text: piece,
            concat: index > 0,
          })),
        );

      if (parts.length > 1) {
        for (const unit of packBatches(parts, limits))
          await client.sendBatch(channel, unit.lines, {}, undefined, "low");

        return;
      }
    }

    for (const text of ircLines(line, client.budget("PRIVMSG", channel, {})))
      await client.privmsg(channel, text, {}, undefined, "low");
  }
}
