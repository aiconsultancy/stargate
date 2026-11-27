import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import type { TurnActivityLog } from "../src/backends/backend";
import {
  type ActivityFamilyEvent,
  OpenCodeActivityFamilies,
  isActivityEvent,
} from "../src/backends/opencode/activity-family";
import { createActivityHub } from "../src/observability/dashboard/api/v1/activity";

const main = "ses_root";
const child = "ses_child";
const other = "ses_other_root";

function fixture(parent: Promise<string> = Promise.resolve(main)) {
  const stop = new AbortController();
  const hub = createActivityHub();
  const reads: string[] = [];
  let now = 0;
  let seq = 0;

  const families = new OpenCodeActivityFamilies(
    {
      signal: stop.signal,
      parent(id) {
        reads.push(id);

        return parent;
      },
      async active() {
        throw new Error("No reconnect observation");
      },
      async *log() {},
    },
    {},
    () => now,
  );

  function emit(
    type: ActivityFamilyEvent["type"],
    sessionID: string,
    data: object,
    created: number | null,
    owner?: TurnActivityLog,
  ) {
    const event = {
      type,
      data: { sessionID, assistantMessageID: "answer", ...data },
      ...(created !== null && { created }),
      ...(sessionID === child && {
        durable: { aggregateID: child, seq: ++seq, version: 1 },
      }),
    } as ActivityFamilyEvent;

    const order = families.receive(event);

    if (owner && isActivityEvent(event)) {
      families.owned(owner, event, order);
    }
  }

  return {
    stop,
    reads,
    families,
    root(id = main, scope?: { active: boolean }) {
      const log = hub.recorder("officer").begin(undefined, id);
      families.track(id, log, scope);
      emit("session.text.delta", id, { ordinal: 0, delta: "root" }, 1, log);

      return log;
    },
    call(
      owner: TurnActivityLog,
      session: string,
      id: string,
      at: number | null,
    ) {
      emit(
        "session.tool.input.started",
        session,
        { id, name: "subagent" },
        at,
        owner,
      );
    },
    name(owner: TurnActivityLog, session: string, id: string) {
      emit(
        "session.tool.progress",
        session,
        { id, metadata: { sessionID: child } },
        999,
        owner,
      );
    },
    create() {
      emit("session.created", child, { parentID: main }, 2);
    },
    start(at: number | null, text: string) {
      emit("session.execution.started", child, {}, at);
      emit(
        "session.text.ended",
        child,
        { assistantMessageID: `child-answer-${seq}`, ordinal: 0, text },
        null,
      );
    },
    end() {
      emit("session.execution.succeeded", child, {}, null);
    },
    advance(ms: number) {
      now += ms;
      emit("session.text.delta", main, { ordinal: 0, delta: "clock" }, null);
    },
    childTurns: () =>
      hub.turns("officer")?.turns.filter((turn) => turn.session?.id === child),
  };
}

test.each([
  {
    mode: "witness only",
    real: 50,
    foreign: 51,
    nameForeign: true,
    fence: true,
  },
  { mode: "real proof", real: 30, foreign: 31, nameForeign: true, fence: true },
  {
    mode: "no foreign name",
    real: 50,
    foreign: 51,
    nameForeign: false,
    fence: true,
  },
  { mode: "no fence", real: 50, foreign: 51, nameForeign: true, fence: false },
])(
  "foreign writer fenced before ancestry cannot erase child output ($mode)",
  async (row) => {
    const parent = Promise.withResolvers<string>();
    const f = fixture(parent.promise);

    try {
      const root = f.root();
      const scope = { active: true };
      const foreign = f.root(other, scope);
      f.call(root, main, "real", row.real);
      f.call(foreign, other, "foreign", row.foreign);
      f.start(40, "Observed child text");
      f.advance(300);

      if (row.nameForeign) {
        f.name(foreign, other, "foreign");
      }

      f.name(root, main, "real");
      f.end();
      expect(f.reads).toEqual([child]);
      expect(f.childTurns()).toEqual([]);

      if (row.fence) {
        f.families.fence(other, scope);
      }

      parent.resolve(main);
      await setImmediate();

      const linked = row.real < 40;

      const expected = [
        {
          session: { parent: linked ? { callId: "real" } : null },
          status: linked ? "completed" : "cancelled",
          ...(!linked && { lost: true, requests: [] }),
          items: [{ text: "Observed child text" }],
        },
      ];

      expect(f.childTurns()).toMatchObject(expected);
      f.advance(1701);
      expect(f.childTurns()).toMatchObject(expected);
    } finally {
      parent.resolve(main);
      f.stop.abort();
    }
  },
);

test.each([
  { mode: "timed control", first: 105, earlyCall: 101, expected: "c3" },
  { mode: "untimed A1", first: null, earlyCall: 101, expected: "c3" },
  {
    mode: "untimed A1 without c1",
    first: null,
    earlyCall: undefined,
    expected: "c3",
  },
  { mode: "untimed A1 and c1", first: null, earlyCall: null, expected: "c3" },
  {
    mode: "untimed A2",
    first: 203,
    second: null,
    earlyCall: 101,
    expected: "c3",
  },
  {
    mode: "timed maximum survives out-of-order timestamps",
    first: 205,
    earlyCall: 204,
    expected: "c3",
  },
  {
    mode: "early m survives and competes with c3",
    first: null,
    earlyCall: 250,
    expected: null,
  },
  {
    mode: "early m alone never binds",
    first: null,
    earlyCall: 250,
    name: "m",
    expected: null,
  },
  {
    mode: "Deimos timed A1 with an empty first band",
    first: 105,
    earlyCall: undefined,
    expected: "c3",
  },
  {
    mode: "Deimos untimed A1 without c2",
    first: null,
    earlyCall: undefined,
    omitSecondCall: true,
    expected: "c3",
  },
])("post-loss untimed retirement and timed cutoff: $mode", async (row) => {
  const f = fixture();

  try {
    const root = f.root();
    f.create();
    f.start(5, "first period");
    await f.families.reconnected();

    if (row.earlyCall !== undefined) {
      f.call(root, main, "m", row.earlyCall);
    }

    f.start(row.first, "A1 output");
    f.end();
    f.advance(1900);

    if (!row.omitSecondCall) {
      f.call(root, main, "c2", 201);
    }

    f.start(row.second === null ? null : 203, "A2 output");
    f.end();
    f.advance(100);
    f.advance(1800);

    if (row.name !== "m") {
      f.call(root, main, "c3", 300);
    }

    f.start(301, "A3 output");
    f.advance(100);
    f.advance(200);
    f.name(root, main, row.name ?? "c3");
    f.end();
    f.advance(2100);

    expect(f.childTurns()?.slice(1)).toMatchObject([
      ...["A1 output", "A2 output"].map((text) => ({
        session: { parent: null },
        status: "cancelled",
        lost: true,
        items: [{ text }],
      })),
      {
        session: {
          parent: row.expected === null ? null : { callId: row.expected },
        },
        status: row.name === "m" ? "cancelled" : "completed",
        ...(row.name === "m" && { lost: true }),
        items: [{ text: "A3 output" }],
      },
    ]);
  } finally {
    f.stop.abort();
  }
});

test.each([
  { kind: "proof", foreign: 31, fence: true },
  { kind: "witness", foreign: 51, fence: true },
  { kind: "control", foreign: 31, fence: false },
])(
  "known native parent survives a foreign name ($kind, fence $fence)",
  async (row) => {
    const f = fixture();

    try {
      const root = f.root();
      const scope = { active: true };
      const foreign = f.root(other, scope);
      f.call(root, main, "real", 30);
      f.call(foreign, other, "foreign", row.foreign);
      f.start(40, "Observed child text");
      f.name(foreign, other, "foreign");
      await setImmediate();
      expect(f.reads).toEqual([child]);
      expect(f.childTurns()).toEqual([]);

      if (row.fence) {
        f.families.fence(other, scope);
      }

      f.advance(300);
      f.name(root, main, "real");
      f.end();
      expect(f.childTurns()).toMatchObject([
        {
          session: { parent: { callId: "real" } },
          status: "completed",
          items: [{ text: "Observed child text" }],
        },
      ]);
      expect(f.reads).toEqual([child]);
    } finally {
      f.stop.abort();
    }
  },
);
