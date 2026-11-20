import { expect, test } from "bun:test";
import { diffEvents, type V1EventSnapshot } from "../src/api/v1/diff";
import type { V1CrewContext, V1Task } from "../src/api/v1/types";

const at = 4_000;
const task = (
  id: string,
  status: V1Task["status"],
  extra: Partial<V1Task> = {},
): V1Task => ({
  id,
  status,
  kind: "assignment",
  summary: "Check the layout",
  phase: "review",
  progress: "",
  createdAt: 1,
  startedAt: 2,
  updatedAt: 3,
  finishedAt: null,
  ...extra,
});

function context(extra: Partial<V1CrewContext> = {}): V1CrewContext {
  return {
    project: null,
    activity: "idle",
    provisioned: "ready",
    observed: false,
    current: null,
    queuedCount: 0,
    queued: [],
    lastOutcome: null,
    recent: [],
    recentCount: 0,
    pullRequest: null,
    git: {
      branch: "main",
      head: "cafeabc",
      base: "origin/main",
      ahead: 0,
      behind: 0,
      changedFiles: 0,
      repository: "example/project",
      checkedAt: 1,
    },
    ...extra,
  };
}

function snapshot(contexts: V1CrewContext[] = [context()]) {
  const summary = {
    id: "ship",
    name: "Test Ship",
    captain: {
      id: "ship",
      name: "Test Ship",
      role: "captain" as const,
      transport: "irc" as const,
      backend: "opencode" as const,
      model: null,
      queue: { queued: 0, running: 0, responding: 0, done: 0, failed: 0 },
      activity: "idle" as const,
      since: null,
    },
    repository: "example/project",
    available: true,
    crew: { people: 1, busy: 0, queued: 0 },
    features: [],
  };
  const ship = {
    ...summary,
    crewMembers: [
      {
        id: "pilot",
        name: "Test Pilot",
        role: null,
        model: null,
        backend: "opencode" as const,
        activity: "idle" as const,
        since: null,
        idleSince: null,
        subagents: [],
        contexts,
      },
    ],
  };
  return {
    fleet: {
      apiVersion: 1,
      generatedAt: at,
      name: "Test Fleet",
      admiral: null,
      ships: [summary],
      longestIdle: null,
      host: {
        hostname: "test-vm",
        platform: "linux",
        arch: "x64",
        uptimeSec: 1,
        cpu: { cores: 1, usage: null, load: [0, 0, 0] },
        memory: { totalBytes: 100, availableBytes: 50 },
        disks: [],
        sampledAt: at,
      },
      gateway: {
        version: "1.0.0",
        bunVersion: "1.0.0",
        opencodeVersion: null,
        startedAt: 1,
        features: [],
      },
    },
    ships: { ship },
  } satisfies V1EventSnapshot;
}

function activity(previous: V1CrewContext, next: V1CrewContext) {
  return diffEvents(snapshot([previous]), snapshot([next]), at).flatMap(
    (event) => (event.type === "activity" ? [event.data] : []),
  );
}

test("initial snapshot emits nothing and volatile sampling timestamps are ignored", () => {
  const before = snapshot();
  const after = snapshot();
  after.fleet.generatedAt++;
  after.fleet.host.sampledAt++;
  after.fleet.host.uptimeSec++;
  const git = after.ships.ship.crewMembers[0]?.contexts[0]?.git;
  if (!git) throw new Error("Missing Git fixture");
  git.checkedAt++;
  expect(diffEvents(undefined, before, at)).toEqual([]);
  expect(diffEvents(before, after, at)).toEqual([]);
});

test("a gateway-only change emits a fleet event", () => {
  const before = snapshot();
  const after = {
    ...before,
    fleet: {
      ...before.fleet,
      gateway: { ...before.fleet.gateway, opencodeVersion: "2.3.2" },
    },
  };
  expect(diffEvents(before, after, at)).toEqual([
    { type: "fleet", data: after.fleet },
  ]);
});

test("fleet summary changes emit a full fleet and ship detail changes emit only their ship", () => {
  const before = snapshot();
  const after = snapshot([context({ observed: true })]);
  expect(diffEvents(before, after, at)).toEqual([
    { type: "ship", data: after.ships.ship },
  ]);
  after.fleet.name = "New Test Fleet";
  expect(diffEvents(before, after, at)).toEqual([
    { type: "fleet", data: after.fleet },
    { type: "ship", data: after.ships.ship },
  ]);
  expect(diffEvents(before, { ...after, ships: {} }, at)).toEqual([
    { type: "fleet", data: after.fleet },
  ]);
});

test("added ship details appear in stable ID order without fabricated transitions", () => {
  const before = snapshot();
  const after = snapshot();
  const zulu = { ...after.ships.ship, id: "zulu", available: false };
  const alpha = { ...after.ships.ship, id: "alpha" };
  expect(diffEvents(before, { ...after, ships: { zulu, alpha } }, at)).toEqual([
    { type: "ship", data: alpha },
    { type: "ship", data: zulu },
  ]);
});

test("dispatch, phase and outcome refer to the matching task in the matching project", () => {
  const old = context({ current: task("old", "running"), activity: "running" });
  const next = context({
    current: task("new", "dispatching", { summary: "Add navigation" }),
    activity: "running",
    lastOutcome: task("old", "completed", { finishedAt: at }),
  });
  expect(activity(old, next)).toEqual([
    {
      ship: "ship",
      member: "pilot",
      at,
      kind: "outcome",
      status: "completed",
      text: "Test Pilot reported “Check the layout” as completed.",
    },
    {
      ship: "ship",
      member: "pilot",
      at,
      kind: "dispatch",
      text: "Test Pilot started “Add navigation”.",
    },
  ]);
  const advanced = context({
    current: task("new", "running", {
      summary: "Add navigation",
      phase: "testing\nresults",
    }),
    activity: "running",
  });
  expect(activity(next, advanced)).toEqual([
    {
      ship: "ship",
      member: "pilot",
      at,
      kind: "phase",
      text: "Test Pilot moved to testing results on “Add navigation”.",
    },
  ]);
  expect(
    activity(
      old,
      context({
        current: task("different", "uncertain"),
        activity: "uncertain",
      }),
    ),
  ).toEqual([]);
  const tools = context({
    project: "tools",
    current: task("other", "running"),
    activity: "running",
  });
  const before = snapshot([old, tools]);
  const after = snapshot([tools, old]);
  expect(diffEvents(before, after, at).map(({ type }) => type)).toEqual([
    "ship",
  ]);
});

test("an already observed task emits another outcome only when its terminal status changes", () => {
  const uncertain = task("old", "uncertain");
  const previous = context({
    current: uncertain,
    lastOutcome: uncertain,
    activity: "uncertain",
  });
  expect(activity(previous, context({ lastOutcome: uncertain }))).toEqual([]);
  const abandoned = task("old", "abandoned");
  expect(activity(previous, context({ lastOutcome: abandoned }))).toMatchObject(
    [{ kind: "outcome", status: "abandoned" }],
  );
});

test("reports tasks completed between polls without replaying recent outcomes", () => {
  const older = task("older", "completed", { finishedAt: 1 });
  const completed = task("completed", "completed", { finishedAt: 2 });
  const cancelled = task("cancelled", "cancelled", { finishedAt: 3 });
  const before = context({
    lastOutcome: older,
    recent: [older],
    recentCount: 1,
  });
  const after = context({
    lastOutcome: cancelled,
    recent: [cancelled, completed, older],
    recentCount: 3,
  });
  expect(diffEvents(undefined, snapshot([after]), at)).toEqual([]);
  expect(activity(before, after)).toMatchObject([
    { kind: "outcome", status: "completed" },
    { kind: "outcome", status: "cancelled" },
  ]);
  expect(activity(after, after)).toEqual([]);
  expect(activity(after, before)).toEqual([]);
});

test("PR discovery after startup or a Git timeout does not emit activity", () => {
  const before = context();
  if (!before.git) throw new Error("Missing Git fixture");
  const after = context({
    pullRequest: {
      number: 42,
      url: "https://github.com/example/project/pull/42",
      title: "Layout",
      state: "open",
      checks: "running",
    },
  });
  const timedOut = context({
    git: { ...before.git, branch: null, error: "Git read timed out." },
  });
  expect(activity(before, after)).toEqual([]);
  expect(activity(timedOut, after)).toEqual([]);
});

test("queue increases produce one bounded sentence with the added task when visible", () => {
  const existing = task("old", "queued");
  const added = task("new", "queued", { summary: `test\n${"x".repeat(300)}` });
  const old = context({ queuedCount: 1, queued: [existing] });
  const next = context({ queuedCount: 2, queued: [existing, added] });
  const queued = activity(old, next);
  expect(queued).toMatchObject([{ kind: "queued" }]);
  const text = queued[0]?.text ?? "";
  expect(
    text.startsWith("Test Pilot has 2 queued tasks, including “test "),
  ).toBe(true);
  expect(text.endsWith("”.")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(200);
  expect(activity(next, old)).toEqual([]);
  expect(
    activity(old, context({ queuedCount: 2, queued: [existing] })),
  ).toMatchObject([{ kind: "queued", text: "Test Pilot has 2 queued tasks." }]);
});

test("git emits when branch changes, HEAD detaches or a PR appears", () => {
  const old = context();
  if (!old.git) throw new Error("Missing Git fixture");
  const changed = context({ git: { ...old.git, branch: "feature/layout" } });
  expect(activity(old, changed)).toMatchObject([
    {
      kind: "git",
      branch: "feature/layout",
      text: "Test Pilot switched to branch “feature/layout”.",
    },
  ]);
  const detached = context({ git: { ...old.git, branch: null } });
  expect(activity(changed, detached)).toMatchObject([
    { kind: "git", text: "Test Pilot switched to a detached HEAD." },
  ]);
  const pullRequest = {
    number: 42,
    url: "https://github.com/example/project/pull/42",
    title: "Layout",
    state: "open" as const,
    checks: "running" as const,
  };
  const withPR = { ...changed, pullRequest };
  expect(
    activity({ ...changed, pullRequestKnown: true }, withPR),
  ).toMatchObject([
    {
      kind: "git",
      branch: "feature/layout",
      text: "Test Pilot has PR #42 on “feature/layout”.",
    },
  ]);
  expect(
    activity(withPR, {
      ...withPR,
      pullRequest: { ...pullRequest, checks: "passing" },
    }),
  ).toEqual([]);
  expect(activity(changed, context({ git: null }))).toEqual([]);
  expect(
    activity(
      context({ git: { ...old.git, error: "Git state unavailable." } }),
      changed,
    ),
  ).toEqual([]);
});

test("availability flips emit an event without a member", () => {
  const before = snapshot();
  const after = snapshot();
  after.ships.ship.available = false;
  const summary = after.fleet.ships[0];
  if (!summary) throw new Error("Missing summary");
  summary.available = false;
  const overview = (sample: V1EventSnapshot) => ({ ...sample, ships: {} });
  const events = diffEvents(overview(before), overview(after), at);
  expect(events).toEqual([
    { type: "fleet", data: after.fleet },
    {
      type: "activity",
      data: {
        ship: "ship",
        member: null,
        kind: "availability",
        text: "Test Ship is unavailable.",
        at,
      },
    },
  ]);
  const recovery = diffEvents(overview(after), overview(before), at);
  expect(recovery.at(-1)).toMatchObject({
    type: "activity",
    data: { kind: "availability", text: "Test Ship is available." },
  });
  expect(diffEvents({ ...after, fleet: before.fleet }, before, at)).toEqual([
    { type: "ship", data: before.ships.ship },
  ]);
});

test("a timestamp-only refresh publishes a lightweight ship sample event", () => {
  function sample(detailUpdatedAt: number) {
    const { fleet, ships } = snapshot([context()]);
    return { fleet, ships: { ship: { ...ships.ship, detailUpdatedAt } } };
  }
  const before = sample(at - 1);
  const after = sample(at);
  expect(diffEvents(before, after, at)).toEqual([
    { type: "ship-sampled", data: { id: "ship", detailUpdatedAt: at } },
  ]);
});
