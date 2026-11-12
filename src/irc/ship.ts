import type { Logger } from "pino";
import { type BackendConfig, type IrcConfig, secret } from "../config";
import type { GatewayConfig, GatewayTransport } from "../gateway";
import { backendFingerprint, type Identity } from "../routing";
import type { Store } from "../store";
import { IrcClient, type IrcTiming } from "./client";
import { IrcDelivery } from "./delivery";
import { Filehost, filehostURL } from "./filehost";
import { fold, type IrcMessage, sourceNick } from "./protocol";
import {
  type IrcMember,
  ircAllowed,
  ircNote,
  routeIrcMessage,
  routeIrcStop,
  withinLimits,
} from "./routing";

/** Everything the runtime needs to run one IRC connection's gateway. */
export type IrcRegistration = IrcMember & {
  /** Set by the runtime: stop the active turn of one request. */
  stopTurn?: (conversation: string, thread: string) => boolean;
  /** Effective FILEHOST upload URL now, or undefined. */
  filehost(): URL | undefined;
  settings: GatewayConfig;
  backend: BackendConfig;
  identity: Identity;
  transport: GatewayTransport;
  delivery: IrcDelivery;
  client: IrcClient;
  log: Logger;
};

/**
 * Catch-up cursor names besides folded channel names: the direct-message
 * baseline (set once, on the first start) and one per direct-message
 * partner (folded nick; nicks never contain `:`). The registration key
 * already names the own account.
 */
const directBaseline = "";
const partnerCursor = (nick: string) => `dm:${nick}`;

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
      const password = secret(member.passwordEnv, env);
      const client: IrcClient = new IrcClient(
        {
          host: config.server.host,
          port: config.server.port,
          tls: config.server.tls,
          ...(ca ? { ca } : {}),
          ...(config.server.network ? { network: config.server.network } : {}),
          account: member.account,
          password,
          nick: member.nick,
          channels: member.channels,
          ...(member.role === "crew"
            ? { captainChannels: config.channels }
            : {}),
          multiline: config.features.multiline,
          catchUp: config.features.catchUp,
          presence: {
            alwaysOn: config.features.alwaysOn,
            botMode: config.features.botMode,
            readMarker: config.features.readMarker,
          },
          history: {
            channel: (name) => this.since(key, client.fold(name)),
            targets: () => this.since(key, directBaseline),
            direct: (nick, latest) =>
              this.partnerSince(key, partnerCursor(client.fold(nick)), latest),
          },
          log: memberLog,
          ...(options.timing ? { timing: options.timing } : {}),
        },
        {
          // Chathistory replays use the same rules; event IDs deduplicate.
          message: (message, replay) => {
            // A replayed reaction is old intent: it never stops a turn.
            if (message.command === "TAGMSG") {
              if (!replay) this.stop(identity, client, message);
            } else
              this.receive(identity, client, keys, message, filehost, replay);
          },
          invite: (channel) => {
            if (!client.join(channel))
              memberLog.info("Ignored IRC invite to an unlisted channel");
          },
          joinFailed: (channel, numeric) =>
            this.joinFailed(identity, channel, numeric),
        },
      );
      const filehost = () => this.filehost(client);
      const files = new Filehost(filehost, {
        account: member.account,
        password,
        ...(ca ? { ca } : {}),
      });
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
        ...(config.transcription
          ? { transcription: config.transcription }
          : {}),
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
        delivery: new IrcDelivery(
          client,
          options.readyMs,
          {
            files,
            filehost,
            download: config.features.filesIn,
            upload: config.features.filesOut,
          },
          {
            plan: (unit, plan) =>
              this.store.deliveryPlan(unit.job, unit.part, plan),
            replan: (unit, plan) =>
              this.store.replaceDeliveryPlan(unit.job, unit.part, plan),
            done: (unit, done) =>
              this.store.deliveredUnits(unit.job, unit.part, done),
          },
          {
            typing: config.features.typing,
            reactions: config.features.reactions,
          },
        ),
        filehost,
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

  /**
   * The FILEHOST to use now: the advertised one (soju.im/FILEHOST or
   * draft/FILEHOST), else `server.filehostOverride`. An advertised origin
   * that differs from the override turns files off, with one warning.
   */
  private filehost(client: IrcClient): URL | undefined {
    const secure = this.config.server.tls;
    const advertised = client.filehost
      ? filehostURL(client.filehost, secure)
      : undefined;
    const configured = this.config.server.filehostOverride;
    const override = configured ? filehostURL(configured, secure) : undefined;
    if (advertised && override && advertised.origin !== override.origin) {
      if (!this.filehostConflict)
        this.log.warn(
          "IRC FILEHOST differs from filehostOverride; files are off",
        );
      this.filehostConflict = true;
      return;
    }
    return advertised ?? override;
  }
  private filehostConflict = false;

  /**
   * Catch-up start for one target: the stored cursor, but never older than
   * `catchUpHours`. Without a cursor this is a first start: the cursor is
   * set to now and nothing older is replayed.
   */
  private since(key: string, target: string) {
    if (!this.config.features.catchUp) return;
    const cursor = this.store.ircCursor(key, target);
    const now = new Date();
    if (!cursor) {
      this.store.saveIrcCursor(key, target, now.toISOString());
      return;
    }
    const oldest = now.getTime() - this.config.catchUpHours * 3_600_000;
    const at = Date.parse(cursor);
    return new Date(
      Math.max(Number.isFinite(at) ? at : oldest, oldest),
    ).toISOString();
  }

  /**
   * Catch-up start for one direct-message partner: its own cursor, else
   * the direct-message baseline (first start), never older than
   * `catchUpHours`. Undefined when nothing is newer than the cursor.
   */
  private partnerSince(key: string, target: string, latest?: string) {
    if (!this.config.features.catchUp) return;
    const cursor =
      this.store.ircCursor(key, target) ??
      this.store.ircCursor(key, directBaseline);
    if (!cursor) return;
    if (latest && Number.isFinite(Date.parse(latest)) && latest <= cursor)
      return;
    const oldest = Date.now() - this.config.catchUpHours * 3_600_000;
    const at = Date.parse(cursor);
    return new Date(
      Math.max(Number.isFinite(at) ? at : oldest, oldest),
    ).toISOString();
  }

  private receive(
    member: IrcMember,
    client: IrcClient,
    keys: readonly string[],
    message: IrcMessage,
    filehost: () => URL | undefined,
    replay = false,
  ) {
    if (!this.open()) return;
    const time = message.tags.get("time");
    const oldest = Date.now() - this.config.catchUpHours * 3_600_000;
    if (replay && (!time || Date.parse(time) < oldest)) return;
    const admission = routeIrcMessage(message, {
      config: this.config,
      member,
      currentNick: client.nick,
      sent: (msgid) => client.sent(msgid),
      now: Date.now,
      fold: client.fold,
      filehost: this.config.features.filesIn ? filehost() : undefined,
    });
    if (!admission) {
      this.advance(member, client, message);
      return;
    }
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
      this.advance(member, client, message);
      return;
    }
    this.store.enqueue(admission);
    this.advance(member, client, message);
    // Accepted: tell the server's read marker (channel, or the partner).
    const target = message.params[0] ?? "";
    if (time)
      client.markRead(
        client.isChannel(target) ? target : sourceNick(message.source),
        time,
      );
  }

  /**
   * Move the catch-up cursor of the message's channel, or of its direct-
   * message partner, after the message has been stored or refused, never
   * before: a stop between the two replays it. Each partner has its own
   * cursor, so one partner's newer message never skips another's.
   */
  private advance(member: IrcMember, client: IrcClient, message: IrcMessage) {
    const time = message.tags.get("time");
    const target = message.params[0] ?? "";
    if (!time || !Number.isFinite(Date.parse(time))) return;
    if (client.isChannel(target)) {
      if (client.channel(target))
        this.store.saveIrcCursor(member.key, client.fold(target), time);
    } else if (client.fold(target) === client.fold(client.nick)) {
      const partner = sourceNick(message.source);
      if (partner)
        this.store.saveIrcCursor(
          member.key,
          partnerCursor(client.fold(partner)),
          time,
        );
    }
  }

  /** A Stop reaction from a person stops that request's active turn. */
  private stop(member: IrcMember, client: IrcClient, message: IrcMessage) {
    if (!this.open() || !this.config.features.reactions) return;
    const stop = routeIrcStop(message, {
      config: this.config,
      member,
      currentNick: client.nick,
      fold: client.fold,
      anchor: (msgid) => client.anchor(msgid),
    });
    if (!stop) return;
    const registration = this.registrations.find(
      (item) => item.id === member.id,
    );
    if (registration?.stopTurn?.(stop.conversation, stop.thread))
      this.log.info({ irc: member.id }, "IRC Stop reaction accepted");
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
