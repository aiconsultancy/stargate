import { setTimeout as delay } from "node:timers/promises";
import type { Socket, TCPSocketListener } from "bun";
import {
  formatMessage,
  type IrcMessage,
  parseMessage,
} from "../src/irc/protocol";

type Client = {
  socket: Socket<{ id: number }>;
  id: number;
  nick?: string;
  account?: string;
  caps: Set<string>;
  registered: boolean;
  buffer: string;
  lines: string[];
};

export type FakeIrcOptions = {
  caps?: string[];
  accounts?: Record<string, string>;
  inviteOnly?: string[];
  taken?: string[];
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
 * complete server; it implements what Pogo's client uses.
 */
export class FakeIrcServer {
  readonly clients: Client[] = [];
  readonly members = new Map<string, Set<Client>>();
  readonly invited = new Set<string>();
  /** Nicks held by someone else at registration time. */
  readonly taken: Set<string>;
  /** `account target` pairs whose PRIVMSG the server refuses (404). */
  readonly refuse = new Set<string>();
  /** Outside users by lower-case nick: their account, or null if none. */
  readonly users = new Map<string, string | null>();
  /** Connection IDs whose lines are recorded but never answered. */
  private readonly muted = new Set<number>();
  private listener: TCPSocketListener<{ id: number }> | undefined;
  private next = 0;
  private msgid = 0;
  readonly caps: string[];
  constructor(private readonly options: FakeIrcOptions = {}) {
    this.caps = options.caps ?? allCaps;
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
  ) {
    this.setUser(from.nick, from.account ?? null);
    const line = formatMessage("PRIVMSG", [target, text], {
      time: new Date().toISOString(),
      msgid: `m${++this.msgid}`,
      ...(from.account ? { account: from.account } : {}),
      ...tags,
    });
    const full = line.replace(
      /^(@\S+ )?/,
      (prefix) => `${prefix}:${from.nick}!u@outside `,
    );
    for (const client of this.recipients(target))
      client.socket.write(`${full}\r\n`);
    return `m${this.msgid}`;
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
          this.reply(client, `:${client.nick}!u@pogo NICK ${first}`);
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
                ? `:${client.nick}!u@pogo JOIN ${channel} ${client.account ?? "*"} :Pogo`
                : `:${client.nick}!u@pogo JOIN ${channel}`,
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
        this.reply(target, `:${client.nick}!u@pogo INVITE ${first} ${second}`);
        this.reply(
          client,
          labelled(`:fake 341 ${client.nick} ${first} ${second}`),
        );
        return;
      }
      case "PRIVMSG":
      case "TAGMSG": {
        const target = first;
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
            time: new Date().toISOString(),
            msgid: id,
            ...(client.account ? { account: client.account } : {}),
          }).replace(
            /^(@\S+ )?/,
            (prefix) => `${prefix}:${client.nick}!u@pogo `,
          );
        for (const other of this.recipients(target))
          if (other !== client) this.reply(other, out(false));
        if (client.caps.has("echo-message")) this.reply(client, out(true));
        else if (label !== undefined && client.caps.has("labeled-response"))
          this.reply(client, `@label=${label} :fake ACK`);
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
      case "CHATHISTORY":
        this.reply(client, `:fake BATCH +h chathistory ${second}`);
        this.reply(client, ":fake BATCH -h");
        return;
      case "QUIT":
        client.socket.end();
        return;
    }
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
      `:fake 005 ${client.nick} CHANTYPES=# CASEMAPPING=ascii NETWORK=Fleet :are supported`,
    );
    this.reply(client, `:fake 422 ${client.nick} :MOTD File is missing`);
  }
}

export async function until(
  check: () => boolean,
  timeoutMs = 3000,
  message = "condition",
) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${message}`);
    await delay(10);
  }
}

export function lineOf(lines: readonly string[], command: string) {
  return lines
    .map((line) => parseMessage(line))
    .filter((message): message is IrcMessage => message?.command === command);
}
