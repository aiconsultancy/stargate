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

function fixture(
  parent: Promise<string> = Promise.resolve(main),
  pending?: number,
) {
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
    pending === undefined ? {} : { pending },
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
    launch(owner: TurnActivityLog, session: string, id: string, at: number) {
      emit(
        "session.tool.called",
        session,
        { id, input: { agent: "explore" } },
        at,
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
  [1, 1],
  [1, 2],
  [128, 128],
  [128, 129],
] as const)(
  "repeated witness stays publishable after overflow (capacity %i, names %i)",
  async (capacity, names) => {
    const parent = Promise.withResolvers<string>();
    const f = fixture(parent.promise, capacity === 1 ? capacity : undefined);

    try {
      const real = f.root();

      const started = Array.from(
        { length: Math.min(names, capacity) },
        (_, i) => `real_${i}`,
      );

      const fallback = names > capacity;

      for (const id of started) {
        f.call(real, main, id, 50);
      }

      // Keep the initial open call until it is named by using a fallback launch.
      if (fallback) {
        f.launch(real, main, "real_extra", 50);
      }

      const foreign = Array.from({ length: capacity }, (_, index) => {
        const session = `${other}_${index}`;
        const log = f.root(session);
        f.call(log, session, "foreign", 51);

        return { session, log };
      });

      f.start(40, "Observed child text");
      f.advance(300);

      for (const id of started) {
        f.name(real, main, id);
      }

      if (fallback) {
        f.name(real, main, "real_extra");
      }

      for (const { session, log } of foreign) {
        f.name(log, session, "foreign");
      }

      f.end();
      expect(real.retained?.()).toBe(true);
      expect(f.reads).toEqual([child]);
      parent.resolve(main);
      await setImmediate();
      expect(f.childTurns()).toMatchObject([
        {
          session: { parent: null },
          requests: [],
          status: "cancelled",
          lost: true,
          items: [{ text: "Observed child text" }],
        },
      ]);
    } finally {
      parent.resolve(main);
      f.stop.abort();
    }
  },
);

test.each([
  { limit: 1, foreignCount: 0, evict: true },
  { limit: 1, foreignCount: 1, evict: true },
  { limit: undefined, foreignCount: 127, evict: true },
  { limit: undefined, foreignCount: 128, evict: true },
  { limit: undefined, foreignCount: 128, evict: false },
])(
  "an evicted matching writer can still publish detached output (pending $limit, foreign $foreignCount, evict $evict)",
  async ({ limit, foreignCount, evict }) => {
    const parent = Promise.withResolvers<string>();
    const f = fixture(parent.promise, limit);

    try {
      const real = f.root();
      f.call(real, main, "real", 50);

      const foreign = Array.from({ length: foreignCount }, (_, index) => {
        const session = `${other}_${index}`;
        const log = f.root(session);
        f.call(log, session, "foreign", 51);

        return { session, log };
      });

      f.start(40, "Observed child text");
      f.advance(300);
      f.name(real, main, "real");

      for (const { session, log } of foreign) {
        f.name(log, session, "foreign");
      }

      f.end();

      if (evict) {
        f.families.settled(main, real);
        real.end("completed");

        for (let index = 0; index < 24; index += 1) {
          const session = `ses_churn_${index}`;
          const log = f.root(session);
          f.families.settled(session, log);
          log.end("completed");
        }
      }

      expect(real.retained?.()).toBe(!evict);
      expect(f.reads).toEqual([child]);
      parent.resolve(main);
      await setImmediate();
      expect(f.childTurns()).toMatchObject([
        {
          session: { parent: null },
          requests: [],
          status: "cancelled",
          lost: true,
          items: [{ text: "Observed child text" }],
        },
      ]);
    } finally {
      parent.resolve(main);
      f.stop.abort();
    }
  },
);

test.each([
  { limit: undefined, count: 127, foreignFirst: false },
  { limit: undefined, count: 128, foreignFirst: false },
  { limit: 1, count: 1, foreignFirst: false },
  { limit: 1, count: 1, foreignFirst: true },
  { limit: 2, count: 1, foreignFirst: false },
  { limit: 2, count: 1, foreignFirst: true },
  { limit: 1, count: 1, foreignFirst: false, fence: true },
  { limit: 1, count: 1, foreignFirst: false, fenceReal: true },
  { limit: 1, count: 1, foreignFirst: false, settleReal: true },
  { limit: 1, count: 1, foreignFirst: false, resolveForeign: true },
])(
  "witness capacity ($limit, foreign $count, foreign first $foreignFirst, fence $fence, fence real $fenceReal, settle real $settleReal, unrelated parent $resolveForeign)",
  async (row) => {
    const parent = Promise.withResolvers<string>();
    const f = fixture(parent.promise, row.limit);

    try {
      const realScope = { active: true };

      const root = f.root(
        main,
        row.fenceReal || row.settleReal ? realScope : undefined,
      );

      const foreign = Array.from({ length: row.count }, (_, index) => {
        const id = `ses_other_${index}`;
        const scope = { active: true };

        return { id, scope, log: f.root(id, row.fence ? scope : undefined) };
      });

      f.call(root, main, "real", 50);

      for (const { id, log } of foreign) {
        f.call(log, id, "foreign", 51);
      }

      f.start(40, "Observed child text");
      f.advance(300);

      if (!row.foreignFirst) {
        f.name(root, main, "real");
      }

      for (const { id, log } of foreign) {
        f.name(log, id, "foreign");
      }

      if (row.foreignFirst) {
        f.name(root, main, "real");
      }

      f.end();
      expect(f.reads).toEqual([child]);

      if (row.fence) {
        for (const { id, scope } of foreign) {
          f.families.fence(id, scope);
        }
      }

      if (row.fenceReal) {
        f.families.fence(main, realScope);
      }

      if (row.settleReal) {
        f.families.settled(main, root);
        root.end("completed");
      }

      parent.resolve(row.resolveForeign ? "ses_unrelated" : main);
      await setImmediate();

      const expected =
        row.fenceReal || row.resolveForeign
          ? []
          : [
              {
                session: { parent: null },
                requests: [],
                status: "cancelled",
                lost: true,
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
  {
    mode: "witness before fence",
    real: 50,
    foreign: 51,
    nameForeign: true,
    fence: true,
    lateName: false,
    nativeParent: main,
  },
  {
    mode: "proof before fence",
    real: 30,
    foreign: 31,
    nameForeign: true,
    fence: true,
    lateName: false,
    nativeParent: main,
  },
  {
    mode: "witness after fence",
    real: 50,
    foreign: 51,
    nameForeign: true,
    fence: true,
    lateName: true,
    nativeParent: main,
  },
  {
    mode: "proof after fence",
    real: 30,
    foreign: 31,
    nameForeign: true,
    fence: true,
    lateName: true,
    nativeParent: main,
  },
  {
    mode: "fence ended the native parent",
    real: 30,
    foreign: 31,
    nameForeign: true,
    fence: true,
    lateName: true,
    nativeParent: other,
  },
  {
    mode: "no foreign name",
    real: 50,
    foreign: 51,
    nameForeign: false,
    fence: true,
    lateName: true,
    nativeParent: main,
  },
  {
    mode: "no fence",
    real: 50,
    foreign: 51,
    nameForeign: true,
    fence: false,
    lateName: true,
    nativeParent: main,
  },
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

      if (!row.lateName) {
        f.name(root, main, "real");
      }

      f.end();
      expect(f.reads).toEqual(row.nameForeign || !row.lateName ? [child] : []);
      expect(f.childTurns()).toEqual([]);

      if (row.fence) {
        f.families.fence(other, scope);
      }

      if (row.lateName) {
        f.name(root, main, "real");
      }

      expect(f.reads).toEqual([child]);
      parent.resolve(row.nativeParent);
      await setImmediate();

      const linked = row.real < 40;

      const expected =
        row.nativeParent === other
          ? []
          : [
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
