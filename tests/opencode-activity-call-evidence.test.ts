import { expect, test } from "bun:test";
import type { TurnActivityLog } from "../src/backends/backend";
import { ActivityCallEvidence } from "../src/backends/opencode/activity-call-evidence";
import {
  type ActivityFamilyEvent,
  OpenCodeActivityFamilies,
  isActivityEvent,
} from "../src/backends/opencode/activity-family";
import { activityQueueDefaults } from "../src/backends/opencode/activity-recovery-queue";
import { createActivityHub } from "../src/observability/dashboard/api/v1/activity";

const parent = "ses_parent";
const child = "ses_child";

const log = (): TurnActivityLog => ({
  update() {},
  reconnected() {},
  end() {},
});

const window = { except: 99, after: 0, through: 1 };

test("other native parents cannot evict a live call's name or its reused child's transcript", async () => {
  const stop = new AbortController();
  const hub = createActivityHub();

  const families = new OpenCodeActivityFamilies({
    signal: stop.signal,
    parent: async (id) => (id === child ? parent : undefined),
    active: async () => ({}),
    async *log() {},
  });

  const root = hub.recorder("officer").begin(undefined, parent);
  families.track(parent, root);

  let seq = 0;

  function send(
    type: ActivityFamilyEvent["type"],
    sessionID: string,
    data: Record<string, unknown> = {},
    owner?: TurnActivityLog,
  ) {
    const event = {
      type,
      id: `evt_${++seq}`,
      created: seq,
      data: { sessionID, assistantMessageID: "answer", ...data },
      durable: { aggregateID: sessionID, seq, version: 1 },
    } as unknown as ActivityFamilyEvent;

    const order = families.receive(event);

    if (owner && isActivityEvent(event)) {
      families.owned(owner, event, order);
    }
  }

  const open = (session: string, owner: TurnActivityLog) =>
    send(
      "session.tool.input.started",
      session,
      { id: "launch", name: "subagent" },
      owner,
    );

  const name = () =>
    send(
      "session.tool.progress",
      parent,
      { id: "launch", metadata: { sessionID: child } },
      root,
    );

  try {
    // Admit the first execution so only a naming proof can admit the next.
    open(parent, root);
    name();
    send("session.execution.started", child);
    send("session.execution.succeeded", child);
    await Promise.resolve();

    send(
      "session.tool.input.started",
      parent,
      { id: "next", name: "subagent" },
      root,
    );

    for (let index = 0; index < activityQueueDefaults.pending * 4; index += 1) {
      const foreign = `ses_foreign_${index}`;
      const owner = log();
      families.track(foreign, owner);
      open(foreign, owner);
    }

    send(
      "session.tool.progress",
      parent,
      { id: "next", metadata: { sessionID: child } },
      root,
    );
    send("session.execution.started", child);
    send("session.text.ended", child, {
      assistantMessageID: "next-answer",
      ordinal: 0,
      text: "second execution",
    });
    send("session.execution.succeeded", child);
    await Promise.resolve();

    const children = hub
      .turns("officer")
      ?.turns.filter((turn) => turn.session?.id === child);

    expect(children).toMatchObject([
      { status: "completed", session: { parent: { callId: "launch" } } },
      {
        status: "completed",
        session: { parent: { callId: "next" } },
        items: [{ text: "second execution" }],
      },
    ]);
  } finally {
    stop.abort();
  }
});

test("the per-log naming limit does not erase another log's exact proof", () => {
  const evidence = new ActivityCallEvidence(1);
  const first = log();
  const second = log();
  evidence.open(parent, undefined, first, "first", 1);
  evidence.open(parent, undefined, first, "retained", 2);
  evidence.open(parent, undefined, second, "second", 3);

  expect(evidence.name(parent, undefined, first, "first", child)).toBeNull();
  expect(evidence.name(parent, undefined, first, "retained", child)).toBe(2);
  expect(evidence.name(parent, undefined, second, "second", child)).toBe(3);
});

test("fallback launch input cannot turn a known non-subagent call into naming proof", () => {
  const evidence = new ActivityCallEvidence(2);
  const owner = log();
  evidence.open(parent, undefined, owner, "shell", 1, { subagent: false });

  const input = {
    order: 2,
    created: 2,
    input: { sessionID: child },
    mayLaunch: true,
  };

  evidence.input(parent, undefined, owner, "shell", input);
  evidence.input(parent, undefined, owner, "missing-input-start", input);

  expect(evidence.name(parent, undefined, owner, "shell", child)).toBeNull();
  expect(
    evidence.name(parent, undefined, owner, "missing-input-start", child),
  ).toBe(2);
});

function oldBucket(key: string) {
  return Bun.hash(key, 0n) % 4n;
}

test("an incarnation's saturated unnamed history cannot contaminate its replacement", () => {
  const evidence = new ActivityCallEvidence(1);
  const old = { active: true };
  const replacement = { active: true };

  // Reserve the old implementation's scope identities 1 and 2. Put the
  // First old parent in the replacement's old global overflow bucket.
  expect(evidence.competing(parent, old, child, window)).toBe(false);
  expect(evidence.competing(parent, replacement, child, window)).toBe(false);
  const bucket = oldBucket(`u${JSON.stringify([parent, 2])}`);

  const foreign = Array.from(
    { length: 256 },
    (_, index) => `ses_old_${index}`,
  ).find((id) => oldBucket(`u${JSON.stringify([id, 1])}`) === bucket);

  if (!foreign) {
    throw new Error("Expected an old-bucket collision");
  }

  evidence.open(foreign, old, log(), "evicted", 1);

  for (let index = 2; index <= 10; index += 1) {
    evidence.open(`ses_churn_${index}`, old, log(), "churn", index);
  }

  expect(evidence.competing(foreign, old, child, window)).toBe(true);
  old.active = false;
  evidence.fence?.(old);

  expect(evidence.competing(parent, replacement, child, window)).toBe(false);
  expect(evidence.competing(foreign, old, child, window)).toBe(false);
});

test("unresolved named spill retains the exact child even across compaction", () => {
  const evidence = new ActivityCallEvidence(1);
  const owner = log();
  evidence.open(parent, undefined, owner, "named", 1);
  expect(evidence.name(parent, undefined, owner, "named", child)).toBe(1);
  evidence.open(parent, undefined, owner, "evicts exact call", 2);

  for (let index = 3; index <= 11; index += 1) {
    evidence.open(`ses_churn_${index}`, undefined, log(), "churn", index);
  }

  const base = `n${JSON.stringify([parent, null])}:`;

  const other = Array.from(
    { length: 256 },
    (_, index) => `ses_other_${index}`,
  ).find((id) => oldBucket(base + id) === oldBucket(base + child));

  if (!other) {
    throw new Error("Expected an old-bucket collision");
  }

  expect(evidence.competing(parent, undefined, child, window)).toBe(true);
  expect(evidence.competing(parent, undefined, other, window)).toBe(false);
});

test("retiring a witnessed child removes only the portion of its named range that it consumed", () => {
  const evidence = new ActivityCallEvidence(1);
  const owner = log();
  evidence.open(parent, undefined, owner, "earlier", 1);
  expect(evidence.name(parent, undefined, owner, "earlier", child)).toBe(1);
  evidence.open(parent, undefined, owner, "later", 4);
  expect(evidence.name(parent, undefined, owner, "later", child)).toBe(4);

  evidence.retire?.(parent, undefined, child, 2);
  expect(evidence.competing(parent, undefined, child, window)).toBe(false);
  expect(
    evidence.competing(parent, undefined, child, {
      ...window,
      after: 2,
      through: 4,
    }),
  ).toBe(true);

  evidence.retire?.(parent, undefined, child, 4);
  expect(
    evidence.competing(parent, undefined, child, { ...window, through: 4 }),
  ).toBe(false);
});

test("native retirement preserves an earlier-arriving name opened after the retired start", () => {
  const evidence = new ActivityCallEvidence(2);
  const owner = log();
  evidence.open(parent, undefined, owner, "successor", 1, { created: 4 });
  expect(evidence.name(parent, undefined, owner, "successor", child)).toBe(1);
  evidence.open(parent, undefined, owner, "predecessor", 2, { created: 1 });
  expect(evidence.name(parent, undefined, owner, "predecessor", child)).toBe(2);

  evidence.discardStart(child, 2, 3);
  expect(evidence.competing(parent, undefined, child, window)).toBe(true);
  expect(
    evidence.competing(parent, undefined, child, {
      ...window,
      after: 1,
      through: 2,
    }),
  ).toBe(false);
});

test("native retirement cannot exclude a compressed name without its time", () => {
  const evidence = new ActivityCallEvidence(1);
  const owner = log();
  evidence.open(parent, undefined, owner, "compressed", 1, { created: 4 });
  expect(evidence.name(parent, undefined, owner, "compressed", child)).toBe(1);
  evidence.open(parent, undefined, owner, "newer", 4, { created: 5 });
  expect(evidence.name(parent, undefined, owner, "newer", child)).toBe(4);

  evidence.discardStart(child, 2, 3);
  expect(evidence.competing(parent, undefined, child, window)).toBe(true);

  evidence.discardStart(child, 2);
  expect(evidence.competing(parent, undefined, child, window)).toBe(false);
});
