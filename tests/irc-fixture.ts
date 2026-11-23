import { onTestFinished } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import {
  formatMessage,
  type IrcMessage,
  parseMessage,
  utf8Bytes,
} from "../src/transports/irc/protocol";

type Client = {
  socket: Socket<{ id: number }>;
  id: number;
  nick?: string;
  account?: string;
  caps: Set<string>;
  registered: boolean;
  buffer: string;
  lines: string[];
  /** Outgoing draft/multiline batches being collected, by reference. */
  open?: Map<
    string,
    { target: string; tags: ReadonlyMap<string, string>; parts: IrcMessage[] }
  >;
};

export type FakeIrcOptions = {
  caps?: string[];
  accounts?: Record<string, string>;
  /** Server-authenticated bot tags, never client-supplied account labels. */
  botAccounts?: readonly string[];
  inviteOnly?: string[];
  taken?: string[];
  /** Extra ISUPPORT tokens, for example `soju.im/FILEHOST=…`. */
  isupport?: string[];
};

const allCaps = [
  "sasl=PLAIN",
  "account-tag",
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
  "account-notify",
  "extended-join",
  "draft/chathistory",
];

/**
 * A small IRCv3 server for tests: CAP 302, SASL PLAIN, labeled echo, channel
 * broadcast with account tags, invite-only channels and INVITE. Not a
 * complete server; it implements what Stargate's client uses.
 */
export class FakeIrcServer {
  /** Synthetic nickname metadata retained across reconnects, like always-on Ergo. */
  readonly metadata = new Map<string, string>();
  /** Return true to supply a custom acknowledgement or refusal in a test. */
  onMetadata: ((account: string, params: string[]) => boolean) | undefined;
  readonly clients: Client[] = [];
  readonly members = new Map<string, Set<Client>>();
  readonly invited = new Set<string>();
  /** Nicks held by someone else at registration time. */
  readonly taken: Set<string>;
  /** `account target` pairs whose PRIVMSG the server refuses (404). */
  readonly refuse = new Set<string>();
  /** `account target` pairs whose PRIVMSG is relayed without a sender receipt. */
  readonly holdMessageConfirmation = new Set<string>();
  /** Multiline batches the server accepted from clients. */
  readonly batches: {
    account: string | undefined;
    target: string;
    tags: ReadonlyMap<string, string>;
    lines: { text: string; concat: boolean }[];
  }[] = [];
  /** Every outside PRIVMSG, for CHATHISTORY (channels and direct messages). */
  readonly history: {
    from: string;
    target: string;
    time: string;
    line: string;
  }[] = [];
  /** CHATHISTORY requests received, as parameter lists. */
  readonly historyRequests: string[][] = [];
  /** Record CHATHISTORY requests but leave them unanswered. */
  holdHistory = false;
  /** Runs after each accepted PRIVMSG or multiline batch from a client. */
  onMessage:
    | ((account: string | undefined, target: string) => void)
    | undefined;
  /** Outside users by lower-case nick: their account, or null if none. */
  readonly users = new Map<string, string | null>();
  /** Connection IDs whose lines are recorded but never answered. */
  private readonly muted = new Set<number>();
  private listener: TCPSocketListener<{ id: number }> | undefined;
  private next = 0;
  private msgid = 0;
  readonly caps: string[];
  constructor(private readonly options: FakeIrcOptions = {}) {
    this.caps = [...(options.caps ?? allCaps)];
    this.taken = new Set(options.taken ?? []);
  }

  get port() {
    if (!this.listener) throw new Error("not started");

    return this.listener.port;
  }

  start() {
    this.listener = Bun.listen<{ id: number }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          socket.data = { id: ++this.next };
          this.clients.push({
            socket,
            id: socket.data.id,
            caps: new Set(),
            registered: false,
            buffer: "",
            lines: [],
          });
        },
        data: (socket, data) => {
          const client = this.clients.find((c) => c.socket === socket);

          if (!client) return;
          client.buffer += data.toString();
          let index = client.buffer.indexOf("\r\n");

          while (index >= 0) {
            const line = client.buffer.slice(0, index);
            client.buffer = client.buffer.slice(index + 2);
            client.lines.push(line);

            if (!this.muted.has(client.id)) this.handle(client, line);
            index = client.buffer.indexOf("\r\n");
          }
        },
        close: (socket) => {
          const client = this.clients.find((c) => c.socket === socket);

          if (client)
            for (const set of this.members.values()) set.delete(client);
        },
      },
    });

    return this;
  }

  stop() {
    for (const client of this.clients) client.socket.end();
    this.listener?.stop(true);
  }

  /** Lines received from every connection with this nick or account. */
  received(who: string) {
    return this.clients
      .filter((c) => c.nick === who || c.account === who)
      .flatMap((c) => c.lines);
  }

  /** Raw line to every connection of `account`. */
  sendTo(account: string, line: string) {
    for (const client of this.clients)
      if (client.account === account) client.socket.write(`${line}\r\n`);
  }

  /** Stop answering the current connections of `account`. */
  mute(account: string) {
    for (const client of this.clients)
      if (client.account === account) this.muted.add(client.id);
  }

  /** Drop every connection of `account` without a QUIT. */
  drop(account: string) {
    for (const client of this.clients)
      if (client.account === account) client.socket.terminate();
  }

  /** An outside nick now belongs to `account` (null: not logged in). */
  setUser(nick: string, account: string | null) {
    this.users.set(nick.toLowerCase(), account);
  }

  removeUser(nick: string) {
    this.users.delete(nick.toLowerCase());
  }

  /** A message from an outside user, with or without an account tag. */
  say(
    from: { nick: string; account?: string },
    target: string,
    text: string,
    tags: Record<string, string> = {},
    command: "PRIVMSG" | "NOTICE" = "PRIVMSG",
  ) {
    this.setUser(from.nick, from.account ?? null);

    const line = formatMessage(command, [target, text], {
      time: new Date().toISOString(),
      msgid: `m${++this.msgid}`,
      ...(from.account ? { account: from.account } : {}),
      ...tags,
    });

    const full = line.replace(
      /^(@\S+ )?/,
      (prefix) => `${prefix}:${from.nick}!u@outside `,
    );

    this.history.push({
      from: from.nick,
      target,
      time: tags["time"] ?? parseMessage(full)?.tags.get("time") ?? "",
      line: full,
    });

    for (const client of this.recipients(target))
      client.socket.write(`${full}\r\n`);

    return tags["msgid"] ?? `m${this.msgid}`;
  }

  private recipients(target: string) {
    if (target.startsWith("#")) return [...(this.members.get(target) ?? [])];

    return this.clients.filter((c) => c.nick === target && c.registered);
  }

  private reply(client: Client, line: string) {
    client.socket.write(`${line}\r\n`);
  }

  private handle(client: Client, line: string) {
    const message = parseMessage(line);

    if (!message) return;
    const label = message.tags.get("label");

    const labelled = (text: string) =>
      label !== undefined && client.caps.has("labeled-response")
        ? `@label=${label} ${text}`
        : text;

    const [first = "", second = ""] = message.params;

    switch (message.command) {
      case "METADATA": {
        const account = client.account ?? "";

        if (this.onMetadata?.(account, [...message.params])) return;
        const value = message.params[3];

        if (first !== "*" || second !== "SET" || message.params[2] !== "status")
          return;

        if (value !== undefined) {
          this.metadata.set(account, value);
          this.reply(
            client,
            `:fake 761 ${client.nick} ${client.nick} status * :${value}`,
          );
        } else {
          this.metadata.delete(account);
          this.reply(
            client,
            `:fake 766 ${client.nick} ${client.nick} status :Key deleted`,
          );
        }

        return;
      }

      case "CAP":
        if (first === "LS")
          this.reply(client, `:fake CAP * LS :${this.caps.join(" ")}`);
        else if (first === "REQ") {
          const names = second.split(" ");
          const offered = this.caps.map((cap) => cap.split("=")[0]);

          if (names.every((name) => offered.includes(name))) {
            for (const name of names) client.caps.add(name);
            this.reply(client, `:fake CAP * ACK :${second}`);
          } else this.reply(client, `:fake CAP * NAK :${second}`);
        } else if (first === "END") this.welcome(client);

        return;
      case "AUTHENTICATE":
        if (first === "PLAIN") this.reply(client, "AUTHENTICATE +");
        else {
          const [, account = "", password] = Buffer.from(first, "base64")
            .toString()
            .split("\0");

          if (this.options.accounts?.[account] === password) {
            client.account = account;
            this.reply(client, `:fake 900 * * ${account} :logged in`);
            this.reply(client, ":fake 903 * :SASL successful");
          } else this.reply(client, ":fake 904 * :SASL failed");
        }

        return;
      case "NICK":
        if (!client.registered && this.taken.has(first)) {
          this.reply(
            client,
            `:fake 433 * ${first} :Nickname is already in use`,
          );

          return;
        }

        if (client.registered) {
          this.reply(client, `:${client.nick}!u@stargate NICK ${first}`);
        }

        client.nick = first;

        return;
      case "PING":
        this.reply(client, `:fake PONG fake :${first}`);

        return;
      case "JOIN":
        for (const channel of first.split(",")) {
          if (
            this.options.inviteOnly?.includes(channel) &&
            !this.invited.has(`${client.account}:${channel}`)
          ) {
            this.reply(
              client,
              `:fake 473 ${client.nick} ${channel} :Cannot join (+i)`,
            );
            continue;
          }

          const set = this.members.get(channel) ?? new Set<Client>();
          set.add(client);
          this.members.set(channel, set);

          for (const member of set)
            this.reply(
              member,
              member.caps.has("extended-join")
                ? `:${client.nick}!u@stargate JOIN ${channel} ${client.account ?? "*"} :Stargate`
                : `:${client.nick}!u@stargate JOIN ${channel}`,
            );
        }

        return;
      case "INVITE": {
        const target = this.clients.find((c) => c.nick === first);

        if (!this.members.get(second)?.has(client) || !target) {
          this.reply(
            client,
            labelled(`:fake 442 ${client.nick} ${second} :Not on channel`),
          );

          return;
        }

        this.invited.add(`${target.account}:${second}`);
        this.reply(
          target,
          `:${client.nick}!u@stargate INVITE ${first} ${second}`,
        );
        this.reply(
          client,
          labelled(`:fake 341 ${client.nick} ${first} ${second}`),
        );

        return;
      }

      case "BATCH": {
        client.open ??= new Map();

        if (first.startsWith("+") && second === "draft/multiline") {
          client.open.set(first.slice(1), {
            target: message.params[2] ?? "",
            tags: message.tags,
            parts: [],
          });

          return;
        }

        const batch = client.open.get(first.slice(1));

        if (!first.startsWith("-") || !batch) return;
        client.open.delete(first.slice(1));

        return this.multiline(
          client,
          batch,
          message.tags.get("label") ?? batch.tags.get("label"),
        );
      }

      case "PRIVMSG":
      case "NOTICE":
      case "TAGMSG": {
        const target = first;
        const open = message.tags.get("batch");

        if (open !== undefined && client.open?.has(open)) {
          client.open.get(open)?.parts.push(message);

          return;
        }

        if (
          (target.startsWith("#") && !this.members.get(target)?.has(client)) ||
          this.refuse.has(`${client.account} ${target}`)
        ) {
          this.reply(
            client,
            labelled(`:fake 404 ${client.nick} ${target} :Cannot send`),
          );

          return;
        }

        const id = `m${++this.msgid}`;

        const tags = [...message.tags]
          .filter(([key]) => key.startsWith("+"))
          .map(([key, value]) => [key, value] as const);

        const out = (withLabel: boolean) =>
          formatMessage(message.command, [...message.params], {
            ...(withLabel && label !== undefined ? { label } : {}),
            ...Object.fromEntries(tags),
            ...(client.account &&
            this.options.botAccounts?.includes(client.account)
              ? { bot: "" }
              : {}),
            time: new Date().toISOString(),
            msgid: id,
            ...(client.account ? { account: client.account } : {}),
          }).replace(
            /^(@\S+ )?/,
            (prefix) => `${prefix}:${client.nick}!u@stargate `,
          );

        for (const other of this.recipients(target))
          if (other !== client) this.reply(other, out(false));

        if (
          message.command !== "PRIVMSG" ||
          !this.holdMessageConfirmation.has(`${client.account} ${target}`)
        ) {
          if (client.caps.has("echo-message")) this.reply(client, out(true));
          else if (label !== undefined && client.caps.has("labeled-response"))
            this.reply(client, `@label=${label} :fake ACK`);
        }

        if (message.command === "PRIVMSG")
          this.onMessage?.(client.account, target);

        return;
      }

      case "WHOIS": {
        const real = this.clients.find(
          (c) => c.registered && c.nick?.toLowerCase() === first.toLowerCase(),
        );

        const outside = this.users.get(first.toLowerCase());

        if (!real && outside === undefined) {
          this.reply(client, `:fake 401 ${client.nick} ${first} :No such nick`);
          this.reply(client, `:fake 318 ${client.nick} ${first} :End of WHOIS`);

          return;
        }

        const account = real ? real.account : outside;
        this.reply(client, `:fake 311 ${client.nick} ${first} u h * :someone`);

        if (account)
          this.reply(
            client,
            `:fake 330 ${client.nick} ${first} ${account} :is logged in as`,
          );
        this.reply(client, `:fake 318 ${client.nick} ${first} :End of WHOIS`);

        return;
      }

      case "CHATHISTORY": {
        this.historyRequests.push([...message.params]);

        if (this.holdHistory) return;

        const since = (value: string | undefined) =>
          value?.startsWith("timestamp=") ? value.slice(10) : "";

        const reference = `h${++this.msgid}`;

        if (first === "TARGETS") {
          const from = since(second);
          const partners = new Map<string, string>();

          for (const entry of this.history)
            if (
              entry.target.toLowerCase() === client.nick?.toLowerCase() &&
              entry.time > from
            )
              partners.set(entry.from, entry.time);
          this.reply(
            client,
            `:fake BATCH +${reference} draft/chathistory-targets`,
          );

          for (const [nick, time] of partners)
            this.reply(
              client,
              `@batch=${reference} :fake CHATHISTORY TARGETS ${nick} ${time}`,
            );
          this.reply(client, `:fake BATCH -${reference}`);

          return;
        }

        const target = second;
        const after = since(message.params[2]);
        const limit = Number(message.params[3] ?? 100);

        const matches = this.history
          .filter((entry) =>
            target.startsWith("#")
              ? entry.target === target
              : entry.from === target &&
                entry.target.toLowerCase() === client.nick?.toLowerCase(),
          )
          .filter((entry) => entry.time > after)
          .slice(0, limit);

        this.reply(client, `:fake BATCH +${reference} chathistory ${target}`);

        for (const entry of matches)
          this.reply(client, entry.line.replace(/^@/, `@batch=${reference};`));
        this.reply(client, `:fake BATCH -${reference}`);

        return;
      }

      case "QUIT":
        client.socket.end();

        return;
    }
  }

  /** Relay one client multiline batch as a server batch; echo it labeled. */
  private multiline(
    client: Client,
    batch: {
      target: string;
      tags: ReadonlyMap<string, string>;
      parts: IrcMessage[];
    },
    label: string | undefined,
  ) {
    const labelled = (text: string) =>
      label !== undefined && client.caps.has("labeled-response")
        ? `@label=${label} ${text}`
        : text;

    if (
      (batch.target.startsWith("#") &&
        !this.members.get(batch.target)?.has(client)) ||
      this.refuse.has(`${client.account} ${batch.target}`)
    ) {
      this.reply(
        client,
        labelled(":fake FAIL BATCH MULTILINE_INVALID :refused"),
      );

      return;
    }

    const lines = batch.parts.map((part) => ({
      text: part.params[1] ?? "",
      concat: part.tags.has("draft/multiline-concat"),
    }));

    // The advertised limits, counting each line's text and one byte per
    // Line break (at least what Ergo counts).
    const offer = this.caps
      .find((cap) => cap.startsWith("draft/multiline="))
      ?.slice("draft/multiline=".length);

    const limit = (key: string) =>
      Number(
        offer
          ?.split(",")
          .find((item) => item.startsWith(`${key}=`))
          ?.slice(key.length + 1) ?? Number.POSITIVE_INFINITY,
      );

    const bytes = lines.reduce(
      (sum, line, index) =>
        sum + utf8Bytes(line.text) + (index && !line.concat ? 1 : 0),
      0,
    );

    if (bytes > limit("max-bytes") || lines.length > limit("max-lines")) {
      this.reply(
        client,
        labelled(
          `:fake FAIL BATCH ${bytes > limit("max-bytes") ? "MULTILINE_MAX_BYTES" : "MULTILINE_MAX_LINES"} :too long`,
        ),
      );

      return;
    }

    const id = `m${++this.msgid}`;
    const reference = `s${this.msgid}`;
    this.batches.push({
      account: client.account,
      target: batch.target,
      tags: batch.tags,
      lines,
    });

    const clientTags = Object.fromEntries(
      [...batch.tags].filter(([key]) => key.startsWith("+")),
    );

    const emit = (to: Client, withLabel: boolean) => {
      const open = formatMessage(
        "BATCH",
        [`+${reference}`, "draft/multiline", batch.target],
        {
          ...(withLabel && label !== undefined ? { label } : {}),
          ...clientTags,
          ...(client.account &&
          this.options.botAccounts?.includes(client.account)
            ? { bot: "" }
            : {}),
          time: new Date().toISOString(),
          msgid: id,
          ...(client.account ? { account: client.account } : {}),
        },
      ).replace(/^(@\S+ )/, (prefix) => `${prefix}:${client.nick}!u@stargate `);

      this.reply(to, open);

      for (const line of lines)
        this.reply(
          to,
          formatMessage("PRIVMSG", [batch.target, line.text], {
            batch: reference,
            ...(line.concat ? { "draft/multiline-concat": "" } : {}),
          }).replace(
            /^(@\S+ )/,
            (prefix) => `${prefix}:${client.nick}!u@stargate `,
          ),
        );
      this.reply(to, `BATCH -${reference}`);
    };

    for (const other of this.recipients(batch.target))
      if (other !== client) emit(other, false);

    if (client.caps.has("echo-message")) emit(client, true);
    else if (label !== undefined)
      this.reply(client, `@label=${label} :fake ACK`);
    this.onMessage?.(client.account, batch.target);
  }

  /** A multiline batch from an outside user, as the server relays it. */
  sayLines(
    from: { nick: string; account?: string },
    target: string,
    lines: { text: string; concat?: boolean }[],
  ) {
    const id = `m${++this.msgid}`;
    const reference = `u${this.msgid}`;
    this.setUser(from.nick, from.account ?? null);

    const prefix = (line: string) =>
      line.replace(/^(@\S+ )/, (tags) => `${tags}:${from.nick}!u@outside `);

    for (const client of this.recipients(target)) {
      client.socket.write(
        `${prefix(
          formatMessage("BATCH", [`+${reference}`, "draft/multiline", target], {
            time: new Date().toISOString(),
            msgid: id,
            ...(from.account ? { account: from.account } : {}),
          }),
        )}\r\n`,
      );

      for (const line of lines)
        client.socket.write(
          `${prefix(
            formatMessage("PRIVMSG", [target, line.text], {
              batch: reference,
              ...(line.concat ? { "draft/multiline-concat": "" } : {}),
            }),
          )}\r\n`,
        );
      client.socket.write(`BATCH -${reference}\r\n`);
    }

    return id;
  }

  private welcome(client: Client) {
    if (!client.account || !client.nick) {
      this.reply(client, "ERROR :SASL required");
      client.socket.end();

      return;
    }

    client.registered = true;
    this.reply(client, `:fake 001 ${client.nick} :Welcome`);
    this.reply(
      client,
      `:fake 005 ${client.nick} CHANTYPES=# CASEMAPPING=ascii NETWORK=Fleet${(this.options.isupport ?? []).map((token) => ` ${token}`).join("")} :are supported`,
    );
    this.reply(client, `:fake 422 ${client.nick} :MOTD File is missing`);
  }
}

export function until(
  check: () => boolean,
  timeoutMs = 3000,
  message = "condition",
  options: { state?: () => unknown; signal?: AbortSignal } = {},
) {
  return new Promise<void>((resolve, reject) => {
    const started = performance.now();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      active = false;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    };

    // An ended test must neither reject later nor resume its stale body.
    // Leave its await suspended, with no timer or predicate work remaining.
    try {
      onTestFinished(stop);
    } catch (error) {
      // The smoke script also imports this fixture outside the test runner.
      if (
        !(error instanceof Error) ||
        !error.message.startsWith(
          "Cannot use onTestFinished() outside of the test runner.",
        )
      )
        throw error;
    }

    const poll = () => {
      if (!active) return;

      try {
        const ready = check();
        const state = options.state?.() ?? ready;

        if (ready) {
          stop();
          resolve();

          return;
        }

        const elapsed = performance.now() - started;

        if (elapsed > timeoutMs) {
          stop();
          reject(
            new Error(
              `Timed out waiting for ${message} after ${Math.round(elapsed)} ms (limit ${timeoutMs} ms); last state: ${JSON.stringify(state)}`,
            ),
          );

          return;
        }

        timer = setTimeout(poll, 10);
      } catch (error) {
        stop();
        reject(error);
      }
    };

    if (options.signal?.aborted) {
      stop();

      return;
    }

    options.signal?.addEventListener("abort", stop, { once: true });
    poll();
  });
}

export function lineOf(lines: readonly string[], command: string) {
  return lines
    .map((line) => parseMessage(line))
    .filter((message): message is IrcMessage => message?.command === command);
}

type HostedFile = { type: string; body: Uint8Array; name: string };

/**
 * A FILEHOST (soju.im/FILEHOST) server for tests on 127.0.0.1: HTTP Basic
 * with the IRC accounts' SASL passwords, POST /upload → 201 + relative
 * Location, GET/HEAD of stored files, and a few hostile routes.
 */
export class FakeFilehost {
  readonly requests: {
    method: string;
    path: string;
    user: string | undefined;
    type: string | null;
    disposition: string | null;
  }[] = [];
  readonly files = new Map<string, HostedFile>();
  private server: ReturnType<typeof Bun.serve> | undefined;
  private next = 0;
  /**
   * Answer the next `failUploads` uploads with `failStatus`. A 5xx comes
   * after the file was stored, as a server failing late would answer.
   */
  failUploads = 0;
  failStatus = 503;
  /** Runs after each successful upload, before its response. */
  onUpload: (() => void | Promise<void>) | undefined;
  /** Location sent for uploads instead of the stored file's path. */
  uploadLocation: string | undefined;

  constructor(private readonly accounts: Record<string, string>) {}

  start() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });

    return this;
  }

  stop() {
    void this.server?.stop(true);
  }

  get origin() {
    if (!this.server) throw new Error("not started");

    return `http://127.0.0.1:${this.server.port}`;
  }

  get uploadURL() {
    return `${this.origin}/upload`;
  }

  put(path: string, file: HostedFile) {
    this.files.set(path, file);

    return `${this.origin}${path}`;
  }

  private async handle(request: Request) {
    const url = new URL(request.url);
    const header = request.headers.get("authorization") ?? "";

    const [user, password] = header.startsWith("Basic ")
      ? Buffer.from(header.slice(6), "base64").toString().split(":")
      : [];

    this.requests.push({
      method: request.method,
      path: url.pathname,
      user,
      type: request.headers.get("content-type"),
      disposition: request.headers.get("content-disposition"),
    });

    if (!user || this.accounts[user] !== password)
      return new Response("auth", { status: 401 });

    if (url.pathname === "/redirect")
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/x" },
      });

    if (url.pathname === "/upload" && request.method === "POST") {
      const failing = this.failUploads > 0;

      if (failing) this.failUploads--;

      if (failing && this.failStatus < 500)
        return new Response("refused", { status: this.failStatus });

      const name =
        /filename="([^"]+)"/.exec(
          request.headers.get("content-disposition") ?? "",
        )?.[1] ?? "file";

      const path = `/files/${++this.next}-${name}`;
      this.files.set(path, {
        name,
        type: request.headers.get("content-type") ?? "application/octet-stream",
        body: new Uint8Array(await request.arrayBuffer()),
      });

      if (failing) return new Response("failed", { status: this.failStatus });
      await this.onUpload?.();

      return new Response(null, {
        status: 201,
        headers: { location: this.uploadLocation ?? path },
      });
    }

    const file = this.files.get(url.pathname);

    if (!file || !["GET", "HEAD"].includes(request.method))
      return new Response("missing", { status: 404 });

    return new Response(
      request.method === "HEAD" ? null : new Uint8Array(file.body),
      {
        headers: { "content-type": file.type },
      },
    );
  }
}
