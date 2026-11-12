import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "bun";
import type { Logger } from "pino";
import {
  type Casemapping,
  casemapping,
  fold,
  formatMessage,
  type IrcMessage,
  lineBytes,
  maxReceivedBytes,
  parseCapabilities,
  parseMessage,
  sourceNick,
  tagBytes,
  utf8Bytes,
} from "./protocol";

export type IrcTiming = {
  /** Idle time before the client sends its own PING. */
  pingMs: number;
  /** No data for this long closes the connection and reconnects. */
  timeoutMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** Wait after a refused SASL login or a server without required caps. */
  refusedMs: number;
  /** Retry interval for the configured nick and for missing channels. */
  reclaimMs: number;
  /** Wait for a labeled response before a send counts as failed. */
  confirmMs: number;
  /** Lines sent at once, then one line per interval. */
  burst: number;
  intervalMs: number;
  /** CAP, SASL and welcome must finish within this time. */
  registerMs: number;
};

export const defaultTiming: IrcTiming = {
  pingMs: 60_000,
  timeoutMs: 150_000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 120_000,
  refusedMs: 300_000,
  reclaimMs: 30_000,
  confirmMs: 20_000,
  burst: 4,
  intervalMs: 600,
  registerMs: 30_000,
};

export type IrcClientOptions = {
  host: string;
  port: number;
  tls: boolean;
  /** PEM of a private CA; system roots otherwise. */
  ca?: string;
  account: string;
  password: string;
  nick: string;
  /** The only channels this connection may ever join. */
  channels: readonly string[];
  /** Expected ISUPPORT NETWORK name; another name is refused. */
  network?: string;
  /**
   * Crew only: the captain's channels. A channel counts as allowed only when
   * it is also one of these under the server's CASEMAPPING.
   */
  captainChannels?: readonly string[];
  log: Logger;
  timing?: Partial<IrcTiming>;
};

export interface IrcEvents {
  /** PRIVMSG/NOTICE/TAGMSG, including own echoes. `replay`: chathistory. */
  message?(message: IrcMessage, replay: boolean): void;
  /** An INVITE addressed to this connection. */
  invite?(channel: string): void;
  joinFailed?(channel: string, numeric: string): void;
}

/** The connection is not registered; the caller retries later. */
export class IrcUnavailable extends Error {
  constructor() {
    super("IRC connection unavailable");
  }
}

/** Required for access decisions: no account tag means no admission. */
const required = ["sasl", "account-tag"];
const optional = [
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
  "account-notify",
  "extended-join",
];
const chathistoryCaps = ["draft/chathistory", "chathistory"];

type Pending = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  failed?: boolean;
};
type Queued = {
  line: string;
  done?: (error?: Error) => void;
  /** Checked at the socket write; false drops the line. */
  guard?: () => boolean;
};

/** A direct message whose recipient no longer holds the target nick. */
export class IrcRecipientChanged extends Error {
  constructor() {
    super("IRC recipient changed before delivery");
  }
}

/** Insertion-ordered set with a size bound. */
class Recent<V = true> extends Map<string, V> {
  constructor(private readonly limit: number) {
    super();
  }
  override set(key: string, value: V) {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.limit) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) super.delete(oldest);
    }
    return this;
  }
}

/**
 * One IRCv3 client connection with reconnect. Owns CAP negotiation, SASL
 * PLAIN, keepalive, nick reclaim, the channel allowlist, send throttling and
 * labeled-response delivery confirmation. Never logs message text or
 * credentials.
 */
export class IrcClient {
  private readonly timing: IrcTiming;
  private mapping: Casemapping = "rfc1459";
  private socket: Socket<undefined> | undefined;
  private generation = 0;
  private caps = new Set<string>();
  private currentNick: string;
  private registeredNow = false;
  /** 001 seen; readiness waits for the end of the registration burst. */
  private welcomed = false;
  private networkName: string | undefined;
  private userhost: string | undefined;
  private chantypes = "#&";
  private readonly joinedChannels = new Set<string>();
  /**
   * Account ↔ nick hints from account tags, extended-join and
   * account-notify, both directions kept consistent. A hint is only a
   * candidate: direct messages revalidate it with WHOIS before sending.
   */
  private readonly accountNicks = new Recent<string>(4096);
  private readonly nickAccounts = new Recent<string>(4096);
  private readonly whois = new Map<
    string,
    {
      account?: string;
      result: PromiseWithResolvers<string | undefined>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly own = new Recent(1024);
  private readonly lastSeen = new Map<string, string>();
  private readonly labels = new Map<string, Pending>();
  private readonly labelBatches = new Map<string, string>();
  private readonly replayBatches = new Set<string>();
  private queue: Queued[] = [];
  private tokens: number;
  private refilled = Date.now();
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private output: Uint8Array | undefined;
  private label = 0;
  private waiters = new Set<() => void>();
  private lastData = 0;
  private lastPing = 0;

  constructor(
    private readonly options: IrcClientOptions,
    private readonly events: IrcEvents = {},
  ) {
    this.timing = { ...defaultTiming, ...options.timing };
    this.tokens = this.timing.burst;
    this.currentNick = options.nick;
  }

  /** Case folding under the server's CASEMAPPING (rfc1459 until known). */
  readonly fold = (value: string) => fold(value, this.mapping);

  get nick() {
    return this.currentNick;
  }
  get account() {
    return this.options.account;
  }
  get registered() {
    return this.registeredNow;
  }
  hasCap(name: string) {
    return this.caps.has(name);
  }
  isChannel(target: string) {
    return target !== "" && this.chantypes.includes(target[0] ?? "");
  }
  /** Configured spelling of an allowed channel, or undefined. */
  channel(name: string) {
    const key = this.fold(name);
    const granted = this.options.captainChannels;
    if (granted && !granted.some((channel) => this.fold(channel) === key))
      return;
    return this.options.channels.find((channel) => this.fold(channel) === key);
  }
  inChannel(name: string) {
    const channel = this.channel(name);
    return channel !== undefined && this.joinedChannels.has(channel);
  }
  /** A message ID that this connection sent (from its echo). */
  sent(msgid: string) {
    return this.own.has(msgid);
  }
  /** The nick bound to an account in both directions, if any. */
  boundNick(account: string) {
    const key = this.fold(account);
    const nick = this.accountNicks.get(key);
    const holder = nick && this.nickAccounts.get(this.fold(nick));
    return holder !== undefined && this.fold(holder) === key ? nick : undefined;
  }

  /**
   * A nick that WHOIS proves is logged in to `account` now: the bound nick,
   * then the account name (Ergo keeps nick = account). Never a nick whose
   * account is unknown or different; throws when no candidate holds it.
   */
  async verifiedNick(account: string) {
    const key = this.fold(account);
    const candidates: string[] = [];
    for (const nick of [this.boundNick(account), account])
      if (
        nick !== undefined &&
        !candidates.some((other) => this.fold(other) === this.fold(nick))
      )
        candidates.push(nick);
    for (const nick of candidates) {
      const holder = await this.accountOf(nick);
      if (holder !== undefined && this.fold(holder) === key) {
        this.bind(holder, nick);
        return nick;
      }
      if (holder === undefined) this.unbindNick(nick);
      else this.bind(holder, nick);
    }
    throw new Error("IRC recipient is not online under that account");
  }

  /** The account a nick is logged in to now (WHOIS 330), or undefined. */
  private accountOf(nick: string): Promise<string | undefined> {
    if (!this.registeredNow || !this.socket)
      return Promise.reject(new IrcUnavailable());
    const key = this.fold(nick);
    const pending = this.whois.get(key);
    if (pending) return pending.result.promise;
    const result = Promise.withResolvers<string | undefined>();
    const timer = setTimeout(() => {
      this.whois.delete(key);
      result.reject(new Error("IRC account lookup timed out"));
    }, this.timing.confirmMs);
    this.whois.set(key, { result, timer });
    this.enqueue({
      line: formatMessage("WHOIS", [nick]),
      done: (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.whois.delete(key);
        result.reject(error);
      },
    });
    return result.promise;
  }

  private whoisEnd(nick: string, found: boolean) {
    const key = this.fold(nick);
    const pending = this.whois.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.whois.delete(key);
    pending.result.resolve(found ? pending.account : undefined);
  }

  /** UTF-8 bytes left for message text to `target` with these tags. */
  budget(command: string, target: string, tags: Record<string, string>) {
    // Our own line carries client tags; the relayed copy carries our source.
    // greybeard: both are subtracted, so text fits either framing within
    // 512 bytes. An unknown user@host assumes 16 + 63 characters.
    const label = this.caps.has("labeled-response")
      ? { label: `pogo${"9".repeat(12)}` }
      : {};
    const source = `:${this.currentNick}!${this.userhost ?? `${"u".repeat(16)}@${"h".repeat(63)}`} `;
    return (
      lineBytes -
      tagBytes({ ...label, ...tags }) -
      utf8Bytes(source) -
      utf8Bytes(`${command} ${target} :`)
    );
  }

  /** Resolve once registered; reject after `timeoutMs`. */
  async waitReady(timeoutMs: number, signal?: AbortSignal) {
    if (this.registeredNow) return;
    const ready = Promise.withResolvers<void>();
    const wake = () => ready.resolve();
    const fail = () => ready.reject(new IrcUnavailable());
    this.waiters.add(wake);
    const timer = setTimeout(fail, timeoutMs);
    signal?.addEventListener("abort", fail, { once: true });
    try {
      await ready.promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      this.waiters.delete(wake);
    }
  }

  privmsg(
    target: string,
    text: string,
    tags: Record<string, string> = {},
    guard?: () => boolean,
  ) {
    return this.send("PRIVMSG", [target, text], tags, guard);
  }

  tagmsg(target: string, tags: Record<string, string>, guard?: () => boolean) {
    if (!this.caps.has("message-tags"))
      return Promise.reject(new Error("IRC message tags unavailable"));
    return this.send("TAGMSG", [target], tags, guard);
  }

  /** True while `nick` is bound to `account` in both directions. */
  holds(account: string, nick: string) {
    const bound = this.boundNick(account);
    return bound !== undefined && this.fold(bound) === this.fold(nick);
  }

  /** Join an allowed channel; anything else is refused. */
  join(name: string) {
    const channel = this.channel(name);
    if (!channel || !this.registeredNow) return false;
    this.enqueue({ line: formatMessage("JOIN", [channel]) });
    return true;
  }

  /** Invite a nick to a channel this connection is in. */
  invite(nick: string, name: string) {
    const channel = this.channel(name);
    if (!channel || !this.inChannel(channel))
      return Promise.reject(new Error("Not in that IRC channel"));
    return this.send("INVITE", [nick, channel]);
  }

  /**
   * Throttled send. With labeled-response, resolves on the server's labeled
   * echo/ACK and rejects on a labeled error. Without it, resolves once the
   * line is written to the socket. `guard` runs again at the socket write,
   * after the throttle wait; when it fails the line is dropped and the send
   * rejects with IrcRecipientChanged.
   */
  send(
    command: string,
    params: readonly string[],
    tags: Record<string, string> = {},
    guard?: () => boolean,
  ): Promise<void> {
    if (!this.registeredNow || !this.socket)
      return Promise.reject(new IrcUnavailable());
    const result = Promise.withResolvers<void>();
    try {
      if (this.caps.has("labeled-response")) {
        const label = `pogo${++this.label}`;
        const line = formatMessage(command, params, { label, ...tags });
        const timer = setTimeout(() => {
          this.labels.delete(label);
          result.reject(new Error("IRC delivery unconfirmed"));
        }, this.timing.confirmMs);
        this.labels.set(label, {
          resolve: result.resolve,
          reject: result.reject,
          timer,
        });
        this.enqueue({
          line,
          ...(guard ? { guard } : {}),
          done: (error) => {
            if (!error) return;
            clearTimeout(timer);
            this.labels.delete(label);
            result.reject(error);
          },
        });
      } else {
        const line = formatMessage(command, params, tags);
        this.enqueue({
          line,
          ...(guard ? { guard } : {}),
          done: (error) => (error ? result.reject(error) : result.resolve()),
        });
      }
    } catch (error) {
      result.reject(
        error instanceof Error ? error : new Error("IRC send failed"),
      );
    }
    return result.promise;
  }

  /** Connect, and reconnect with backoff, until the signal aborts. */
  async run(signal: AbortSignal) {
    let attempt = 0;
    while (!signal.aborted) {
      const started = Date.now();
      const outcome = await this.connect(signal).catch(() => "lost" as const);
      if (signal.aborted) break;
      // A connection that lasted a while starts the backoff again.
      if (Date.now() - started > 60_000) attempt = 0;
      const wait =
        outcome === "refused"
          ? this.timing.refusedMs
          : Math.min(
              this.timing.reconnectMaxMs,
              this.timing.reconnectMinMs * 2 ** attempt++,
            );
      this.options.log.warn(
        outcome === "refused"
          ? "IRC login refused; retrying later"
          : "IRC connection lost; reconnecting",
      );
      await delay(wait * (0.75 + Math.random() * 0.5), undefined, {
        signal,
      }).catch(() => {});
    }
  }

  private connect(signal: AbortSignal): Promise<"lost" | "refused"> {
    const generation = ++this.generation;
    const closed = Promise.withResolvers<void>();
    let outcome: "lost" | "refused" = "lost";
    const decoder = new TextDecoder();
    let buffer = "";
    this.refuse = (message: string) => {
      outcome = "refused";
      this.options.log.error(message);
      this.raw("QUIT :Pogo");
      this.socket?.end();
    };
    this.offered = new Map();
    this.requested = 0;
    const { host, port, tls, ca } = this.options;
    const opened = Bun.connect({
      hostname: host,
      port,
      tls: tls
        ? {
            ...(ca ? { ca } : {}),
            ...(isIP(host) ? {} : { serverName: host }),
            rejectUnauthorized: true,
          }
        : false,
      socket: {
        open: (socket) => {
          if (generation !== this.generation || signal.aborted) {
            socket.end();
            return;
          }
          this.socket = socket;
          this.lastData = Date.now();
          this.options.log.info("IRC connected");
          this.raw("CAP LS 302");
          this.raw(formatMessage("NICK", [this.options.nick]));
          this.raw(
            formatMessage("USER", [this.options.account, "0", "*", "Pogo"]),
          );
        },
        data: (_socket, data) => {
          if (generation !== this.generation) return;
          buffer += decoder.decode(data, { stream: true });
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
            if (line && utf8Bytes(line) <= maxReceivedBytes) {
              try {
                this.receive(line);
              } catch {
                this.options.log.error("IRC message handling failed");
              }
            }
            index = buffer.indexOf("\n");
          }
          if (buffer.length > maxReceivedBytes) this.socket?.end();
        },
        drain: () => {
          if (generation === this.generation) this.flush();
        },
        close: () => closed.resolve(),
        end: (socket) => {
          socket.end();
        },
        error: () => {},
        connectError: () => closed.resolve(),
      },
    });
    // A connect that never completes is abandoned: a late open sees a newer
    // generation and closes itself.
    const abandon = () => {
      if (this.socket) return false;
      this.generation++;
      closed.resolve();
      return true;
    };
    const abort = () => {
      if (abandon()) return;
      this.raw("QUIT :Pogo shutting down");
      const socket = this.socket;
      socket?.end();
      // A peer that never closes must not hold shutdown.
      setTimeout(() => socket?.terminate(), 2000).unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    const timers = setInterval(
      () => this.tick(),
      Math.min(1000, this.timing.pingMs / 2, this.timing.reclaimMs),
    );
    const registration = setTimeout(() => {
      if (!abandon() && !this.registeredNow) this.socket?.end();
    }, this.timing.registerMs);
    void opened.catch(() => closed.resolve());
    return closed.promise.then(() => {
      signal.removeEventListener("abort", abort);
      clearInterval(timers);
      clearTimeout(registration);
      this.disconnected();
      return outcome;
    });
  }

  /** Keepalive, nick reclaim and missing allowed channels. */
  private tick() {
    const now = Date.now();
    if (!this.socket) return;
    if (now - this.lastData > this.timing.timeoutMs) {
      this.options.log.warn("IRC connection timed out");
      this.socket.end();
      return;
    }
    if (
      now - this.lastData > this.timing.pingMs &&
      now - this.lastPing > this.timing.pingMs
    ) {
      this.lastPing = now;
      this.raw("PING :pogo");
    }
    if (!this.registeredNow || now - this.reclaimed < this.timing.reclaimMs)
      return;
    this.reclaimed = now;
    if (this.fold(this.currentNick) !== this.fold(this.options.nick))
      this.enqueue({ line: formatMessage("NICK", [this.options.nick]) });
    for (const channel of this.options.channels)
      if (!this.inChannel(channel)) this.join(channel);
  }

  private disconnected() {
    this.socket = undefined;
    this.registeredNow = false;
    this.welcomed = false;
    this.networkName = undefined;
    this.output = undefined;
    this.caps = new Set();
    this.joinedChannels.clear();
    // Offline, nick changes are unseen: start again from fresh evidence.
    this.accountNicks.clear();
    this.nickAccounts.clear();
    for (const pending of this.whois.values()) {
      clearTimeout(pending.timer);
      pending.result.reject(new IrcUnavailable());
    }
    this.whois.clear();
    this.labelBatches.clear();
    this.replayBatches.clear();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    const error = new IrcUnavailable();
    for (const item of this.queue.splice(0)) item.done?.(error);
    for (const [label, pending] of this.labels) {
      clearTimeout(pending.timer);
      this.labels.delete(label);
      pending.reject(error);
    }
  }

  /** Unthrottled write: registration, PONG and QUIT only. */
  private raw(line: string) {
    if (!this.socket) return;
    const bytes = Buffer.from(`${line}\r\n`, "utf8");
    this.output = this.output ? Buffer.concat([this.output, bytes]) : bytes;
    this.flush();
  }

  private flush() {
    const socket = this.socket;
    const output = this.output;
    if (!socket || !output) return;
    const written = socket.write(output);
    if (written < 0) return;
    this.output =
      written >= output.byteLength ? undefined : output.subarray(written);
  }

  private enqueue(item: Queued) {
    this.queue.push(item);
    this.pump();
  }

  private pump() {
    if (this.pumpTimer) return;
    const now = Date.now();
    this.tokens = Math.min(
      this.timing.burst,
      this.tokens + (now - this.refilled) / this.timing.intervalMs,
    );
    this.refilled = now;
    while (this.queue.length && this.tokens >= 1 && this.socket) {
      const item = this.queue.shift();
      if (!item) break;
      // Recheck at the write: a queued direct line must not follow its
      // recipient's nick to another account.
      if (item.guard && !item.guard()) {
        item.done?.(new IrcRecipientChanged());
        continue;
      }
      this.tokens -= 1;
      this.raw(item.line);
      item.done?.();
    }
    if (this.queue.length && this.socket)
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = undefined;
        this.pump();
      }, this.timing.intervalMs);
  }

  private receive(line: string) {
    const message = parseMessage(line);
    if (!message) return;
    this.lastData = Date.now();
    const { command, params } = message;
    const label = message.tags.get("label");
    const batch = message.tags.get("batch");
    if (label !== undefined && command !== "BATCH") this.settle(label, message);
    if (batch !== undefined) {
      const owner = this.labelBatches.get(batch);
      if (owner !== undefined && failure(message)) {
        const pending = this.labels.get(owner);
        if (pending) pending.failed = true;
      }
    }
    switch (command) {
      case "PING":
        this.raw(
          formatMessage(
            "PONG",
            params.length ? [params.at(-1) ?? ""] : ["pogo"],
          ),
        );
        return;
      case "CAP":
        return this.capability(message);
      case "AUTHENTICATE":
        if (params[0] === "+") this.authenticate();
        return;
      case "903":
      case "907":
        this.raw("CAP END");
        return;
      case "902":
      case "904":
      case "905":
      case "906":
      case "908":
        this.refuse("IRC SASL authentication failed");
        return;
      case "001":
        this.welcomed = true;
        this.currentNick = params[0] ?? this.options.nick;
        return;
      case "005":
        for (const token of params.slice(1, -1)) {
          const [key, value] = token.split("=", 2);
          if (key === "CHANTYPES" && value) this.chantypes = value;
          if (key === "CASEMAPPING") this.mapping = casemapping(value);
          if (key === "NETWORK") this.networkName = value;
        }
        return;
      // End of MOTD, or no MOTD: ISUPPORT is complete.
      case "376":
      case "422":
        return this.welcome();
      case "432":
      case "433":
      case "436":
        // Before welcome only; reclaim retries the configured nick later.
        if (!this.welcomed) {
          this.currentNick = `${this.currentNick.slice(0, 30)}_`;
          this.raw(formatMessage("NICK", [this.currentNick]));
        }
        return;
      case "NICK": {
        const old = sourceNick(message.source);
        const next = params[0] ?? old;
        if (this.fold(old) === this.fold(this.currentNick))
          this.currentNick = next;
        const account = this.nickAccounts.get(this.fold(old));
        this.unbindNick(old);
        this.unbindNick(next);
        if (account !== undefined) this.bind(account, next);
        return;
      }
      case "JOIN": {
        const nick = sourceNick(message.source);
        const channel = params[0] ?? "";
        if (this.fold(nick) === this.fold(this.currentNick)) {
          const bang = message.source?.indexOf("!") ?? -1;
          if (bang > 0) this.userhost = message.source?.slice(bang + 1);
          // A server-forced join to an unlisted channel is left at once.
          const allowed = this.channel(channel);
          if (!allowed) {
            this.enqueue({ line: formatMessage("PART", [channel]) });
            return;
          }
          this.joinedChannels.add(allowed);
          this.replay(allowed);
        } else if (params[1] !== undefined && this.caps.has("extended-join")) {
          if (params[1] === "*") this.unbindNick(nick);
          else this.bind(params[1], nick);
        }
        return;
      }
      case "PART":
        if (
          this.fold(sourceNick(message.source)) === this.fold(this.currentNick)
        )
          this.joinedChannels.delete(this.channel(params[0] ?? "") ?? "");
        // Without a shared channel, later changes to that nick are unseen.
        else this.unbindNick(sourceNick(message.source));
        return;
      case "KICK":
        if (this.fold(params[1] ?? "") === this.fold(this.currentNick)) {
          this.joinedChannels.delete(this.channel(params[0] ?? "") ?? "");
          this.options.log.warn("IRC connection was kicked from a channel");
        } else this.unbindNick(params[1] ?? "");
        return;
      case "ACCOUNT": {
        const nick = sourceNick(message.source);
        if (params[0] && params[0] !== "*") this.bind(params[0], nick);
        else this.unbindNick(nick);
        return;
      }
      case "QUIT":
        this.unbindNick(sourceNick(message.source));
        return;
      case "330":
        if (params[1] && params[2]) {
          const pending = this.whois.get(this.fold(params[1]));
          if (pending) pending.account = params[2];
        }
        return;
      case "318":
        if (params[1]) this.whoisEnd(params[1], true);
        return;
      case "401":
        if (params[1]) this.whoisEnd(params[1], false);
        return;
      case "INVITE":
        if (
          this.fold(params[0] ?? "") === this.fold(this.currentNick) &&
          params[1]
        )
          this.events.invite?.(params[1]);
        return;
      case "403":
      case "405":
      case "471":
      case "473":
      case "474":
      case "475":
      case "477":
        if (params[1]) this.events.joinFailed?.(params[1], command);
        return;
      case "BATCH":
        return this.batch(message, label);
      case "ERROR":
        this.options.log.warn("IRC server closed the connection");
        return;
      case "PRIVMSG":
      case "NOTICE":
      case "TAGMSG": {
        const nick = sourceNick(message.source);
        const account = message.tags.get("account");
        const target = params[0] ?? "";
        const time = message.tags.get("time");
        const replay = batch !== undefined && this.replayBatches.has(batch);
        // History shows who held a nick then, not now.
        if (!replay && message.source?.includes("!")) {
          if (account && account !== "*") this.bind(account, nick);
          else this.unbindNick(nick);
        }
        if (time && this.isChannel(target)) {
          const seen = this.lastSeen.get(this.fold(target));
          if (!seen || time > seen) this.lastSeen.set(this.fold(target), time);
        }
        const msgid = message.tags.get("msgid");
        if (msgid && this.fold(nick) === this.fold(this.currentNick))
          this.own.set(msgid, true);
        // A labeled echo confirms our own send; it is not new input.
        if (label === undefined) this.events.message?.(message, replay);
        return;
      }
    }
  }

  /** Bind account ↔ nick, dropping both previous partners. */
  private bind(account: string, nick: string) {
    this.unbindNick(nick);
    const previous = this.accountNicks.get(this.fold(account));
    if (previous !== undefined) this.unbindNick(previous);
    this.accountNicks.set(this.fold(account), nick);
    this.nickAccounts.set(this.fold(nick), account);
  }

  /** Forget a nick's account and that account's nick, if they match. */
  private unbindNick(nick: string) {
    const key = this.fold(nick);
    const account = this.nickAccounts.get(key);
    this.nickAccounts.delete(key);
    if (account === undefined) return;
    const bound = this.accountNicks.get(this.fold(account));
    if (bound !== undefined && this.fold(bound) === key)
      this.accountNicks.delete(this.fold(account));
  }

  private settle(label: string, message: IrcMessage) {
    const pending = this.labels.get(label);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.labels.delete(label);
    if (failure(message))
      pending.reject(new Error("IRC server refused the message"));
    else pending.resolve();
  }

  private batch(message: IrcMessage, label: string | undefined) {
    const reference = message.params[0] ?? "";
    const id = reference.slice(1);
    if (reference.startsWith("+")) {
      const type = message.params[1] ?? "";
      if (label !== undefined) this.labelBatches.set(id, label);
      if (type === "chathistory" || type === "draft/chathistory")
        this.replayBatches.add(id);
      return;
    }
    if (!reference.startsWith("-")) return;
    this.replayBatches.delete(id);
    const owner = this.labelBatches.get(id);
    if (owner === undefined) return;
    this.labelBatches.delete(id);
    const pending = this.labels.get(owner);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.labels.delete(owner);
    if (pending.failed)
      pending.reject(new Error("IRC server refused the message"));
    else pending.resolve();
  }

  private capability(message: IrcMessage) {
    const params = message.params;
    const sub = params[1];
    if (sub === "LS") {
      const more = params[2] === "*";
      for (const [name, value] of parseCapabilities(params.at(-1) ?? ""))
        this.offered.set(name, value);
      if (more) return;
      const offered = this.offered;
      this.offered = new Map();
      const sasl = offered.get("sasl");
      if (
        !required.every((cap) => offered.has(cap)) ||
        (sasl && !sasl.split(",").includes("PLAIN"))
      ) {
        this.refuse("IRC server lacks SASL PLAIN or account-tag");
        return;
      }
      const history = chathistoryCaps.find((cap) => offered.has(cap));
      const wanted = [
        ...required,
        ...optional.filter((cap) => offered.has(cap)),
        ...(history ? [history] : []),
      ];
      this.requested = wanted.length;
      for (const cap of wanted) this.raw(formatMessage("CAP", ["REQ", cap]));
      return;
    }
    if (sub === "ACK" || sub === "NAK") {
      for (const name of (params.at(-1) ?? "").split(" ")) {
        if (!name) continue;
        if (sub === "NAK") {
          if (required.includes(name)) {
            this.refuse("IRC server refused a required capability");
            return;
          }
        } else if (name.startsWith("-")) this.caps.delete(name.slice(1));
        else this.caps.add(name);
      }
      if (this.welcomed || --this.requested > 0) return;
      this.raw("AUTHENTICATE PLAIN");
      return;
    }
    if (sub === "DEL")
      for (const name of (params.at(-1) ?? "").split(" "))
        this.caps.delete(name);
  }
  private offered = new Map<string, string>();
  private requested = 0;
  private reclaimed = 0;
  private refuse: (message: string) => void = () => {};

  private authenticate() {
    const payload = Buffer.from(
      `\0${this.options.account}\0${this.options.password}`,
      "utf8",
    ).toString("base64");
    for (let i = 0; i < payload.length; i += 400)
      this.raw(`AUTHENTICATE ${payload.slice(i, i + 400)}`);
    if (payload.length % 400 === 0) this.raw("AUTHENTICATE +");
  }

  /** Ready only on the configured network; joins follow. */
  private welcome() {
    if (this.registeredNow || !this.welcomed) return;
    const expected = this.options.network;
    if (
      expected !== undefined &&
      this.networkName?.toLowerCase() !== expected.toLowerCase()
    ) {
      this.refuse("IRC network name differs from configuration");
      return;
    }
    this.registeredNow = true;
    this.options.log.info("IRC registered");
    for (const wake of this.waiters) wake();
    const channels = this.options.channels.filter(
      (channel) => this.channel(channel) !== undefined,
    );
    for (const line of joinLines(channels)) this.enqueue({ line });
  }

  /** After a reconnect, fetch channel messages missed while disconnected. */
  private replay(channel: string) {
    const history = chathistoryCaps.find((cap) => this.caps.has(cap));
    const since = this.lastSeen.get(this.fold(channel));
    if (!history || !since || !this.caps.has("batch")) return;
    this.enqueue({
      line: formatMessage("CHATHISTORY", [
        "AFTER",
        channel,
        `timestamp=${since}`,
        "100",
      ]),
    });
  }
}

/** JOIN lines for these channels, each within the 510-byte line limit. */
export function joinLines(channels: readonly string[]) {
  const lines: string[] = [];
  let batch: string[] = [];
  const line = (names: readonly string[]) =>
    formatMessage("JOIN", [names.join(",")]);
  for (const channel of channels) {
    if (batch.length && utf8Bytes(line([...batch, channel])) > lineBytes) {
      lines.push(line(batch));
      batch = [];
    }
    batch.push(channel);
  }
  if (batch.length) lines.push(line(batch));
  return lines;
}

function failure(message: IrcMessage) {
  return message.command === "FAIL" || /^[45]\d\d$/.test(message.command);
}
