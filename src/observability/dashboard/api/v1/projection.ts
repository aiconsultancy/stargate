import { hostname } from "node:os";
import { Semaphore } from "effect";
import type { AgentBackend } from "../../../../backends/backend";
import { ircFeedbackDefaults } from "../../../../config";
import { truncateCodePoints } from "../../../../lib/code-points";
import { redactCredentials } from "../../../../lib/credentials";
import type {
  CheckoutDiff,
  CheckoutDiffInput,
  CrewGit,
  CrewGitInput,
  CrewGitState,
  FleetCrewStatus,
} from "../../../../coordination/crew/reporting/fleet-status";
import type {
  CrewStatus,
  CrewStatusTask,
} from "../../../../shared/crew-status";
import type { DashboardCrewMember, ShipSummary } from "../../dashboard-model";
import { dashboardCrewSummary } from "../../dashboard-projection";
import type { DashboardFleetSource } from "../../dashboard-source";
import { abortable, runAbortable } from "../../../../lib/effect";
import { isLoopbackHost } from "../../../../lib/loopback";
import { backendFingerprint } from "../../../../shared/registration";
import {
  HISTORY_PAGE,
  type HistorySession,
} from "../../../../shared/session-history";
import {
  type ApiV1Config,
  type Registration,
  gatewayFeatures,
  registrationFeatures,
} from "./features";
import { createGitReader, githubRepository } from "./git";
import { createPullReader } from "./pulls";
import {
  API_V1_VERSION,
  type ApiV1Source,
  type V1Activity,
  type V1Captain,
  type V1CrewContext,
  type V1CrewMember,
  type V1Fleet,
  type V1Git,
  type V1Ship,
  type V1Subagent,
  type V1Task,
} from "./types";

export type ApiV1Deps = {
  requests?: (
    registration: Registration,
    at: number,
  ) => NonNullable<V1Captain["requests"]>;
  dashboard: DashboardFleetSource;
  /** Loaded settings, including any committed live reload. */
  config: () => ApiV1Config;
  now?: () => number;
  dataDirectory?: string;
  git?: ((
    directory: string | undefined,
    signal: AbortSignal,
  ) => Promise<V1Git | null>) & {
    stop?(): Promise<void>;
  };
  pullRequest?: ReturnType<typeof createPullReader>;
};

type Context = CrewStatus["members"][number];

type Metadata = FleetCrewStatus["metadata"];

type CheckoutGit = (
  member: string,
  context: Pick<V1CrewContext, "project" | "provisioned">,
) => Promise<{ path: string | undefined; state: V1Git | null }>;

type Timing = {
  activity: V1Activity;
  since: number | null;
  observedAt: number;
};

const activityOrder: readonly V1Activity[] = [
  "running",
  "queued",
  "idle",
  "uncertain",
  "unprovisioned",
];

const hour = 3_600_000;

/**
 * Git state reported by the captain's crew plugin, in the v1 shape. Only a
 * crew checkout carries its fingerprint: only crew checkouts serve diffs.
 */
export function reportedGit(
  state: CrewGitState | null,
  directory: string,
  crew = false,
): V1Git | null {
  if (!state) {
    return null;
  }

  const empty: V1Git = {
    branch: null,
    head: null,
    base: null,
    ahead: null,
    behind: null,
    changedFiles: null,
    repository: null,
    checkedAt: state.checkedAt,
    commit: null,
    worktree: directory,
    source: "captain",
  };

  if (state.error) {
    return { ...empty, error: state.error };
  }

  return {
    ...empty,
    branch: state.branch,
    head: state.commit?.slice(0, 7) ?? null,
    base: state.base,
    ahead: state.ahead,
    behind: state.behind,
    changedFiles: state.changedFiles,
    repository: state.remote === null ? null : githubRepository(state.remote),
    commit: state.commit,
    ...(state.changedFiles !== null && { dirty: state.changedFiles > 0 }),
    ...(crew && state.fingerprint && { fingerprint: state.fingerprint }),
  };
}

/** Git state this process read itself, marked with its checkout. */
function localGit(state: V1Git | null, directory: string | undefined) {
  if (!state || !directory) {
    return state;
  }

  return {
    ...state,
    worktree: directory,
    ...(state.changedFiles !== null && { dirty: state.changedFiles > 0 }),
    source: "gateway" as const,
  };
}

const subagentLimit = 3;

function runningTask(task: V1Task | null): boolean {
  return (
    task !== null &&
    (task.status === "dispatching" ||
      task.status === "running" ||
      task.status === "cancelling")
  );
}

function contextActivity(context: Context): V1Activity {
  const { current, lastOutcome } = context;

  if (runningTask(current)) {
    return "running";
  }

  if (lastOutcome?.status === "uncertain") {
    return "uncertain";
  }

  if (current?.status === "uncertain") {
    const since =
      current.updatedAt ??
      current.finishedAt ??
      current.startedAt ??
      current.createdAt;

    const later = lastOutcome?.finishedAt ?? lastOutcome?.updatedAt ?? null;

    if (
      !lastOutcome ||
      lastOutcome.id === current.id ||
      later === null ||
      since === null ||
      later <= since
    ) {
      return "uncertain";
    }
  }

  if (!current && context.queuedCount > 0) {
    return "queued";
  }

  return context.provisioned === "ready" ? "idle" : "unprovisioned";
}

function knownTime(
  contexts: V1CrewContext[],
  activity: V1Activity,
): number | null {
  const times = contexts
    .filter((context) => context.activity === activity)
    .flatMap((context) => {
      if (activity === "queued") {
        return context.queued.map((task) => task.createdAt);
      }

      if (activity === "running") {
        return [
          context.current?.startedAt ?? context.current?.createdAt ?? null,
        ];
      }

      if (activity === "idle") {
        return [context.lastOutcome?.finishedAt ?? null];
      }

      return [];
    })
    .filter((time) => time !== null);

  return times.length === 0
    ? null
    : activity === "idle"
      ? Math.max(...times)
      : Math.min(...times);
}

/** Configured names, roles and models; crew task text does not pass through here. */
function checkoutText(metadata?: Metadata) {
  const paths = [
    metadata?.projectDirectory,
    ...(metadata?.contexts.map(({ directory }) => directory) ?? []),
  ].filter((path): path is string => path !== undefined && path.length > 1);

  const spellings = [
    ...new Set(
      paths.flatMap((path) => [path, JSON.stringify(path).slice(1, -1)]),
    ),
  ].toSorted((a, b) => b.length - a.length);

  return {
    configured(this: void, text: string, limit: number) {
      let value = text;

      for (const path of spellings) {
        value = value.replaceAll(path, "[checkout]");
      }

      return redactCredentials(value, limit);
    },
  };
}

type CrewText = ReturnType<typeof checkoutText>;

function v1Task(task: CrewStatusTask): V1Task {
  return {
    id: task.id,
    status: task.status,
    kind: task.kind,
    summary: task.summary,
    phase: task.phase,
    progress: task.progress,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
  };
}

function projectContext(context: Context): V1CrewContext {
  return {
    project: context.project === "default" ? null : (context.project ?? null),
    activity: contextActivity(context),
    provisioned: context.provisioned,
    observed: context.observed,
    current: context.current && v1Task(context.current),
    queuedCount: context.queuedCount,
    queued: context.queued.map(v1Task),
    lastOutcome: context.lastOutcome && v1Task(context.lastOutcome),
    recent: context.recent.map(v1Task),
    recentCount: context.recentCount,
    git: null,
    pullRequest: null,
  };
}

function registrations(config: ApiV1Config) {
  const result = new Map<string, Registration>();

  for (const bot of config.bots) {
    result.set(bot.id, { kind: "slack", config: bot });
  }

  for (const irc of config.irc ?? []) {
    result.set(irc.id, { kind: "irc", config: irc });
  }

  for (const team of config.teams ?? []) {
    result.set(team.id, { kind: "teams", config: team });
  }

  return result;
}

function localCheckout({ config }: Registration) {
  const backend = config.backend;

  return (
    backend.type !== "module" &&
    (backend.type !== "opencode" ||
      isLoopbackHost(new URL(backend.url).hostname))
  );
}

const role = (registration: Registration) =>
  registration.kind !== "slack" &&
  registration.config.fleetPolicy?.role === "rear_admiral"
    ? "rear_admiral"
    : "captain";

function model({ config }: Registration) {
  const backend = config.backend;

  let id;

  switch (backend.type) {
    case "opencode":
      id = backend.model && `${backend.model.providerID}/${backend.model.id}`;
      break;
    case "module":
      id = undefined;
      break;
    default:
      id = backend.model;
  }

  return id ? redactCredentials(id, 200) : null;
}

function timeState(
  states: Map<string, Timing>,
  key: string,
  activity: V1Activity,
  observedAt: number,
  known: number | null,
) {
  const previous = states.get(key);

  const since =
    known ??
    (previous?.activity === activity
      ? previous.since
      : previous
        ? observedAt
        : null);

  if (!previous || observedAt >= previous.observedAt) {
    states.set(key, { activity, since, observedAt });
  }

  return since;
}

/**
 * One crew diff page from a ship's captain, computed by its crew plugin.
 * Undefined for an unknown ship or a captain that cannot serve diffs.
 */
export function crewDiffSource(deps: Pick<ApiV1Deps, "dashboard" | "config">) {
  return async (
    ship: string,
    input: CheckoutDiffInput,
    signal: AbortSignal,
  ): Promise<CheckoutDiff | undefined> => {
    const registration = registrations(deps.config()).get(ship);

    if (!registration || role(registration) === "rear_admiral") {
      return;
    }

    return deps.dashboard.fleetBackend(ship)?.checkoutDiff?.(input, signal);
  };
}

export function createApiV1Source(deps: ApiV1Deps): ApiV1Source {
  const { dashboard } = deps;
  const now = deps.now ?? Date.now;
  const git = deps.git ?? createGitReader(now, undefined, deps.dataDirectory);
  const pullRequest = deps.pullRequest ?? createPullReader(now);
  const captains = new Map<string, Timing>();
  const members = new Map<string, Timing>();
  const childReads = Semaphore.makeUnsafe(4);
  const backendIdentities = new WeakMap<AgentBackend, number>();
  let nextBackendIdentity = 0;

  /** Null after an attempt that did not get a captain report. */
  async function captainGit(
    registration: Registration,
    input: CrewGitInput,
    signal: AbortSignal,
  ): Promise<CrewGit | null> {
    const backend = dashboard.fleetBackend(registration.config.id);

    if (!backend?.crewGit) {
      return null;
    }

    try {
      return (await backend.crewGit(input, signal)) ?? null;
    } catch {
      signal.throwIfAborted();

      return null;
    }
  }

  /** The captain's project checkout, read as the captain when it answers. */
  async function projectGit(
    registration: Registration,
    directory: string | undefined,
    reported: CrewGit | null | undefined,
    signal: AbortSignal,
  ) {
    const report =
      reported === undefined
        ? await captainGit(registration, { crew: false }, signal)
        : reported;

    return report
      ? reportedGit(report.project.git, report.project.directory)
      : localGit(await git(directory, signal), directory);
  }

  /**
   * One crew checkout reader per detail read. The captain owns the worktrees
   * and the gateway may not be able to read them, so its report wins; without
   * one, the gateway reads the provisioned checkouts itself.
   */
  async function crewCheckouts(
    registration: Registration,
    metadata: Metadata | undefined,
    only: string | undefined,
    signal: AbortSignal,
  ): Promise<{ read: CheckoutGit; reported: CrewGit | null }> {
    const reported = await captainGit(
      registration,
      only ? { member: only } : {},
      signal,
    );

    if (reported) {
      return {
        reported,
        read: (member, { project }) => {
          const entry = reported.contexts.find(
            (candidate) =>
              candidate.member === member && candidate.project === project,
          );

          return Promise.resolve(
            entry
              ? {
                  path: entry.directory,
                  state: reportedGit(entry.git, entry.directory, true),
                }
              : { path: undefined, state: null },
          );
        },
      };
    }

    const local = localCheckout(registration);

    return {
      reported,
      read: async (member, { project, provisioned }) => {
        const path =
          local && provisioned === "ready"
            ? metadata?.contexts.find(
                (entry) => entry.member === member && entry.project === project,
              )?.directory
            : undefined;

        return { path, state: localGit(await git(path, signal), path) };
      },
    };
  }

  function captain(
    registration: Registration,
    name: string,
    queue: V1Captain["queue"],
    at: number,
  ): V1Captain {
    const { id, backend } = registration.config;

    const activity = queue.running
      ? "running"
      : queue.queued
        ? "queued"
        : "idle";

    return {
      id,
      name: redactCredentials(name, 100),
      ...(registration.kind === "irc" &&
        (registration.config.features.liveProgress ??
          ircFeedbackDefaults(registration.config).liveProgress) &&
        deps.requests && { requests: deps.requests(registration, at) }),
      role: role(registration),
      transport: registration.kind,
      backend: backend.type,
      model: model(registration),
      queue,
      activity,
      since: timeState(captains, id, activity, at, null),
    };
  }

  function crewMember(
    ship: string,
    person: DashboardCrewMember,
    at: number,
    { configured: configuredText }: CrewText,
    metadata?: Metadata,
    sessions?: HistorySession[],
  ): V1CrewMember[] {
    const first = person.contexts[0];

    if (!first) {
      return [];
    }

    const configured = metadata?.contexts.find(
      (entry) => entry.member === person.id,
    );

    const contexts = person.contexts.map(projectContext);

    const activity =
      activityOrder.find((state) =>
        contexts.some((context) => context.activity === state),
      ) ?? "unprovisioned";

    const known = knownTime(contexts, activity);

    const configuredModel =
      configured?.model ??
      sessions?.find(
        (session) => session.kind === "crew" && session.member === person.id,
      )?.model;

    return [
      {
        id: person.id,
        name: configuredText(person.name, 100),
        role: configured?.role ? configuredText(configured.role, 1000) : null,
        model: configuredModel ? configuredText(configuredModel, 200) : null,
        backend: first.backend,
        activity,
        since: timeState(
          members,
          JSON.stringify([ship, person.id]),
          activity,
          at,
          known,
        ),
        idleSince: activity === "idle" ? known : null,
        contexts,
        subagents: [],
      },
    ];
  }

  async function shipSummary(
    registration: Registration,
    officer: V1Captain,
    crew: ShipSummary["crew"],
    people: V1CrewMember[],
    signal: AbortSignal,
    error?: string,
    metadata?: Metadata,
    reported?: CrewGit | null,
  ): Promise<V1Ship> {
    const backend = registration.config.backend;

    const policyCheckout =
      registration.kind === "slack"
        ? undefined
        : registration.config.fleetPolicy?.assignedCheckout;

    const directory =
      localCheckout(registration) && backend.type !== "module"
        ? (metadata?.projectDirectory ?? policyCheckout ?? backend.directory)
        : undefined;

    const [project, features] = await Promise.all([
      projectGit(registration, directory, reported, signal),
      registrationFeatures(registration),
    ]);

    signal.throwIfAborted();

    return {
      id: officer.id,
      name: officer.name,
      captain: officer,
      repository: project?.repository ?? null,
      available: !error,
      ...(error && { error: "Crew status unavailable." }),
      crew: crew
        ? {
            people: people.length,
            busy: people.filter((member) =>
              member.contexts.some((context) => context.current !== null),
            ).length,
            queued: people.filter((member) =>
              member.contexts.some((context) => context.queuedCount > 0),
            ).length,
            ...((crew.people?.partial ?? crew.busyPartial) && {
              partial: true as const,
            }),
          }
        : null,
      features,
    };
  }

  async function subagents(
    ship: string,
    roots: HistorySession[],
    at: number,
    signal: AbortSignal,
  ): Promise<V1Subagent[]> {
    const pages = await Promise.all(
      roots.map((root) =>
        runAbortable(
          childReads.withPermit(
            abortable(async (reading) => {
              try {
                return await dashboard.children(
                  ship,
                  {
                    parentID: root.id,
                    updatedSince: Math.max(0, at - hour),
                    limit: subagentLimit,
                  },
                  reading,
                );
              } catch {
                reading.throwIfAborted();

                return;
              }
            }),
          ),
          signal,
        ),
      ),
    );

    const recent = new Map<string, HistorySession>();

    for (const child of pages.flatMap((page) => page?.sessions ?? [])) {
      if (
        child.updatedAt !== undefined &&
        child.updatedAt >= at - hour &&
        child.updatedAt <= at
      ) {
        recent.set(child.id, child);
      }
    }

    return [...recent.values()]
      .toSorted(
        (a, b) =>
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
      )
      .slice(0, subagentLimit)
      .map((child) => ({
        id: child.id,
        title: truncateCodePoints(child.title ?? "Subagent", 180),
        updatedAt: child.updatedAt ?? null,
      }));
  }

  function configuredShip(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const registration = registrations(deps.config()).get(id);

    return registration && role(registration) !== "rear_admiral"
      ? registration
      : undefined;
  }

  type DashboardDetail = Awaited<
    ReturnType<DashboardFleetSource["shipWithCrew"]>
  >;

  async function detail(
    registration: Registration,
    snapshot: DashboardDetail,
    signal: AbortSignal,
    only?: string,
  ) {
    signal.throwIfAborted();

    if (!snapshot) {
      return;
    }

    const { id } = registration.config;
    const repositories = deps.config().api?.pullRequestRepositories;
    const { view, metadata } = snapshot;
    const at = view.generatedAt;
    const text = checkoutText(metadata);
    const officer = captain(registration, view.name, view.queue.counts, at);

    const people = (view.crewMembers ?? []).filter(
      (member) => !only || member.id === only,
    );

    const crewMembers = people.flatMap((person) =>
      crewMember(id, person, at, text, metadata, view.sessions),
    );

    if (only && crewMembers.length === 0) {
      return;
    }

    // Every emitted child belongs to one of this ship's dashboard-owned crew roots.
    const roots = view.sessions
      .filter((session) => session.kind === "crew")
      .slice(0, HISTORY_PAGE);

    const checkouts = await crewCheckouts(registration, metadata, only, signal);

    const enriched = await Promise.all(
      crewMembers.map(async (member) => {
        const [contexts, children] = await Promise.all([
          Promise.all(
            member.contexts.map(async (context) => {
              const { path, state } = await checkouts.read(member.id, context);
              const repository = path && repositories?.[path];

              const pr =
                repository && state?.branch && state.head && !state.error
                  ? pullRequest(repository, state.branch)
                  : undefined;

              return {
                ...context,
                git: state,
                pullRequest: pr ?? null,
                ...(pr !== undefined && { pullRequestKnown: true as const }),
              };
            }),
          ),
          subagents(
            id,
            roots.filter((root) => root.member === member.id),
            at,
            signal,
          ),
        ]);

        return { ...member, contexts, subagents: children };
      }),
    );

    return {
      officer,
      view,
      metadata,
      crewMembers: enriched,
      reported: checkouts.reported,
    };
  }

  async function shipDetail(
    registration: Registration,
    snapshot: DashboardDetail,
    signal: AbortSignal,
  ) {
    const result = await detail(registration, snapshot, signal);

    if (!result) {
      return;
    }

    const { officer, view, metadata, crewMembers, reported } = result;

    const summary = await shipSummary(
      registration,
      officer,
      view.crew && dashboardCrewSummary(view.crew),
      crewMembers,
      signal,
      view.crewError,
      metadata,
      reported,
    );

    return {
      ...summary,
      crewMembers,
      ...(snapshot?.crewObservedAt !== undefined && {
        detailUpdatedAt: snapshot.crewObservedAt,
      }),
    };
  }

  return {
    async stop() {
      await git.stop?.();
    },
    shipIdentities() {
      const identities = new Map<string, string>();

      for (const [id, registration] of registrations(deps.config())) {
        if (role(registration) === "rear_admiral") {
          continue;
        }

        const { backend } = registration.config;
        const instance = dashboard.fleetBackend(id);
        let identity = instance && backendIdentities.get(instance);

        if (instance && identity === undefined) {
          identity = ++nextBackendIdentity;
          backendIdentities.set(instance, identity);
        }

        identities.set(
          id,
          JSON.stringify([
            registration.kind,
            backendFingerprint(registration.config),
            backend.type === "opencode" ? backend.sessionID : undefined,
            identity,
          ]),
        );
      }

      return identities;
    },
    async fleet(signal, captureShipRead, crewDeadline) {
      signal.throwIfAborted();
      const config = deps.config();
      const configured = registrations(config);

      // The sample also feeds each ship's `ship` event: unredacted task
      // Text within the ordinary limits.
      const fleet = await dashboard.fleetWithCrew(
        signal,
        new Set(configured.keys()),
        crewDeadline,
      );

      signal.throwIfAborted();
      let admiral: V1Captain | null = null;
      let longestIdle: V1Fleet["longestIdle"] = null;
      const pending: Promise<V1Ship>[] = [];

      for (const row of [...fleet.ships].toSorted((a, b) =>
        a.summary.id.localeCompare(b.summary.id),
      )) {
        const { summary, metadata, error } = row;
        const registration = configured.get(summary.id);

        if (!registration) {
          continue;
        }

        const officer = captain(
          registration,
          summary.name,
          summary.queue,
          fleet.generatedAt,
        );

        if (officer.role === "rear_admiral") {
          admiral ??= officer;
          continue;
        }

        const { readDetail } = row;

        if (captureShipRead && readDetail) {
          captureShipRead(summary.id, async (reading) =>
            shipDetail(registration, await readDetail(reading), reading),
          );
        }

        const text = checkoutText(metadata);

        const people = (row.members ?? []).flatMap((person) =>
          crewMember(summary.id, person, fleet.generatedAt, text, metadata),
        );

        for (const member of people) {
          if (
            member.idleSince !== null &&
            (!longestIdle ||
              member.idleSince < longestIdle.since ||
              (member.idleSince === longestIdle.since &&
                summary.id === longestIdle.ship &&
                member.id < longestIdle.member))
          ) {
            longestIdle = {
              ship: summary.id,
              member: member.id,
              since: member.idleSince,
            };
          }
        }

        pending.push(
          shipSummary(
            registration,
            officer,
            summary.crew,
            people,
            signal,
            error,
            metadata,
          ),
        );
      }

      return {
        apiVersion: API_V1_VERSION,
        generatedAt: fleet.generatedAt,
        name: redactCredentials(config.api?.fleetName ?? hostname(), 100),
        admiral,
        ships: await Promise.all(pending),
        longestIdle,
      };
    },
    async ship(id, signal) {
      const registration = configuredShip(id, signal);

      if (!registration) {
        return;
      }

      return shipDetail(
        registration,
        // Unredacted task text within the ordinary limits.
        await dashboard.shipWithCrew(id, signal, { taskText: "unredacted" }),
        signal,
      );
    },
    async crew(ship, member, signal) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member)) {
        return;
      }

      const registration = configuredShip(ship, signal);

      if (!registration) {
        return;
      }

      const result = await detail(
        registration,
        // Only this route asks for full task text.
        // An older crew plugin answers redacted; the route shows that as is.
        await dashboard.shipWithCrew(ship, signal, {
          member,
          taskText: "full",
        }),
        signal,
        member,
      );

      const person = result?.crewMembers[0];

      return person ? { ship, member: person } : undefined;
    },
    gatewayFeatures: () => gatewayFeatures(deps.config()),
  };
}
