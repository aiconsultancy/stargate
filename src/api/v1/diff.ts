import { isDeepStrictEqual } from "node:util";
import { redactCredentials } from "../../credentials";
import type {
  V1ActivityEvent,
  V1CrewContext,
  V1Event,
  V1Fleet,
  V1ShipDetail,
  V1Snapshot,
  V1Task,
} from "./types";

/** The HTTP layer adds host and gateway fields before emitting fleet events. */
export type V1EventSnapshot = V1Snapshot & { fleet: V1Fleet };

function fleetSummary({
  apiVersion,
  name,
  admiral,
  ships,
  longestIdle,
}: V1Snapshot["fleet"]) {
  return { apiVersion, name, admiral, ships, longestIdle };
}

function shipDetail(ship: V1ShipDetail) {
  return {
    ...ship,
    crewMembers: ship.crewMembers.map((member) => ({
      ...member,
      contexts: member.contexts.map(({ git, ...context }) => {
        if (!git) return { ...context, git };
        const { checkedAt: _checkedAt, ...state } = git;
        return { ...context, git: state };
      }),
    })),
  };
}

const clean = (text: string, limit: number) =>
  redactCredentials(text, limit).replace(/\s+/g, " ").trim();
const sentence = (text: string) => `${text.slice(0, 199)}.`;
function quoted(prefix: string, text: string, suffix = "") {
  return `${prefix}“${clean(text, 197 - prefix.length - suffix.length) || "Task"}”${suffix}.`;
}

function outcomes({ recent, lastOutcome }: V1CrewContext) {
  const tasks = new Map<string, V1Task>();
  for (const task of [...recent].reverse().concat(lastOutcome ?? [])) {
    if (
      task.status === "completed" ||
      task.status === "cancelled" ||
      task.status === "uncertain" ||
      task.status === "abandoned"
    )
      tasks.set(task.id, task);
  }
  return tasks;
}

function contextEvents(
  previous: V1CrewContext,
  next: V1CrewContext,
  name: string,
  emit: (
    kind: V1ActivityEvent["kind"],
    text: string,
    extra?: Pick<V1ActivityEvent, "status" | "branch">,
  ) => void,
) {
  const { current } = next;
  const old = previous.current;
  const priorOutcomes = outcomes(previous);
  for (const [id, outcome] of outcomes(next)) {
    if (priorOutcomes.get(id)?.status === outcome.status) continue;
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
  if (current && next.activity === "running" && current.id !== old?.id)
    emit("dispatch", quoted(`${name} started `, current.summary));
  else if (current && old?.id === current.id && old.phase !== current.phase) {
    const phase = clean(current.phase, 45);
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

  const branch = next.git?.branch ?? null;
  const priorGit = previous.git;
  const gitReadable =
    priorGit && !priorGit.error && next.git && !next.git.error;
  const changed = gitReadable && branch !== priorGit.branch;
  const pr = next.pullRequest;
  const appeared =
    pr &&
    gitReadable &&
    (previous.pullRequest ||
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
  prev: V1Snapshot | undefined,
  next: V1EventSnapshot,
  now: number,
): V1Event[] {
  if (!prev) return [];
  const events: V1Event[] = [];
  if (!isDeepStrictEqual(fleetSummary(prev.fleet), fleetSummary(next.fleet)))
    events.push({ type: "fleet", data: next.fleet });
  for (const id of Object.keys(next.ships).sort()) {
    const ship = next.ships[id];
    if (!ship) continue;
    const previous = Object.hasOwn(prev.ships, id) ? prev.ships[id] : undefined;
    if (!previous || !isDeepStrictEqual(shipDetail(previous), shipDetail(ship)))
      events.push({ type: "ship", data: ship });
    if (!previous) continue;
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
    if (previous.available !== ship.available)
      activity(
        null,
        "availability",
        sentence(
          `${clean(ship.name, 100) || id} is ${ship.available ? "available" : "unavailable"}`,
        ),
      );
    const oldMembers = new Map(
      previous.crewMembers.map((member) => [member.id, member]),
    );
    for (const member of ship.crewMembers) {
      const prior = oldMembers.get(member.id);
      if (!prior) continue;
      const contexts = new Map(
        prior.contexts.map((context) => [context.project, context]),
      );
      for (const context of member.contexts) {
        const old = contexts.get(context.project);
        if (old)
          contextEvents(
            old,
            context,
            clean(member.name, 60) || member.id,
            (kind, text, extra) => activity(member.id, kind, text, extra),
          );
      }
    }
  }
  return events;
}
