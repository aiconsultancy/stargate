import type { AgentBackend } from "./backend";
import type { BotConfig, IrcConfig, TeamsConfig } from "./config";
import type { CrewStatus } from "./crew-status";
import type { CronStore } from "./cron-store";
import type {
  DashboardSource,
  DashboardTransport,
  ShipSummary,
  ShipView,
} from "./dashboard-model";
import type { IrcRegistration } from "./irc/ship";
import type { Identity } from "./routing";
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
  config: IrcConfig,
  backend: AgentBackend,
): DashboardShip {
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
): DashboardSource {
  const crewRoots = new WeakMap<
    DashboardShip,
    { at: number; sessions: HistorySession[] }
  >();

  const find = (id: string) => ships.find((ship) => ship.bot.id === id);
  const name = (ship: DashboardShip) => ship.bot.displayName ?? ship.bot.id;
  const agent = (ship: DashboardShip) =>
    ship.bot.backend.type === "opencode" ? ship.bot.backend.agent : undefined;

  async function crew(
    ship: DashboardShip,
    signal: AbortSignal,
  ): Promise<{ status: CrewStatus | null; error?: string }> {
    if (!ship.backend.crewStatus) return { status: null };
    try {
      return { status: await ship.backend.crewStatus({}, signal) };
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

  return {
    async fleet(signal) {
      const summaries = await Promise.all(
        ships.map(async (ship): Promise<ShipSummary> => {
          const { status } = await crew(ship, signal);
          const named = agent(ship);
          return {
            id: ship.bot.id,
            name: name(ship),
            backend: ship.bot.backend.type,
            ...(ship.transport ? { transport: ship.transport.kind } : {}),
            ...(named ? { agent: named } : {}),
            crew: status && {
              total: status.total,
              busy:
                status.busy ??
                status.members.filter((member) => member.current).length,
              ...(status.busy === undefined && status.truncated
                ? { busyPartial: true as const }
                : {}),
            },
            queue: store.queueCounts(ship.key),
            cronjobs: cronStore.report(ship.key).length,
          };
        }),
      );
      return { generatedAt: now(), ships: summaries };
    },

    async ship(id, signal) {
      const ship = find(id);
      if (!ship) return undefined;
      const { bot } = ship;
      const [{ status, error }, sessions] = await Promise.all([
        crew(ship, signal),
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
      return {
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
    },

    async children(id, input, signal) {
      const ship = find(id);
      const history = ship?.backend.history;
      if (!ship || !history) return undefined;
      if (!(await allowed(ship, history, input.parentID, signal)))
        return undefined;
      const page = await history.children(
        {
          parentID: input.parentID,
          limit: HISTORY_PAGE,
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
  };
}
