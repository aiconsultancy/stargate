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
  type Fold,
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
  /** Settings of the latest committed config; a reload replaces the object. */
  settings: GatewayConfig;
  backend: BackendConfig;
  identity: Identity;
  /**
   * Rules of the latest committed config. A reload replaces the object; an
   * earlier object keeps the rules of its own config version, so a turn can
   * keep the policy it started with.
   */
  transport: GatewayTransport;
  delivery: IrcDelivery;
  client: IrcClient;
  log: Logger;
};

/**
 * One staged reload of a ship (see `IrcShip.prepareReload`). Nothing
 * connects and nothing changes until `commit`.
 */
export type IrcReload = {
  /** New crew connections: built, not connected. */
  added: IrcRegistration[];
  /** Crew connections that `commit` detaches and stops. */
  removed: IrcRegistration[];
  /**
   * Synchronous. Throws, changing nothing, when a removed member is not
   * `idle`, the plan is stale or the ship is closed. Otherwise swaps the
   * config and roster at once, replaces each kept registration's
   * `transport` and `settings`, connects added members (when the ship has
   * started) and stops removed ones. A second call does nothing.
   */
  commit(idle: (key: string) => boolean): void;
  /** Resolves when the removed connections have ended; repeatable. */
  retire(): Promise<void>;
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

/** One configured connection of a ship: the captain or one crew member. */
type ShipMember = {
  id: string;
  role: "captain" | "crew";
  account: string;
  nick: string;
  channels: readonly string[];
  passwordEnv: string;
  backend: BackendConfig;
  displayName: string | undefined;
  concurrency: number;
  turnTimeoutMs: number;
};

/** Captain first, then crew in configuration order. */
function shipMembers(config: IrcConfig): ShipMember[] {
  return [
    {
      id: config.id,
      role: "captain",
      account: config.account,
      nick: config.nick ?? config.account,
      channels: config.channels,
      passwordEnv: config.passwordEnv,
      backend: config.backend,
      displayName: config.displayName,
      concurrency: config.concurrency,
      turnTimeoutMs: config.turnTimeoutMs,
    },
    ...config.crew.map((member) => ({
      id: `${config.id}-${member.id}`,
      role: "crew" as const,
      account: member.account,
      nick: member.nick ?? member.account,
      channels: member.channels,
      passwordEnv: member.passwordEnv,
      backend: member.backend,
      displayName: member.displayName ?? member.account,
      concurrency: member.concurrency,
      turnTimeoutMs: member.turnTimeoutMs,
    })),
  ];
}

/**
 * Everything a running connection and its gateway settings were built
 * from, except reloadable access and transcription settings. A reload
 * reuses a connection only when this is unchanged.
 */
function connection(config: IrcConfig, member: ShipMember) {
  return JSON.stringify([
    config.server,
    config.features,
    config.channels,
    member,
  ]);
}

function gatewaySettings(config: IrcConfig, member: ShipMember): GatewayConfig {
  return {
    id: member.id,
    ...(member.displayName ? { displayName: member.displayName } : {}),
    backend: member.backend,
    concurrency: member.concurrency,
    turnTimeoutMs: member.turnTimeoutMs,
    // IRC cannot edit a message: no waiting feedback or activity box.
    waiting: { delayMs: null, intervalMs: 10_000 },
    crewActivity: { detail: "off" },
    ...(config.transcription ? { transcription: config.transcription } : {}),
  };
}

/** Access rules and notes of one config version, never a later one. */
function shipTransport(
  config: IrcConfig,
  member: IrcMember,
  caseFold: Fold,
): GatewayTransport {
  return {
    name: "irc",
    key: member.key,
    allowed: (user, channel) =>
      ircAllowed(config, member, user, channel, caseFold),
    source: (job) => ({
      transport: "irc",
      channel: job.channel,
      thread: job.thread,
      message: job.eventId.slice(job.channel.length + 1),
      user: job.user,
      ...(job.sender ? { sender: job.sender } : {}),
    }),
    note: (job) => ircNote(job, config.access.allCallWords),
  };
}

/** Connection lifetime of one registration, inside the ship's lifetime. */
type Lifetime = { readonly controller: AbortController; loop?: Promise<void> };
type Built = { registration: IrcRegistration; lifetime: Lifetime };

/**
 * One `irc` registration: the captain connection plus one connection per
 * crew member, sharing server, access rules and turn limits. Crew join only
 * their configured channels; when one is invite-only, the captain
 * connection invites them. Invites to any other channel are ignored.
 *
 * Intake (admission, Stop and ship limits) always reads the latest
 * committed config. A reload (`prepareReload`) can change access and
 * transcription settings, add crew and remove idle crew; every other
 * change needs a restart.
 *
 * Extension point (not implemented): captain-created breakout or tracking
 * channels would add a runtime grant set beside `crew[].channels`, a
 * captain tool to create the channel and grant members, and the same
 * join/invite path. Grants must stay captain-owned and auditable.
 */
export class IrcShip {
  private current: IrcRegistration[] = [];
  private readonly lifetimes = new Map<IrcRegistration, Lifetime>();
  private readonly controller = new AbortController();
  /** Every connection loop that has not ended, removed ones included. */
  private readonly loops = new Set<Promise<void>>();
  private open: () => boolean = () => false;
  private started = false;
  private filehostConflict = false;

  private constructor(
    private config: IrcConfig,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly ca: string | undefined,
    private readonly options: ShipOptions,
  ) {
    const env = options.env ?? process.env;
    this.current = shipMembers(config).map((member) =>
      this.adopt(this.build(member, config, env)),
    );
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

  /** Captain first, then crew in configuration order. */
  get registrations(): readonly IrcRegistration[] {
    return this.current;
  }

  /** Keys of the current roster: ship limits count all of them. */
  get keys(): string[] {
    return this.current.map((registration) => registration.key);
  }

  /** Start every connection; intake stores messages only while `open()`. */
  start(open: () => boolean) {
    if (this.started) return;
    this.started = true;
    this.open = open;
    for (const registration of this.current) this.run(registration);
  }

  /**
   * QUIT every connection and wait for every connection loop to end,
   * including removed connections that are still closing. Repeatable.
   */
  async close() {
    this.open = () => false;
    this.controller.abort();
    await Promise.allSettled([...this.loops]);
  }

  /**
   * Stage a reload to `next`, a fully validated config of this
   * registration. Builds clients for added crew, reading their passwords
   * from `env`, but connects nothing and changes nothing. Throws, with no
   * change, when an added member's password reference is missing, the
   * registration ID changes, or a kept connection's settings change
   * (server, features, channels, or a member's account, nick, password
   * reference, backend, display name or limits): those need a restart.
   */
  prepareReload(next: IrcConfig, env: NodeJS.ProcessEnv): IrcReload {
    const base = this.config;
    if (next.id !== base.id)
      throw new Error("IRC registration ID changed; restart required");
    const previous = new Map(
      shipMembers(base).map((member) => [member.id, connection(base, member)]),
    );
    const current = new Map(this.current.map((item) => [item.id, item]));
    const slots: ({ member: ShipMember } & (
      | { kept: IrcRegistration }
      | { built: Built }
    ))[] = [];
    for (const member of shipMembers(next)) {
      const kept = current.get(member.id);
      if (!kept) {
        slots.push({ member, built: this.build(member, next, env) });
        continue;
      }
      if (previous.get(member.id) !== connection(next, member))
        throw new Error(
          `IRC connection settings of ${member.id} changed; restart required`,
        );
      slots.push({ member, kept });
    }
    const ids = new Set(slots.map(({ member }) => member.id));
    const removed = this.current.filter((item) => !ids.has(item.id));
    const added = slots.flatMap((slot) =>
      "built" in slot ? [slot.built] : [],
    );
    const stopping: Promise<void>[] = [];
    let committed = false;
    let retiring: Promise<void> | undefined;
    return {
      added: added.map(({ registration }) => registration),
      removed,
      commit: (idle) => {
        if (committed) return;
        if (this.controller.signal.aborted)
          throw new Error("IRC ship closed; reload not applied");
        if (this.config !== base)
          throw new Error("IRC reload plan is stale; prepare it again");
        const busy = removed.filter((item) => !idle(item.key));
        if (busy.length)
          throw new Error(
            `IRC crew busy: ${busy.map(({ id }) => id).join(", ")}; reload not applied`,
          );
        // One synchronous swap: nothing below throws.
        this.config = next;
        this.current = slots.map((slot) => {
          if ("built" in slot) return this.adopt(slot.built);
          slot.kept.transport = shipTransport(
            next,
            slot.kept,
            slot.kept.client.fold,
          );
          slot.kept.settings = gatewaySettings(next, slot.member);
          return slot.kept;
        });
        for (const registration of removed) {
          const lifetime = this.lifetimes.get(registration);
          this.lifetimes.delete(registration);
          lifetime?.controller.abort();
          if (lifetime?.loop !== undefined) stopping.push(lifetime.loop);
        }
        if (this.started)
          for (const { registration } of added) this.run(registration);
        committed = true;
      },
      retire: () => {
        if (!committed) return Promise.resolve();
        retiring ??= Promise.allSettled(stopping).then(() => {});
        return retiring;
      },
    };
  }

  private adopt({ registration, lifetime }: Built) {
    this.lifetimes.set(registration, lifetime);
    return registration;
  }

  /** Connect one registration once, within its own and the ship's lifetime. */
  private run(registration: IrcRegistration) {
    const lifetime = this.lifetimes.get(registration);
    if (
      !lifetime ||
      lifetime.loop !== undefined ||
      this.controller.signal.aborted
    )
      return;
    const loop = registration.client.run(
      AbortSignal.any([this.controller.signal, lifetime.controller.signal]),
    );
    lifetime.loop = loop;
    this.loops.add(loop);
    const ended = () => {
      this.loops.delete(loop);
    };
    loop.then(ended, ended);
  }

  /**
   * One connection and its gateway parts for `config`. Reads the password
   * first, so a missing reference throws before anything is built. Starts
   * nothing.
   */
  private build(
    member: ShipMember,
    config: IrcConfig,
    env: NodeJS.ProcessEnv,
  ): Built {
    const password = secret(member.passwordEnv, env);
    const key = ircKey(
      member.id,
      config.server,
      member.account,
      member.backend,
    );
    const memberLog = this.log.child({ irc: member.id });
    const identity: IrcMember = {
      id: member.id,
      role: member.role,
      account: member.account,
      nick: member.nick,
      channels: member.channels,
      key,
    };
    const lifetime: Lifetime = { controller: new AbortController() };
    // A removed connection's late events never count.
    const detached = () => lifetime.controller.signal.aborted;
    const ca = this.ca;
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
        ...(member.role === "crew" ? { captainChannels: config.channels } : {}),
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
        ...(this.options.timing ? { timing: this.options.timing } : {}),
      },
      {
        // Chathistory replays use the same rules; event IDs deduplicate.
        message: (message, replay) => {
          if (detached()) return;
          // A replayed reaction is old intent: it never stops a turn.
          if (message.command === "TAGMSG") {
            if (!replay) this.stop(registration, message);
          } else this.receive(identity, client, message, filehost, replay);
        },
        invite: (channel) => {
          if (detached()) return;
          if (!client.join(channel))
            memberLog.info("Ignored IRC invite to an unlisted channel");
        },
        joinFailed: (channel, numeric) => {
          if (!detached()) this.joinFailed(identity, client, channel, numeric);
        },
      },
    );
    const filehost = () => this.filehost(client);
    const files = new Filehost(filehost, {
      account: member.account,
      password,
      ...(ca ? { ca } : {}),
    });
    const registration: IrcRegistration = {
      ...identity,
      settings: gatewaySettings(config, member),
      backend: member.backend,
      identity: { team: `irc:${config.id}`, user: fold(member.account) },
      transport: shipTransport(config, identity, client.fold),
      delivery: new IrcDelivery(
        client,
        this.options.readyMs,
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
    return { registration, lifetime };
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
          shipKeys: this.keys,
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
  private stop(registration: IrcRegistration, message: IrcMessage) {
    if (!this.open() || !this.config.features.reactions) return;
    const client = registration.client;
    const stop = routeIrcStop(message, {
      config: this.config,
      member: registration,
      currentNick: client.nick,
      fold: client.fold,
      anchor: (msgid) => client.anchor(msgid),
    });
    if (!stop) return;
    if (registration.stopTurn?.(stop.conversation, stop.thread))
      this.log.info({ irc: registration.id }, "IRC Stop reaction accepted");
  }

  /** An invite-only ship channel: the captain invites its own crew. */
  private joinFailed(
    member: IrcMember,
    client: IrcClient,
    channel: string,
    numeric: string,
  ) {
    const captain = this.current[0];
    if (member.role !== "crew" || numeric !== "473" || !captain) {
      this.log.warn({ irc: member.id }, "IRC channel join refused");
      return;
    }
    const nick = client.nick;
    if (!nick || !captain.client.inChannel(channel)) return;
    captain.client
      .invite(nick, channel)
      .then(() => this.log.info({ irc: member.id }, "IRC captain invited crew"))
      .catch(() =>
        this.log.warn({ irc: member.id }, "IRC captain could not invite crew"),
      );
  }
}
