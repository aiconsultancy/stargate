import { createHash } from "node:crypto";
import type { AgentBackend } from "./backend";
import {
  type BotConfig,
  effectiveIrcConfig,
  type IrcConfig,
  type TeamsConfig,
} from "./config";
import type { FleetCrewStatus } from "./crew/fleet-status";
import type { CrewStatus, CrewStatusInput } from "./crew-status";
import type { CronStore } from "./cron-store";
import type {
  DashboardCaptain,
  DashboardSource,
  DashboardTransport,
  ShipSummary,
  ShipView,
} from "./dashboard-model";
import {
  dashboardCrewMembers,
  dashboardCrewSummary,
} from "./dashboard-projection";
import type { IrcRegistration } from "./irc/ship";
import { backendFingerprint, type Identity } from "./routing";
import {
  HISTORY_PAGE,
  type HistorySession,
  type SessionHistory,
} from "./session-history";
import type { Store } from "./store";

export type DashboardShip = {
  bot: Pick<
    BotConfig,
    "id" | "displayName" | "backend" | "concurrency" | "turnTimeoutMs"
  > & {
    slack?: BotConfig["slack"];
    access?: NonNullable<ShipView["bot"]["access"]>;
    cronjobs?: BotConfig["cronjobs"];
  };
  identity: Identity;
  /** `botKey(bot, identity)`: the queue, session and cron namespace. */
  key: string;
  backend: AgentBackend;
  transport?: DashboardTransport;
};

/** Existing runtime objects only: no extra connection, backend or native root. */
export function ircDashboardShip(
  registration: IrcRegistration,
  configured: IrcConfig,
  backend: AgentBackend,
): DashboardShip {
  const config = effectiveIrcConfig(configured);
  return {
    bot: registration.settings,
    identity: registration.identity,
    key: registration.key,
    backend,
    transport: {
      kind: "irc",
      host: config.server.host,
      port: config.server.port,
      tls: config.server.tls,
      ...(config.server.network ? { network: config.server.network } : {}),
      account: registration.account,
      nick: registration.nick,
      channels: [...registration.channels],
      access: {
        ...(config.access.allowedAccounts
          ? { allowedAccounts: [...config.access.allowedAccounts] }
          : {}),
        deniedAccounts: [...config.access.deniedAccounts],
        deniedChannels: [...config.access.deniedChannels],
        ...(config.access.channelRequests
          ? { channelRequests: config.access.channelRequests }
          : {}),
        ...(config.access.wakeChannels
          ? { wakeChannels: [...config.access.wakeChannels] }
          : {}),
        ...(registration.role === "captain" && config.access.humanWakeChannels
          ? {
              humanWakeChannels: config.access.humanWakeChannels.map(
                (rule) => ({ ...rule }),
              ),
            }
          : {}),
        peerCaptains: [...config.access.peerCaptains],
      },
    },
  };
}

export function teamsDashboardShip(
  config: TeamsConfig,
  key: string,
  backend: AgentBackend,
): DashboardShip {
  return {
    bot: config,
    identity: { team: config.tenantId, user: config.botClientId },
    key,
    backend,
    transport: {
      kind: "teams",
      tenantId: config.tenantId,
      botClientId: config.botClientId,
    },
  };
}

const RECENT = 20;
const ROOT_CACHE_MS = 10_000;
/** Subagents of subagents are rare; a deeper chain is refused, not followed. */
const MAX_DEPTH = 8;
type CrewRead = {
  status: CrewStatus | null;
  error?: string;
  metadata?: FleetCrewStatus["metadata"];
};

/**
 * Read-only composition of gateway state for the dashboard. This module owns
 * session scope: a viewer may read a session only when it is one of the ship's
 * roots (its pinned or mapped gateway sessions, or its crew roots) or a
 * descendant of one. Backends answer metadata; they do not decide scope.
 */
export function dashboardSource(
  ships: readonly DashboardShip[],
  store: Pick<
    Store,
    "queueCounts" | "recentJobs" | "sessionIDs" | "ownsSession"
  >,
  cronStore: Pick<CronStore, "report" | "recentRuns">,
  now: () => number = Date.now,
) {
  const crewRoots = new WeakMap<
    DashboardShip,
    { at: number; sessions: HistorySession[] }
  >();

  const find = (id: string) => ships.find((ship) => ship.bot.id === id);
  const name = (ship: DashboardShip) => ship.bot.displayName ?? ship.bot.id;
  const agent = (ship: DashboardShip) =>
    ship.bot.backend.type === "opencode" ? ship.bot.backend.agent : undefined;

  // Rebuild once per request: reloads can replace the live registrations.
  function captains() {
    const buckets = new Map<
      string,
      { pinned: string; fingerprint: string; members: DashboardShip[] }
    >();
    for (const ship of ships) {
      if (ship.bot.backend.type !== "opencode" || !ship.backend.sessionID)
        continue;
      const pinned = ship.backend.sessionID;
      const fingerprint = backendFingerprint(ship.bot);
      const key = JSON.stringify([pinned, fingerprint]);
      const bucket = buckets.get(key);
      if (bucket) bucket.members.push(ship);
      else buckets.set(key, { pinned, fingerprint, members: [ship] });
    }
    const groups = new Map<
      DashboardShip,
      { view: DashboardCaptain; members: DashboardShip[] }
    >();
    const kind = (ship: DashboardShip) => ship.transport?.kind ?? "slack";
    for (const { pinned, fingerprint, members } of buckets.values()) {
      // Keep ambiguous same-kind/tenant registrations separate defensively.
      if (
        members.length < 2 ||
        new Set(members.map(kind)).size !== members.length
      )
        continue;
      const ordered = [...members].sort((a, b) =>
        a.bot.id.localeCompare(b.bot.id),
      );
      const primary =
        ordered.find((entry) => entry.transport?.kind === "irc") ?? ordered[0];
      if (!primary) continue;
      const view: DashboardCaptain = {
        key: createHash("sha256")
          .update(
            JSON.stringify([
              fingerprint,
              pinned,
              ordered.map((entry) => entry.key),
            ]),
          )
          .digest("hex"),
        id: primary.bot.id,
        name: name(primary),
        registrations: ordered.map((entry) => ({
          id: entry.bot.id,
          name: name(entry),
          transport: kind(entry),
        })),
      };
      const group = {
        view,
        members: [primary, ...ordered.filter((entry) => entry !== primary)],
      };
      for (const member of members) groups.set(member, group);
    }
    return groups;
  }

  async function crew(
    ship: DashboardShip,
    signal: AbortSignal,
    fleetInput?: CrewStatusInput,
  ): Promise<CrewRead> {
    if (!ship.backend.crewStatus) return { status: null };
    try {
      if (fleetInput && ship.backend.fleetCrewStatus) {
        const result = await ship.backend.fleetCrewStatus(fleetInput, signal);
        if (result) return result;
      }
      return {
        status: await ship.backend.crewStatus(fleetInput ?? {}, signal),
      };
    } catch {
      signal.throwIfAborted();
      return { status: null, error: "Crew status unavailable." };
    }
  }

  /** A failed read is not cached, so the next request asks the backend again. */
  async function crewSessions(
    ship: DashboardShip,
    history: SessionHistory,
    signal: AbortSignal,
  ) {
    const cached = crewRoots.get(ship);
    if (cached && now() - cached.at < ROOT_CACHE_MS) return cached.sessions;
    const sessions = await history.roots(signal);
    crewRoots.set(ship, { at: now(), sessions });
    return sessions;
  }

  async function allowed(
    ship: DashboardShip,
    history: SessionHistory,
    sessionID: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    let crewIDs: Set<string> | undefined;
    let current = sessionID;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (
        current === ship.backend.sessionID ||
        store.ownsSession(ship.key, current)
      )
        return true;
      // Unreadable crew roots deny crew sessions; they never widen access.
      crewIDs ??= new Set(
        (await crewSessions(ship, history, signal).catch(() => [])).map(
          (session) => session.id,
        ),
      );
      signal.throwIfAborted();
      if (crewIDs.has(current)) return true;
      const [session] = await history.describe([current], signal);
      if (session?.id !== current || !session.parentID) return false;
      current = session.parentID;
    }
    return false;
  }

  async function roots(
    ship: DashboardShip,
    signal: AbortSignal,
  ): Promise<Pick<ShipView, "sessions" | "sessionsMore" | "sessionsError">> {
    const history = ship.backend.history;
    if (!history)
      return {
        sessions: [],
        sessionsMore: false,
        sessionsError: "Session history is not available for this backend.",
      };
    const pinned = ship.backend.sessionID;
    // One row beyond the page shows that older conversation roots exist.
    const mapped = store
      .sessionIDs(ship.key, HISTORY_PAGE + 1)
      .filter((id) => id !== pinned);
    const capacity = HISTORY_PAGE - (pinned ? 1 : 0);
    const ids = [...(pinned ? [pinned] : []), ...mapped.slice(0, capacity)];
    const sessionsMore = mapped.length > capacity;
    let error: string | undefined;
    let gateway: HistorySession[] = [];
    try {
      const described = ids.length ? await history.describe(ids, signal) : [];
      // Keep gateway order; the backend may answer in any order.
      gateway = ids.flatMap((id) => {
        const session = described.find((item) => item.id === id);
        return session
          ? [
              {
                ...session,
                kind: id === pinned ? ("captain" as const) : session.kind,
              },
            ]
          : [];
      });
    } catch {
      signal.throwIfAborted();
      error = "Session history unavailable.";
    }
    let members: HistorySession[] = [];
    try {
      members = await crewSessions(ship, history, signal);
    } catch {
      signal.throwIfAborted();
      // A bot without a crew has no crew roots to report.
      if (ship.backend.crewStatus) error ??= "Crew sessions unavailable.";
    }
    const captain = gateway.filter((session) => session.kind === "captain");
    const others = gateway.filter((session) => session.kind !== "captain");
    return {
      sessions: [...captain, ...members, ...others],
      sessionsMore,
      ...(error ? { sessionsError: error } : {}),
    };
  }

  async function readFleet(
    signal: AbortSignal,
    selected?: ReadonlySet<string>,
  ) {
    const groups = captains();
    const reads = new Map<
      DashboardShip | DashboardCaptain,
      Promise<CrewRead>
    >();
    function sharedCrew(ship: DashboardShip): Promise<CrewRead> {
      const group = groups.get(ship);
      const key = group?.view ?? ship;
      const existing = reads.get(key);
      if (existing !== undefined) return existing;
      const read: Promise<CrewRead> = (async (): Promise<CrewRead> => {
        let last: CrewRead = { status: null };
        // One successful read per pinned captain. Retry an exact alias only
        // after a failure; queue and transcript ownership are never shared.
        for (const member of group?.members ?? [ship]) {
          const result = await crew(member, signal, selected ? {} : undefined);
          if (result.status) return result;
          if (result.error) last = result;
        }
        return last;
      })();
      reads.set(key, read);
      return read;
    }
    const summaries = await Promise.all(
      ships
        .filter((ship) => !selected || selected.has(ship.bot.id))
        .map(async (ship) => {
          const read = await sharedCrew(ship);
          const named = agent(ship);
          const captainView = groups.get(ship)?.view;
          const summary: ShipSummary = {
            id: ship.bot.id,
            name: name(ship),
            backend: ship.bot.backend.type,
            ...(ship.transport ? { transport: ship.transport.kind } : {}),
            ...(named ? { agent: named } : {}),
            crew: read.status && dashboardCrewSummary(read.status),
            ...(captainView ? { captain: captainView } : {}),
            queue: store.queueCounts(ship.key),
            cronjobs: cronStore.report(ship.key).length,
          };
          return {
            summary,
            ...(selected && read.status
              ? { members: dashboardCrewMembers(read.status) }
              : {}),
            ...(read.error ? { error: read.error } : {}),
            ...(read.metadata ? { metadata: read.metadata } : {}),
            ...(selected
              ? {
                  readDetail: (reading: AbortSignal) =>
                    readShip(ship.bot.id, reading, {}, read),
                }
              : {}),
          };
        }),
    );
    return { generatedAt: now(), ships: summaries };
  }

  async function readShip(
    id: string,
    signal: AbortSignal,
    fleetInput?: CrewStatusInput,
    sample?: CrewRead,
  ): Promise<{ view: ShipView; metadata?: CrewRead["metadata"] } | undefined> {
    const ship = find(id);
    if (!ship) return undefined;
    const { bot } = ship;
    const [{ status, error, metadata }, sessions] = await Promise.all([
      sample ?? crew(ship, signal, fleetInput),
      roots(ship, signal),
    ]);
    const named = agent(ship);
    const model =
      bot.backend.type === "opencode"
        ? bot.backend.model &&
          `${bot.backend.model.providerID}/${bot.backend.model.id}`
        : bot.backend.type === "pi-durable" ||
            bot.backend.type === "claude" ||
            bot.backend.type === "codex"
          ? bot.backend.model
          : undefined;
    const report = bot.cronjobs?.dailyReport;
    const captainView = captains().get(ship)?.view;
    const view: ShipView = {
      generatedAt: now(),
      id: bot.id,
      name: name(ship),
      bot: {
        id: bot.id,
        ...(bot.slack
          ? { slack: { appId: bot.slack.appId, ...ship.identity } }
          : {}),
        ...(ship.transport ? { transport: ship.transport } : {}),
        ...(bot.access
          ? {
              access: {
                users: bot.access.users,
                channels: bot.access.channels,
                deniedUsers: bot.access.deniedUsers,
                deniedChannels: bot.access.deniedChannels,
                ...(bot.access.mentionOnly !== undefined
                  ? { mentionOnly: bot.access.mentionOnly }
                  : {}),
              },
            }
          : {}),
        backend: {
          type: bot.backend.type,
          ...(bot.backend.type === "module"
            ? {}
            : { directory: bot.backend.directory }),
          ...(named ? { agent: named } : {}),
          ...(model ? { model } : {}),
        },
        concurrency: bot.concurrency,
        turnTimeoutMs: bot.turnTimeoutMs,
      },
      crew: status,
      ...(status ? { crewMembers: dashboardCrewMembers(status) } : {}),
      ...(captainView ? { captain: captainView } : {}),
      ...(error ? { crewError: error } : {}),
      queue: {
        counts: store.queueCounts(ship.key),
        recent: store.recentJobs(ship.key, RECENT).map((job) => ({
          id: job.id,
          status: job.status,
          channel: job.channel,
          thread: job.thread,
          user: job.user,
          ...(job.failure ? { failure: job.failure } : {}),
          deferred: job.deferDelivery === 1,
        })),
      },
      cron: {
        fileBacked: bot.cronjobs !== undefined,
        ...(bot.cronjobs && report
          ? {
              dailyReport: {
                channel: report.channel ?? bot.cronjobs.channel,
                time: report.time,
                timezone: report.timezone,
              },
            }
          : {}),
        jobs: cronStore.report(ship.key),
        runs: cronStore.recentRuns(ship.key, RECENT),
      },
      ...sessions,
    };
    return { view, metadata };
  }

  return {
    async fleet(signal) {
      const fleet = await readFleet(signal);
      return {
        generatedAt: fleet.generatedAt,
        ships: fleet.ships.map(({ summary }) => summary),
      };
    },

    async ship(id, signal) {
      return (await readShip(id, signal))?.view;
    },

    /** Internal reads. The dashboard HTTP routes use fleet and ship above. */
    fleetWithCrew: (signal: AbortSignal, selected: ReadonlySet<string>) =>
      readFleet(signal, selected),
    shipWithCrew: (
      id: string,
      signal: AbortSignal,
      input: CrewStatusInput = {},
    ) => readShip(id, signal, input),

    async children(id, input, signal) {
      const ship = find(id);
      const history = ship?.backend.history;
      if (!ship || !history) return undefined;
      if (!(await allowed(ship, history, input.parentID, signal)))
        return undefined;
      const page = await history.children(
        {
          parentID: input.parentID,
          limit: input.limit ?? HISTORY_PAGE,
          ...(input.updatedSince !== undefined
            ? { updatedSince: input.updatedSince }
            : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        signal,
      );
      // A cursor is caller input and can belong to another listing.
      if (page.sessions.some((item) => item.parentID !== input.parentID))
        throw new Error("Child listing left the requested session.");
      return page;
    },

    async entries(id, input, signal) {
      const ship = find(id);
      const history = ship?.backend.history;
      if (!ship || !history) return undefined;
      if (!(await allowed(ship, history, input.sessionID, signal)))
        return undefined;
      return history.entries(input, signal);
    },
  } satisfies DashboardSource & {
    fleetWithCrew: (
      signal: AbortSignal,
      selected: ReadonlySet<string>,
    ) => ReturnType<typeof readFleet>;
    shipWithCrew: (
      id: string,
      signal: AbortSignal,
      input?: CrewStatusInput,
    ) => ReturnType<typeof readShip>;
  };
}

export type DashboardFleetSource = Pick<
  ReturnType<typeof dashboardSource>,
  "fleetWithCrew" | "shipWithCrew" | "children"
>;
