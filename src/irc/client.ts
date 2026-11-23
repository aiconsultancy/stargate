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
  validMsgid,
} from "./protocol";
import { IrcStatus, type StatusResult, type StatusTiming } from "./status";

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
  /** +typing=active refresh while a turn runs (the spec allows 3 s). */
  typingMs: number;
  /** Age at which an open fleet request gets one progress notice. */
  turnStatusMs: number;
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
  typingMs: 3000,
  turnStatusMs: 300_000,
};

export type IrcClientOptions = {
  host: string;
  port: number;
  tls: boolean;
  /** PEM of a private CA; system roots otherwise. */
  ca?: string;
  account: string;
  password?: string;
  /** Explicit TLS cert and private key for SASL EXTERNAL. */
  clientCertificate?: { cert: string; key: string };
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
  /**
   * Captain only: the DM audit channel. Joined like a configured channel,
   * but never replayed by catch-up; the ship never treats it as a
   * conversation. Ignored on a crew connection (with `captainChannels`).
   */
  auditChannel?: string;
  /** Request draft/multiline when offered (default true). */
  multiline?: boolean;
  /**
   * Catch-up after each (re)connect: the server time to replay after, per
   * channel; the start of the CHATHISTORY TARGETS window for direct
   * messages; and per direct-message partner (with the time of the
   * partner's latest message from TARGETS). Undefined skips that target.
   * Without it, channels replay after the last message seen in this
   * process, and direct messages do not replay.
   */
  history?: {
    channel(name: string): string | undefined;
    targets(): string | undefined;
    direct(nick: string, latest: string | undefined): string | undefined;
  };
  /** Request (draft/)chathistory when offered (default true). */
  catchUp?: boolean;
  /** Presence features, each used only when offered (default true). */
  presence?: { alwaysOn: boolean; botMode: boolean; readMarker: boolean };
  /** Fixed public waiting phrases only; never a request or backend text. */
  statusName?: string;
  /** Injectable protocol timing for local fixtures; not a configuration setting. */
  statusTiming?: Partial<StatusTiming>;
  log: Logger;
  timing?: Partial<IrcTiming>;
};

export interface IrcEvents {
  /** PRIVMSG/NOTICE/TAGMSG, including own echoes. `replay`: chathistory. */
  message?(message: IrcMessage, replay: boolean): void;
  /**
   * A PRIVMSG or NOTICE that this connection sent to a nick, after the
   * server confirmed it (or it was written, without labeled-response). A
   * multiline batch is one message with its lines joined.
   */
  sent?(message: {
    command: "PRIVMSG" | "NOTICE";
    target: string;
    text: string;
  }): void;
  /** Exact pending own PRIVMSG echoed by the server with the expected SASL account. */
  published?(message: {
    target: string;
    msgid: string;
    request: string;
    root?: string;
  }): void;
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

/** Smallest draft/multiline max-bytes that Stargate uses. */
const minMultilineBytes = 64;

type Pending = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  failed?: boolean;
};

type Queued = {
  /** Written together: one line, or a whole multiline batch. */
  lines: readonly string[];
  done?: (error?: Error) => void;
  /** Checked before the first socket byte, including through backpressure. */
  guard?: () => boolean;
};

type Output = {
  bytes: Uint8Array;
  started: boolean;
  guard?: () => boolean;
  done?: (error?: Error) => void;
};

/**
 * A send that timed out while it still waited in the send queue: it was
 * removed and is never written, so nothing reached the server.
 */
export class IrcSendExpired extends Error {
  constructor() {
    super("IRC send expired before it was written");
  }
}

/** A direct message whose recipient no longer holds the target nick. */
export class IrcRecipientChanged extends Error {
  constructor() {
    super("IRC recipient changed before delivery");
  }
}

/** Send lanes: `low` items go only when no normal item waits. */
export type SendPriority = "normal" | "low";

/** Insertion-ordered set with a size bound. */
export class Recent<V = true> extends Map<string, V> {
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
 * PLAIN or EXTERNAL, keepalive, channel joins, send throttling and
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
  /** EXTERNAL must prove the actual account bound to the certificate. */
  private externalAccountVerified = false;
  private networkName: string | undefined;
  /** FILEHOST advertised in this connection's ISUPPORT, then since ready. */
  private advertisedFilehost: string | undefined;
  private readyFilehost: string | undefined;
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
  /** Own message ID → wire thread root and, separately, answered request. */
  private readonly own = new Recent<{ root?: string; request?: string }>(1024);
  /** Local echo correlation only; never changes tags or admission identity. */
  private readonly echoes = new Recent<{
    target: string;
    text: string;
    root: string | undefined;
    label: string | undefined;
    request: string | undefined;
    /** Receives the server msgid of this send's own authenticated echo. */
    onEcho?: (msgid: string) => void;
  }>(1024);
  private echoID = 0;
  private readonly lastSeen = new Map<string, string>();
  private readonly labels = new Map<string, Pending>();
  private readonly labelBatches = new Map<string, string>();
  private readonly replayBatches = new Set<string>();
  /** Incoming draft/multiline batches being assembled, by reference. */
  private readonly multilineIn = new Map<
    string,
    { open: IrcMessage; label: string | undefined; parts: IrcMessage[] }
  >();
  private multilineOffer: { maxBytes: number; maxLines: number } | undefined;
  private readonly queue: Queued[] = [];
  /** Low-priority lane (DM audit lines): sent only when `queue` is empty. */
  private readonly background: Queued[] = [];
  private tokens: number;
  private refilled = Date.now();
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly output: Output[] = [];
  private label = 0;
  private readonly waiters = new Set<() => void>();
  private lastData = 0;
  private lastPing = 0;
  private readonly status: IrcStatus | undefined;
  private statusLimit = 344; // Ergo: key + value <=350 bytes; "status" owns six.
  private metadataPending:
    | {
        value: string | undefined;
        finish(result: StatusResult): void;
      }
    | undefined;

  constructor(
    private readonly options: IrcClientOptions,
    private readonly events: IrcEvents = {},
  ) {
    if (
      Boolean(options.clientCertificate) === Boolean(options.password) ||
      (options.clientCertificate && !options.tls)
    )
      throw new Error(
        "IRC requires either a password or a TLS client certificate",
      );
    this.timing = { ...defaultTiming, ...options.timing };
    this.tokens = this.timing.burst;
    this.currentNick = options.nick;
    this.status =
      options.statusName === undefined
        ? undefined
        : new IrcStatus(
            options.statusName,
            (value, guard) => this.publishStatus(value, guard),
            options.statusTiming,
          );
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
  /**
   * Soju.im/FILEHOST or draft/FILEHOST from the last completed registration
   * (kept across a reconnect until the next one finishes). Unvalidated.
   */
  get filehost() {
    return this.readyFilehost;
  }
  /** Draft/multiline limits when negotiated (needs batch). */
  get multiline() {
    return this.caps.has("draft/multiline") && this.caps.has("batch")
      ? this.multilineOffer
      : undefined;
  }
  /** True when the IRC connection uses TLS (FILEHOST must then be HTTPS). */
  get secure() {
    return this.options.tls;
  }
  isChannel(target: string) {
    return target !== "" && this.chantypes.includes(target[0] ?? "");
  }
  /** Configured spelling of an allowed channel, or undefined. */
  channel(name: string) {
    const key = this.fold(name);

    if (this.isAudit(name)) return this.options.auditChannel;
    const granted = this.options.captainChannels;

    if (granted && !granted.some((channel) => this.fold(channel) === key))
      return;

    return this.options.channels.find((channel) => this.fold(channel) === key);
  }
  /** The captain's DM audit channel (never one on a crew connection). */
  isAudit(name: string) {
    const audit = this.options.auditChannel;

    return (
      audit !== undefined &&
      this.options.captainChannels === undefined &&
      this.isChannel(name) &&
      this.fold(name) === this.fold(audit)
    );
  }
  inChannel(name: string) {
    const channel = this.channel(name);

    return channel !== undefined && this.joinedChannels.has(channel);
  }
  /** A message ID that this connection sent (from its echo). */
  sent(msgid: string) {
    return this.own.has(msgid);
  }
  /** The wire thread root that one of our messages replied to. */
  anchor(msgid: string) {
    return this.own.get(msgid)?.root;
  }
  /** Stop targets the answered request, not its visible thread root. */
  requestAnchor(msgid: string) {
    const own = this.own.get(msgid);

    return own?.request ?? own?.root;
  }
  /** The account last seen for a nick (a hint; WHOIS proves it), if any. */
  knownAccount(nick: string) {
    return this.nickAccounts.get(this.fold(nick));
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
      lines: [formatMessage("WHOIS", [nick])],
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
    // Greybeard: both are subtracted, so text fits either framing within
    // 512 bytes. An unknown user@host assumes 16 + 63 characters.
    const label = this.caps.has("labeled-response")
      ? { label: `stargate${"9".repeat(12)}` }
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
    priority: SendPriority = "normal",
    request?: string,
  ) {
    return this.send("PRIVMSG", [target, text], tags, guard, priority, request);
  }

  /**
   * One PRIVMSG that resolves with the server message ID of its own echo,
   * authenticated with this connection's account. Undefined without
   * echo-message, or when no echo arrives within the confirmation window.
   */
  async publish(
    target: string,
    text: string,
    tags: Record<string, string> = {},
    guard?: () => boolean,
  ): Promise<string | undefined> {
    const echoed = Promise.withResolvers<string | undefined>();
    const echo = this.hasCap("echo-message");
    await this.send(
      "PRIVMSG",
      [target, text],
      tags,
      guard,
      "normal",
      undefined,
      true,
      (msgid) => echoed.resolve(msgid),
    );

    if (!echo) return;

    const timer = setTimeout(
      () => echoed.resolve(undefined),
      this.timing.confirmMs,
    );

    try {
      return await echoed.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  tagmsg(target: string, tags: Record<string, string>, guard?: () => boolean) {
    if (!this.caps.has("message-tags"))
      return Promise.reject(new Error("IRC message tags unavailable"));

    return this.send("TAGMSG", [target], tags, guard);
  }

  /**
   * Fire-and-forget TAGMSG for client-only status such as +typing: never
   * labeled, never waited for, and skipped while replies wait in the send
   * queue, so it cannot delay them. `guard` is checked now and again at
   * the socket write, as for direct lines.
   */
  notify(target: string, tags: Record<string, string>, guard?: () => boolean) {
    if (
      !this.registeredNow ||
      !this.socket ||
      !this.caps.has("message-tags") ||
      this.queue.length ||
      (guard && !guard())
    )
      return false;
    this.enqueue({
      lines: [formatMessage("TAGMSG", [target], tags)],
      ...(guard ? { guard } : {}),
    });

    return true;
  }

  get typingMs() {
    return this.timing.typingMs;
  }

  get turnStatusMs() {
    return this.timing.turnStatusMs;
  }

  /** Shared by every conversation on this captain or crew connection. */
  startStatus(): () => void {
    return this.status?.begin() ?? (() => {});
  }

  /** One owned key, with protocol acknowledgement rather than a socket-write claim. */
  private publishStatus(
    value: string | undefined,
    valid: () => boolean,
  ): Promise<StatusResult> {
    if (
      !this.registeredNow ||
      !this.hasCap("draft/metadata-2") ||
      !this.hasCap("batch") ||
      this.metadataPending
    )
      return Promise.resolve({ kind: "unavailable" });
    const generation = this.generation;
    const result = Promise.withResolvers<StatusResult>();

    const guard = () =>
      this.metadataPending === pending &&
      generation === this.generation &&
      this.registeredNow &&
      valid();

    const item: Queued = {
      lines: [
        formatMessage(
          "METADATA",
          value === undefined
            ? ["*", "SET", "status"]
            : ["*", "SET", "status", value],
        ),
      ],
      guard,
      done: (error) => {
        if (error) pending.finish({ kind: "unavailable" });
      },
    };

    const timer = setTimeout(() => {
      this.unqueue(item); // Never write an expired busy value after the turn ended.
      pending.finish({ kind: "unavailable" });
    }, this.timing.confirmMs);

    const pending = {
      value,
      finish: (outcome: StatusResult) => {
        if (this.metadataPending !== pending) return;
        clearTimeout(timer);
        this.metadataPending = undefined;
        result.resolve(outcome);
      },
    };

    this.metadataPending = pending;
    this.enqueue(item);

    return result.promise;
  }

  /** Ergo 2.19.1 uses 761/766, including subscriber notifications; ACK only our own key/value. */
  private metadataReply(message: IrcMessage): void {
    const pending = this.metadataPending;

    if (!pending || message.source?.includes("!")) return;
    const { command, params } = message;
    const own = this.fold(params[1] ?? "") === this.fold(this.currentNick);

    if (
      command === "761" &&
      own &&
      params[2] === "status" &&
      params[4] === pending.value
    )
      pending.finish({ kind: "ok" });
    else if (
      command === "766" &&
      own &&
      params[2] === "status" &&
      pending.value === undefined
    )
      pending.finish({ kind: "ok" });
    else if (command === "FAIL" && params[0] === "METADATA") {
      if (
        params[1] === "KEY_NOT_SET" &&
        params[3] === "status" &&
        pending.value === undefined
      )
        pending.finish({ kind: "ok" });
      else if (params[1] === "RATE_LIMITED" && params[3] === "status") {
        const seconds = /^\d+$/.test(params[4] ?? "") ? Number(params[4]) : 120;
        pending.finish({
          kind: "rate-limited",
          retryAfterMs:
            Number.isSafeInteger(seconds) && seconds > 0
              ? seconds * 1000
              : 120_000,
        });
      } else if (params.includes("status"))
        pending.finish({ kind: "rejected" });
    }
  }

  /** True while `nick` is bound to `account` in both directions. */
  holds(account: string, nick: string) {
    const bound = this.boundNick(account);

    return bound !== undefined && this.fold(bound) === this.fold(nick);
  }

  /** Retain the authenticated sender only for this IRC connection. */
  recipientGuard(account: string, nick: string) {
    const connection = this.generation;

    return () =>
      this.registeredNow &&
      this.generation === connection &&
      this.holds(account, nick);
  }
  /** Join an allowed channel; anything else is refused. */
  join(name: string) {
    const channel = this.channel(name);

    if (!channel || !this.registeredNow) return false;
    this.enqueue({ lines: [formatMessage("JOIN", [channel])] });

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
    priority: SendPriority = "normal",
    request?: string,
    audit = true,
    onEcho?: (msgid: string) => void,
  ): Promise<void> {
    let echo: string | undefined;

    const result = this.transmit(
      (label) => {
        if (command === "PRIVMSG" && params[0] !== undefined)
          echo = this.rememberEcho(
            params[0],
            params[1] ?? "",
            tags,
            label,
            request,
            onEcho,
          );

        return [
          formatMessage(command, params, {
            ...(label === undefined ? {} : { label }),
            ...tags,
          }),
        ];
      },
      guard,
      priority,
    );

    const [target, text = ""] = params;

    if (
      audit &&
      (command === "PRIVMSG" || command === "NOTICE") &&
      target !== undefined
    )
      this.whenSent(result, command, target, text);

    return result.catch((error: unknown) => {
      if (echo !== undefined) this.echoes.delete(echo);
      throw error;
    });
  }

  /** Bounded, in-process match for a send's own echo, labeled when possible. */
  private rememberEcho(
    target: string,
    text: string,
    tags: Record<string, string>,
    label: string | undefined,
    request: string | undefined,
    onEcho?: (msgid: string) => void,
  ) {
    if ((!validMsgid(request) && !onEcho) || !this.hasCap("echo-message"))
      return;
    const id = String(++this.echoID);
    this.echoes.set(id, {
      target: this.fold(target),
      text,
      root: tags["+draft/reply"],
      label,
      request: validMsgid(request) ? request : undefined,
      ...(onEcho ? { onEcho } : {}),
    });

    return id;
  }

  /** Report a confirmed message to a nick (`events.sent`); never throws. */
  private whenSent(
    result: Promise<void>,
    command: "PRIVMSG" | "NOTICE",
    target: string,
    text: string,
  ) {
    if (this.isChannel(target) || !this.events.sent) return;
    result.then(
      () => {
        try {
          this.events.sent?.({ command, target, text });
        } catch {
          this.options.log.warn("IRC sent-message handler failed");
        }
      },
      () => {},
    );
  }

  /**
   * One draft/multiline batch: `BATCH +ref draft/multiline target` (with
   * the label and client tags), the lines tagged `batch=ref` (continuations
   * with `draft/multiline-concat`), then `BATCH -ref`, written together as
   * one throttled unit. The server delivers it atomically.
   */
  sendBatch(
    target: string,
    lines: readonly { text: string; concat: boolean }[],
    tags: Record<string, string> = {},
    guard?: () => boolean,
    priority: SendPriority = "normal",
    request?: string,
  ): Promise<void> {
    if (!this.multiline)
      return Promise.reject(new Error("IRC multiline unavailable"));
    const reference = `stargate${++this.label}`;

    const text = lines
      .map((line, index) =>
        index && !line.concat ? `\n${line.text}` : line.text,
      )
      .join("");

    let echo: string | undefined;

    const result = this.transmit(
      (label) => {
        echo = this.rememberEcho(target, text, tags, label, request);

        return [
          formatMessage("BATCH", [`+${reference}`, "draft/multiline", target], {
            ...(label === undefined ? {} : { label }),
            ...tags,
          }),
          ...lines.map((line) =>
            formatMessage("PRIVMSG", [target, line.text], {
              batch: reference,
              ...(line.concat ? { "draft/multiline-concat": "" } : {}),
            }),
          ),
          formatMessage("BATCH", [`-${reference}`]),
        ];
      },
      guard,
      priority,
    );

    this.whenSent(result, "PRIVMSG", target, text);

    return result.catch((error: unknown) => {
      if (echo !== undefined) this.echoes.delete(echo);
      throw error;
    });
  }

  private transmit(
    build: (label: string | undefined) => string[],
    guard?: () => boolean,
    priority: SendPriority = "normal",
  ): Promise<void> {
    if (!this.registeredNow || !this.socket)
      return Promise.reject(new IrcUnavailable());
    const result = Promise.withResolvers<void>();

    try {
      if (this.caps.has("labeled-response")) {
        const label = `stargate${++this.label}`;

        const item: Queued = {
          lines: build(label),
          ...(guard ? { guard } : {}),
          done: (error) => {
            if (!error) return;
            clearTimeout(timer);
            this.labels.delete(label);
            result.reject(error);
          },
        };

        // Still queued at the deadline: remove it, so a send that already
        // Failed is never written later (and a backlog cannot grow).
        const timer = setTimeout(() => {
          this.labels.delete(label);
          result.reject(
            this.unqueue(item)
              ? new IrcSendExpired()
              : new Error("IRC delivery unconfirmed"),
          );
        }, this.timing.confirmMs);

        this.labels.set(label, {
          resolve: result.resolve,
          reject: result.reject,
          timer,
        });
        this.enqueue(item, priority);
      } else {
        this.enqueue(
          {
            lines: build(undefined),
            ...(guard ? { guard } : {}),
            done: (error) => (error ? result.reject(error) : result.resolve()),
          },
          priority,
        );
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
      this.raw("QUIT :Stargate");
      this.socket?.end();
    };

    this.offered = new Map();
    this.requested = 0;
    const { host, port, tls, ca, clientCertificate } = this.options;

    const opened = Bun.connect({
      hostname: host,
      port,
      tls: tls
        ? {
            ...(ca ? { ca } : {}),
            ...(clientCertificate ?? {}),
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
            formatMessage("USER", [this.options.account, "0", "*", "Stargate"]),
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
    // Generation and closes itself.
    const abandon = () => {
      if (this.socket) return false;
      this.generation++;
      closed.resolve();

      return true;
    };

    let closing = false;

    const abort = () => {
      if (abandon()) return;

      if (closing) return;
      closing = true;
      const socket = this.socket;
      // Always-on Ergo retains metadata after QUIT: delete and acknowledge first.
      void (this.status?.shutdown() ?? Promise.resolve())
        .catch(() => {})
        .finally(() => {
          if (socket === this.socket) this.raw("QUIT :Stargate shutting down");
          socket?.end();
          // A peer that never closes must not hold shutdown.
          setTimeout(() => socket?.terminate(), 2000).unref();
        });
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
      this.raw("PING :stargate");
    }

    if (!this.registeredNow || now - this.reclaimed < this.timing.reclaimMs)
      return;
    this.reclaimed = now;

    if (this.fold(this.currentNick) !== this.fold(this.options.nick))
      this.enqueue({ lines: [formatMessage("NICK", [this.options.nick])] });

    for (const channel of this.joinable())
      if (!this.inChannel(channel)) this.join(channel);
  }

  /** Configured channels this connection may join, then the audit channel. */
  private joinable() {
    const audit = this.options.auditChannel;

    return [
      ...this.options.channels.filter(
        (channel) => this.channel(channel) !== undefined,
      ),
      ...(audit !== undefined && this.isAudit(audit) ? [audit] : []),
    ];
  }

  private disconnected() {
    this.status?.disconnected();
    this.metadataPending?.finish({ kind: "unavailable" });
    this.socket = undefined;
    this.registeredNow = false;
    this.welcomed = false;
    this.externalAccountVerified = false;
    this.networkName = undefined;
    this.advertisedFilehost = undefined;
    this.botMode = undefined;
    const buffered = this.output.splice(0);
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
    this.multilineIn.clear();
    this.echoes.clear();

    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    const error = new IrcUnavailable();

    for (const output of buffered) output.done?.(error);

    for (const item of [...this.queue.splice(0), ...this.background.splice(0)])
      item.done?.(error);

    for (const [label, pending] of this.labels) {
      clearTimeout(pending.timer);
      this.labels.delete(label);
      pending.reject(error);
    }
  }

  /** Control writes and already-throttled queue items retain their wire order. */
  private raw(
    line: string,
    guard?: () => boolean,
    done?: (error?: Error) => void,
  ) {
    if (!this.socket) return;
    const bytes = Buffer.from(`${line}\r\n`, "utf8");
    this.output.push({
      bytes,
      started: false,
      ...(guard ? { guard } : {}),
      ...(done ? { done } : {}),
    });
    this.flush();
  }

  private flush() {
    const socket = this.socket;

    if (!socket) return;

    while (this.output.length) {
      const output = this.output[0];

      if (!output) return;

      if (!output.started && output.guard && !output.guard()) {
        this.output.shift();
        output.done?.(new IrcRecipientChanged());
        continue;
      }

      const written = socket.write(output.bytes);

      if (written <= 0) return;
      output.started = true;

      // A partially written IRC line must finish before its subsequent clear;
      // Dropping its suffix would corrupt the following protocol command.
      if (written >= output.bytes.byteLength) {
        this.output.shift();
        output.done?.();
      } else {
        output.bytes = output.bytes.subarray(written);

        return;
      }
    }
  }

  private enqueue(item: Queued, priority: SendPriority = "normal") {
    (priority === "low" ? this.background : this.queue).push(item);
    this.pump();
  }

  /** Remove a queued item that was not written yet; true if it was queued. */
  private unqueue(item: Queued) {
    for (const lane of [this.queue, this.background]) {
      const index = lane.indexOf(item);

      if (index >= 0) {
        lane.splice(index, 1);

        return true;
      }
    }

    return false;
  }

  private waiting() {
    return this.queue.length > 0 || this.background.length > 0;
  }

  private pump() {
    if (this.pumpTimer) return;
    const now = Date.now();
    this.tokens = Math.min(
      this.timing.burst,
      this.tokens + (now - this.refilled) / this.timing.intervalMs,
    );
    this.refilled = now;

    while (this.waiting() && this.tokens >= 1 && this.socket) {
      const item = this.queue.shift() ?? this.background.shift();

      if (!item) break;

      // Recheck at the write: a queued direct line must not follow its
      // Recipient's nick to another account.
      if (item.guard && !item.guard()) {
        item.done?.(new IrcRecipientChanged());
        continue;
      }

      this.tokens -= 1;
      // Commit the entire throttled unit after its first byte. In particular,
      // A multiline opener must never lose its body/closer to a later guard.
      this.raw(item.lines.join("\r\n"), item.guard, item.done);
    }

    if (this.waiting() && this.socket)
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = undefined;
        this.pump();
      }, this.timing.intervalMs);
  }

  private receive(line: string) {
    const message = parseMessage(line);

    if (!message) return;
    this.lastData = Date.now();
    this.metadataReply(message);
    const { command, params } = message;
    const label = message.tags.get("label");
    const batch = message.tags.get("batch");

    const assembling =
      batch === undefined ? undefined : this.multilineIn.get(batch);

    if (assembling && (command === "PRIVMSG" || command === "NOTICE")) {
      assembling.parts.push(message);

      return;
    }

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
            params.length ? [params.at(-1) ?? ""] : ["stargate"],
          ),
        );

        return;
      case "CAP":
        return this.capability(message);
      case "AUTHENTICATE":
        if (params[0] === "+") this.authenticate();

        return;
      case "900":
        if (this.options.clientCertificate) {
          this.externalAccountVerified =
            this.fold(params[2] ?? "") === this.fold(this.options.account);

          if (!this.externalAccountVerified)
            this.refuse(
              "IRC client certificate authenticated a different account",
            );
        }

        return;
      case "901":
        if (this.options.clientCertificate)
          this.refuse(
            "IRC client certificate account is no longer authenticated",
          );

        return;
      case "903":
      case "907":
        if (this.options.clientCertificate && !this.externalAccountVerified) {
          this.refuse(
            "IRC server did not confirm the client certificate account",
          );

          return;
        }

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
          const equals = token.indexOf("=");
          const key = equals < 0 ? token : token.slice(0, equals);

          const value =
            equals < 0 ? undefined : isupportValue(token.slice(equals + 1));

          if (key === "CHANTYPES" && value) this.chantypes = value;

          if (key === "CASEMAPPING") this.mapping = casemapping(value);

          if (key === "NETWORK") this.networkName = value;

          if (key === "BOT" && value && /^[A-Za-z]$/.test(value))
            this.botMode = value;

          // CHATHISTORY=0 means no server maximum.
          if (key === "CHATHISTORY" && value && /^\d+$/.test(value))
            this.historyLimit = Math.min(100, Number(value) || 100);

          if ((key === "soju.im/FILEHOST" || key === "draft/FILEHOST") && value)
            this.advertisedFilehost = value;
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
            this.enqueue({ lines: [formatMessage("PART", [channel])] });

            return;
          }

          this.joinedChannels.add(allowed);

          // The audit channel holds Stargate's own copies: nothing to catch up.
          if (!this.isAudit(allowed)) this.replay(allowed);
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
      case "PERSISTENCE":
        // PERSISTENCE STATUS <requested> <effective>
        if (params[0] === "STATUS")
          this.options.log.info(
            { alwaysOn: params[2] === "ON" },
            "IRC persistence status",
          );

        return;
      case "CHATHISTORY":
        // TARGETS reply: one direct-message partner and the time of its
        // Latest message (plain, or with a `timestamp=` prefix).
        if (params[0] === "TARGETS" && params[1] && !this.isChannel(params[1]))
          this.history(
            params[1],
            this.options.history?.direct(
              params[1],
              params[2]?.replace(/^timestamp=/, ""),
            ),
          );

        return;
      case "ERROR":
        this.options.log.warn("IRC server closed the connection");

        return;
      case "PRIVMSG":
      case "NOTICE":
      case "TAGMSG":
        return this.chat(
          message,
          label,
          batch !== undefined && this.replayBatches.has(batch),
        );
    }
  }

  /** One chat message (or an assembled multiline batch). */
  private chat(
    message: IrcMessage,
    label: string | undefined,
    replay: boolean,
  ) {
    label ??= this.labelBatches.get(message.tags.get("batch") ?? "");
    const nick = sourceNick(message.source);
    const account = message.tags.get("account");
    const target = message.params[0] ?? "";
    const time = message.tags.get("time");

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

    if (validMsgid(msgid) && this.fold(nick) === this.fold(this.currentNick)) {
      const root =
        message.tags.get("+draft/reply") ?? message.tags.get("+reply");

      const echo = [...this.echoes].find(
        ([, sent]) =>
          sent.target === this.fold(target) &&
          sent.text === message.params[1] &&
          sent.root === root &&
          sent.label === label,
      );

      if (echo) this.echoes.delete(echo[0]);
      this.own.set(msgid, {
        ...(validMsgid(root) ? { root } : {}),
        ...(echo?.[1].request ? { request: echo[1].request } : {}),
      });

      if (
        echo &&
        !replay &&
        account &&
        this.fold(account) === this.fold(this.options.account)
      ) {
        const { request, onEcho } = echo[1];

        try {
          if (request !== undefined)
            this.events.published?.({
              target,
              msgid,
              request,
              ...(validMsgid(root) ? { root } : {}),
            });
          onEcho?.(msgid);
        } catch {
          this.options.log.warn("IRC published-message handler failed");
        }
      }
    }

    // A labeled echo confirms our own send; it is not new input.
    if (label === undefined) this.events.message?.(message, replay);
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

      if (type === "draft/multiline")
        this.multilineIn.set(id, {
          open: message,
          label:
            label ?? this.labelBatches.get(message.tags.get("batch") ?? ""),
          parts: [],
        });

      return;
    }

    if (!reference.startsWith("-")) return;
    const assembled = this.multilineIn.get(id);
    this.multilineIn.delete(id);

    if (assembled) this.assemble(assembled);
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

  /**
   * A received draft/multiline batch as one message: the opening BATCH's
   * tags (msgid, time, account, client tags) and the lines joined with line
   * breaks, or directly for draft/multiline-concat parts.
   */
  private assemble(batch: {
    open: IrcMessage;
    label: string | undefined;
    parts: IrcMessage[];
  }) {
    const [first] = batch.parts;

    if (!first) return;
    const tags = new Map(batch.open.tags);

    for (const key of ["account", "time"])
      if (!tags.has(key)) {
        const value = first.tags.get(key);

        if (value !== undefined) tags.set(key, value);
      }

    tags.delete("batch");
    const outer = batch.open.tags.get("batch");

    const text = batch.parts
      .map((part, index) =>
        index && !part.tags.has("draft/multiline-concat")
          ? `\n${part.params[1] ?? ""}`
          : (part.params[1] ?? ""),
      )
      .join("");

    const source = batch.open.source ?? first.source;
    this.chat(
      {
        tags,
        ...(source ? { source } : {}),
        command: first.command,
        params: [batch.open.params[2] ?? first.params[0] ?? "", text],
      },
      batch.label,
      outer !== undefined && this.replayBatches.has(outer),
    );
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
      const mechanism = this.options.clientCertificate ? "EXTERNAL" : "PLAIN";

      if (
        !required.every((cap) => offered.has(cap)) ||
        (sasl && !sasl.split(",").includes(mechanism))
      ) {
        this.refuse(`IRC server lacks SASL ${mechanism} or account-tag`);

        return;
      }

      const history =
        this.options.catchUp === false
          ? undefined
          : chathistoryCaps.find((cap) => offered.has(cap));

      const multiline = offered.get("draft/multiline");

      if (multiline !== undefined) {
        const limits = new Map(
          multiline.split(",").map((item) => {
            const [key = "", value = ""] = item.split("=");

            return [key, Number(value)] as const;
          }),
        );

        const maxBytes = limits.get("max-bytes") ?? 0;
        const maxLines = limits.get("max-lines") ?? 100;
        // Below 64 bytes a batch holds less than a plain line: not used.
        this.multilineOffer =
          Number.isInteger(maxBytes) && maxBytes >= minMultilineBytes
            ? {
                maxBytes,
                maxLines:
                  Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 100,
              }
            : undefined;
      } else this.multilineOffer = undefined;
      const presence = this.options.presence;
      const metadata = offered.get("draft/metadata-2");
      this.statusLimit = 344;

      for (const token of metadata?.split(",") ?? []) {
        if (!token.startsWith("max-value-bytes=")) continue;
        const limit = Number(token.slice("max-value-bytes=".length));
        this.statusLimit =
          Number.isSafeInteger(limit) && limit > 0 ? Math.min(344, limit) : 0;
      }

      const wanted = [
        ...required,
        ...optional.filter((cap) => offered.has(cap)),
        ...(this.status && metadata !== undefined && offered.has("batch")
          ? ["draft/metadata-2"]
          : []),
        ...(history ? [history] : []),
        ...(presence?.alwaysOn !== false && offered.has("draft/persistence")
          ? ["draft/persistence"]
          : []),
        ...(presence?.readMarker !== false && offered.has("draft/read-marker")
          ? ["draft/read-marker"]
          : []),
        ...(this.multilineOffer && this.options.multiline !== false
          ? ["draft/multiline"]
          : []),
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
      const mechanism = this.options.clientCertificate ? "EXTERNAL" : "PLAIN";
      this.raw(`AUTHENTICATE ${mechanism}`);

      return;
    }

    if (sub === "DEL") {
      for (const name of (params.at(-1) ?? "").split(" "))
        this.caps.delete(name);

      if (!this.hasCap("draft/metadata-2") || !this.hasCap("batch"))
        this.status?.disconnected();
    }
  }
  private offered = new Map<string, string>();
  private requested = 0;
  private reclaimed = 0;
  private refuse: (message: string) => void = () => {};

  private authenticate() {
    if (this.options.clientCertificate) {
      this.raw("AUTHENTICATE +");

      return;
    }

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

    if (this.options.clientCertificate && !this.externalAccountVerified) {
      this.refuse("IRC server did not confirm the client certificate account");

      return;
    }

    const expected = this.options.network;

    if (
      expected !== undefined &&
      this.networkName?.toLowerCase() !== expected.toLowerCase()
    ) {
      this.refuse("IRC network name differs from configuration");

      return;
    }

    this.registeredNow = true;

    if (this.hasCap("draft/metadata-2") && this.hasCap("batch"))
      this.status?.connected(this.statusLimit);
    this.readyFilehost = this.advertisedFilehost;
    this.options.log.info("IRC registered");

    for (const wake of this.waiters) wake();
    const channels = this.joinable();
    const presence = this.options.presence;

    // Always-on keeps the account in its channels and stores direct
    // Messages while Stargate is away (Ergo draft/persistence).
    if (presence?.alwaysOn !== false && this.caps.has("draft/persistence"))
      this.enqueue({ lines: [formatMessage("PERSISTENCE", ["SET", "ON"])] });

    if (presence?.botMode !== false && this.botMode)
      this.enqueue({
        lines: [formatMessage("MODE", [this.currentNick, `+${this.botMode}`])],
      });

    for (const line of joinLines(channels)) this.enqueue({ lines: [line] });
    this.replayDirect();
  }

  private historyLimit = 100;
  /** ISUPPORT BOT: the user mode that marks a bot, for example `B`. */
  private botMode: string | undefined;

  /**
   * Draft/read-marker: mark `target` (a channel, or a direct partner's
   * nick) read up to this server time. Best effort.
   */
  markRead(target: string, time: string) {
    if (
      this.options.presence?.readMarker === false ||
      !this.caps.has("draft/read-marker") ||
      !this.registeredNow
    )
      return;
    this.enqueue({
      lines: [formatMessage("MARKREAD", [target, `timestamp=${time}`])],
    });
  }

  /** After a (re)connect, fetch channel messages missed meanwhile. */
  private replay(channel: string) {
    this.history(
      channel,
      this.options.history
        ? this.options.history.channel(channel)
        : this.lastSeen.get(this.fold(channel)),
    );
  }

  private history(target: string, since: string | undefined) {
    const offered = chathistoryCaps.find((cap) => this.caps.has(cap));

    if (!offered || !since || !this.caps.has("batch")) return;
    this.enqueue({
      lines: [
        formatMessage("CHATHISTORY", [
          "AFTER",
          target,
          `timestamp=${since}`,
          String(this.historyLimit),
        ]),
      ],
    });
  }

  /** Direct messages: which partners wrote since the cursor (TARGETS). */
  private replayDirect() {
    const offered = chathistoryCaps.find((cap) => this.caps.has(cap));
    const since = this.options.history?.targets();

    if (!offered || !since || !this.caps.has("batch")) return;
    this.enqueue({
      lines: [
        formatMessage("CHATHISTORY", [
          "TARGETS",
          `timestamp=${since}`,
          `timestamp=${new Date().toISOString()}`,
          String(this.historyLimit),
        ]),
      ],
    });
  }
}

/** ISUPPORT values escape bytes as \\xHH (space, `=`, backslash). */
function isupportValue(value: string) {
  return value.replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
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
