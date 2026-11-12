import type { Logger } from "pino";
import { type BackendConfig, type IrcConfig, secret } from "../config";
import type { GatewayConfig, GatewayTransport } from "../gateway";
import { backendFingerprint, type Identity } from "../routing";
import type { Store } from "../store";
import { IrcClient, type IrcTiming } from "./client";
import { IrcDelivery } from "./delivery";
import { fold, type IrcMessage } from "./protocol";
import {
  type IrcMember,
  ircAllowed,
  ircNote,
  routeIrcMessage,
  withinLimits,
} from "./routing";

/** Everything the runtime needs to run one IRC connection's gateway. */
export type IrcRegistration = IrcMember & {
  settings: GatewayConfig;
  backend: BackendConfig;
  identity: Identity;
  transport: GatewayTransport;
  delivery: IrcDelivery;
  client: IrcClient;
  log: Logger;
};

/**
 * Namespace of one IRC connection: transport, registration, server (host,
 * port and the configured network name), account and backend settings.
 * Moving to another server starts a new outbox and session namespace.
 */
export function ircKey(
  id: string,
  server: Pick<IrcConfig["server"], "host" | "port" | "network">,
  account: string,
  backend: BackendConfig,
): string {
  return JSON.stringify([
    "irc",
    id,
    server.host.toLowerCase(),
    server.port,
    server.network === undefined ? null : fold(server.network),
    fold(account),
    backendFingerprint({ backend }),
  ]);
}

type ShipOptions = {
  env?: NodeJS.ProcessEnv;
  timing?: Partial<IrcTiming>;
  readyMs?: number;
};

/**
 * One `irc` registration: the captain connection plus one connection per
 * crew member, sharing server, access rules and turn limits. Crew join only
 * their configured channels; when one is invite-only, the captain
 * connection invites them. Invites to any other channel are ignored.
 *
 * Extension point (not implemented): captain-created breakout or tracking
 * channels would add a runtime grant set beside `crew[].channels`, a
 * captain tool to create the channel and grant members, and the same
 * join/invite path. Grants must stay captain-owned and auditable.
 */
export class IrcShip {
  readonly registrations: IrcRegistration[];
  private readonly controller = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private open: () => boolean = () => false;

  private constructor(
    private readonly config: IrcConfig,
    private readonly store: Store,
    private readonly log: Logger,
    ca: string | undefined,
    options: ShipOptions,
  ) {
    const env = options.env ?? process.env;
    const members = [
      {
        id: config.id,
        role: "captain" as const,
        account: config.account,
        nick: config.nick ?? config.account,
        channels: config.channels,
        passwordEnv: config.passwordEnv,
        backend: config.backend,
        settings: {
          displayName: config.displayName,
          concurrency: config.concurrency,
          turnTimeoutMs: config.turnTimeoutMs,
        },
      },
      ...config.crew.map((member) => ({
        id: `${config.id}-${member.id}`,
        role: "crew" as const,
        account: member.account,
        nick: member.nick ?? member.account,
        channels: member.channels,
        passwordEnv: member.passwordEnv,
        backend: member.backend,
        settings: {
          displayName: member.displayName ?? member.account,
          concurrency: member.concurrency,
          turnTimeoutMs: member.turnTimeoutMs,
        },
      })),
    ];
    const keys = members.map((member) =>
      ircKey(member.id, config.server, member.account, member.backend),
    );
    this.registrations = members.map((member, index) => {
      const key = keys[index] ?? "";
      const memberLog = log.child({ irc: member.id });
      const identity: IrcMember = {
        id: member.id,
        role: member.role,
        account: member.account,
        nick: member.nick,
        channels: member.channels,
        key,
      };
      const client: IrcClient = new IrcClient(
        {
          host: config.server.host,
          port: config.server.port,
          tls: config.server.tls,
          ...(ca ? { ca } : {}),
          ...(config.server.network ? { network: config.server.network } : {}),
          account: member.account,
          password: secret(member.passwordEnv, env),
          nick: member.nick,
          channels: member.channels,
          ...(member.role === "crew"
            ? { captainChannels: config.channels }
            : {}),
          log: memberLog,
          ...(options.timing ? { timing: options.timing } : {}),
        },
        {
          // Chathistory replays use the same rules; event IDs deduplicate.
          message: (message) => this.receive(identity, client, keys, message),
          invite: (channel) => {
            if (!client.join(channel))
              memberLog.info("Ignored IRC invite to an unlisted channel");
          },
          joinFailed: (channel, numeric) =>
            this.joinFailed(identity, channel, numeric),
        },
      );
      const settings: GatewayConfig = {
        id: member.id,
        ...(member.settings.displayName
          ? { displayName: member.settings.displayName }
          : {}),
        backend: member.backend,
        concurrency: member.settings.concurrency,
        turnTimeoutMs: member.settings.turnTimeoutMs,
        // IRC cannot edit a message: no waiting feedback or activity box.
        waiting: { delayMs: null, intervalMs: 10_000 },
        crewActivity: { detail: "off" },
      };
      return {
        ...identity,
        settings,
        backend: member.backend,
        identity: { team: `irc:${config.id}`, user: fold(member.account) },
        transport: {
          name: "irc",
          key,
          allowed: (user, channel) =>
            ircAllowed(config, identity, user, channel, client.fold),
          source: (job) => ({
            transport: "irc",
            channel: job.channel,
            thread: job.thread,
            message: job.eventId.slice(job.channel.length + 1),
            user: job.user,
            ...(job.sender ? { sender: job.sender } : {}),
          }),
          note: (job) => ircNote(job, config.access.allCallWords),
        },
        delivery: new IrcDelivery(client, options.readyMs),
        client,
        log: memberLog,
      };
    });
  }

  /** Reads the CA file and password references; never logs them. */
  static async create(
    config: IrcConfig,
    store: Store,
    log: Logger,
    options: ShipOptions = {},
  ) {
    const ca = config.server.caFile
      ? await Bun.file(config.server.caFile).text()
      : undefined;
    return new IrcShip(config, store, log, ca, options);
  }

  /** Start every connection; intake stores messages only while `open()`. */
  start(open: () => boolean) {
    this.open = open;
    for (const registration of this.registrations)
      this.loops.push(registration.client.run(this.controller.signal));
  }

  /** QUIT every connection and wait for the connection loops to end. */
  async close() {
    this.open = () => false;
    this.controller.abort();
    await Promise.all(this.loops);
  }

  private receive(
    member: IrcMember,
    client: IrcClient,
    keys: readonly string[],
    message: IrcMessage,
  ) {
    if (!this.open()) return;
    const admission = routeIrcMessage(message, {
      config: this.config,
      member,
      currentNick: client.nick,
      sent: (msgid) => client.sent(msgid),
      now: Date.now,
      fold: client.fold,
    });
    if (!admission) return;
    if (
      !withinLimits(
        admission,
        this.config,
        {
          shipKeys: keys,
          count: (input) => this.store.turnsSince(input),
        },
        client.fold,
      )
    ) {
      this.log.warn(
        { irc: member.id },
        admission.sender === "crew"
          ? "IRC ship message limit reached; message not admitted"
          : "IRC peer captain limit reached; message not admitted",
      );
      return;
    }
    this.store.enqueue(admission);
  }

  /** An invite-only ship channel: the captain invites its own crew. */
  private joinFailed(member: IrcMember, channel: string, numeric: string) {
    const captain = this.registrations[0];
    if (member.role !== "crew" || numeric !== "473" || !captain) {
      this.log.warn({ irc: member.id }, "IRC channel join refused");
      return;
    }
    const nick = this.registrations.find((item) => item.id === member.id)
      ?.client.nick;
    if (!nick || !captain.client.inChannel(channel)) return;
    captain.client
      .invite(nick, channel)
      .then(() => this.log.info({ irc: member.id }, "IRC captain invited crew"))
      .catch(() =>
        this.log.warn({ irc: member.id }, "IRC captain could not invite crew"),
      );
  }
}
