import { isDeepStrictEqual } from "node:util";
import { redactCredentials } from "../../../../lib/credentials";
import type {
  V1ActivityEvent,
  V1CrewContext,
  V1Event,
  V1Fleet,
  V1Ship,
  V1ShipDetail,
  V1Snapshot,
  V1Task,
} from "./types";

/** The HTTP layer adds host and gateway fields before emitting fleet events. */
export type V1EventSnapshot = V1Snapshot & { fleet: V1Fleet };

function fleetSummary({
  apiVersion,
  overviewStale,
  name,
  admiral,
  ships,
  longestIdle,
  gateway,
}: V1Fleet) {
  return {
    apiVersion,
    overviewStale,
    name,
    admiral,
    ships,
    longestIdle,
    gateway,
  };
}

function shipDetail({
  detailUpdatedAt: _detailUpdatedAt,
  ...ship
}: V1ShipDetail) {
  return {
    ...ship,
    crewMembers: ship.crewMembers.map((member) => ({
      ...member,
      contexts: member.contexts.map(({ git, ...context }) => {
        if (!git) {
          return { ...context, git };
        }

        const { checkedAt: _checkedAt, ...state } = git;

        return { ...context, git: state };
      }),
    })),
  };
}

const clean = (text: string, limit: number) =>
  redactCredentials(text, limit).replace(/\s+/g, " ").trim();

// Task text and branch names come from crew output, shown as written.
const crewText = (text: string, limit: number) =>
  Array.from(text).slice(0, limit).join("").replace(/\s+/g, " ").trim();

const sentence = (text: string) => `${text.slice(0, 199)}.`;

function availability(ship: V1Ship, at: number): V1Event {
  return {
    type: "activity",
    data: {
      ship: ship.id,
      member: null,
      kind: "availability",
      text: sentence(
        `${clean(ship.name, 100) || ship.id} is ${ship.available ? "available" : "unavailable"}`,
      ),
      at,
    },
  };
}

function quoted(prefix: string, text: string, suffix = "") {
  return `${prefix}“${crewText(text, 197 - prefix.length - suffix.length) || "Task"}”${suffix}.`;
}

function outcomes({ recent, lastOutcome }: V1CrewContext) {
  const tasks = new Map<string, V1Task>();

  for (const task of [...recent].toReversed().concat(lastOutcome ?? [])) {
    if (
      task.status === "completed" ||
      task.status === "cancelled" ||
      task.status === "uncertain" ||
      task.status === "abandoned"
    ) {
      tasks.set(task.id, task);
    }
  }

  return tasks;
}

type EmitContextEvent = (
  kind: V1ActivityEvent["kind"],
  text: string,
  extra?: Pick<V1ActivityEvent, "status" | "branch">,
) => void;

function contextEvents(
  previous: V1CrewContext,
  next: V1CrewContext,
  name: string,
  emit: EmitContextEvent,
) {
  const { current } = next;
  const old = previous.current;
  const priorOutcomes = outcomes(previous);

  for (const [id, outcome] of outcomes(next)) {
    if (priorOutcomes.get(id)?.status === outcome.status) {
      continue;
    }

    emit(
      "outcome",
      quoted(
        `${name} reported `,
        outcome.summary || (old?.id === id ? old.summary : ""),
        ` as ${outcome.status}`,
      ),
      {
        status: outcome.status,
      },
    );
  }

  if (current && next.activity === "running" && current.id !== old?.id) {
    emit("dispatch", quoted(`${name} started `, current.summary));
  } else if (current && old?.id === current.id && old.phase !== current.phase) {
    const phase = crewText(current.phase, 45);
    emit(
      "phase",
      quoted(
        phase
          ? `${name} moved to ${phase} on `
          : `${name} cleared the phase on `,
        current.summary,
      ),
    );
  }

  if (next.queuedCount > previous.queuedCount) {
    const previousIds = new Set(previous.queued.map((task) => task.id));
    const added = next.queued.find((task) => !previousIds.has(task.id));
    const total = `${next.queuedCount} queued ${next.queuedCount === 1 ? "task" : "tasks"}`;
    emit(
      "queued",
      added
        ? quoted(`${name} has ${total}, including `, added.summary)
        : sentence(`${name} has ${total}`),
    );
  }

  gitActivity(previous, next, name, emit);
}

function gitActivity(
  previous: V1CrewContext,
  next: V1CrewContext,
  name: string,
  emit: EmitContextEvent,
) {
  const branch = next.git?.branch ?? null;
  const priorGit = previous.git;

  const gitReadable =
    priorGit && !priorGit.error && next.git && !next.git.error;

  const changed = gitReadable && branch !== priorGit.branch;
  const pr = next.pullRequest;

  const appeared =
    pr &&
    gitReadable &&
    (previous.pullRequest !== null ||
      (previous.pullRequestKnown &&
        branch === priorGit.branch &&
        next.git?.repository === priorGit.repository)) &&
    (pr.number !== previous.pullRequest?.number ||
      pr.url !== previous.pullRequest.url);

  if (appeared) {
    emit(
      "git",
      branch
        ? quoted(`${name} has PR #${pr.number} on `, branch)
        : sentence(`${name} has PR #${pr.number}`),
      branch ? { branch } : {},
    );
  } else if (changed) {
    emit(
      "git",
      branch
        ? quoted(`${name} switched to branch `, branch)
        : sentence(`${name} switched to a detached HEAD`),
      branch ? { branch } : {},
    );
  }
}

export function diffEvents(
  prev: V1EventSnapshot | undefined,
  next: V1EventSnapshot,
  now: number,
): V1Event[] {
  if (!prev) {
    return [];
  }

  const events: V1Event[] = [];

  if (!isDeepStrictEqual(fleetSummary(prev.fleet), fleetSummary(next.fleet))) {
    events.push({ type: "fleet", data: next.fleet });
    const prior = new Map(prev.fleet.ships.map((ship) => [ship.id, ship]));

    for (const ship of next.fleet.ships) {
      const previous = prior.get(ship.id);

      if (previous && previous.available !== ship.available) {
        events.push(availability(ship, now));
      }
    }
  }

  for (const id of Object.keys(next.ships).toSorted()) {
    const ship = next.ships[id];

    if (!ship) {
      continue;
    }

    const previous = Object.hasOwn(prev.ships, id) ? prev.ships[id] : undefined;

    if (
      !previous ||
      !isDeepStrictEqual(shipDetail(previous), shipDetail(ship))
    ) {
      events.push({ type: "ship", data: ship });
    } else if (
      ship.detailUpdatedAt !== undefined &&
      ship.detailUpdatedAt !== previous.detailUpdatedAt
    ) {
      events.push({
        type: "ship-sampled",
        data: { id, detailUpdatedAt: ship.detailUpdatedAt },
      });
    }

    if (!previous) {
      continue;
    }

    const activity = (
      member: string | null,
      kind: V1ActivityEvent["kind"],
      text: string,
      extra?: Pick<V1ActivityEvent, "status" | "branch">,
    ) =>
      events.push({
        type: "activity",
        data: { ship: id, member, kind, text, at: now, ...extra },
      });

    const oldMembers = new Map(
      previous.crewMembers.map((member) => [member.id, member]),
    );

    for (const member of ship.crewMembers) {
      const prior = oldMembers.get(member.id);

      if (!prior) {
        continue;
      }

      const contexts = new Map(
        prior.contexts.map((context) => [context.project, context]),
      );

      for (const context of member.contexts) {
        const old = contexts.get(context.project);

        if (old) {
          contextEvents(
            old,
            context,
            clean(member.name, 60) || member.id,
            (kind, text, extra) => {
              activity(member.id, kind, text, extra);
            },
          );
        }
      }
    }
  }

  return events;
}
