import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  mock,
  test,
} from "bun:test";
import type { AgentBackend } from "../src/backends/backend";
import type { FleetCrewStatusInput } from "../src/coordination/crew/reporting/fleet-status";
import type { CrewStatus } from "../src/shared/crew-status";
import { CronStore } from "../src/automation/cron/store";
import {
  type DashboardShip,
  dashboardSource,
} from "../src/observability/dashboard/dashboard-source";
import { botKey, conversationKey } from "../src/gateway/routing";
import type {
  HistorySession,
  SessionHistory,
} from "../src/shared/session-history";
import { openStore } from "../src/app/open-store";
import { bot, identity } from "./fixtures";

const signal = new AbortController().signal;
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    close();
  }
});

const session = (
  id: string,
  extra: Partial<HistorySession> = {},
): HistorySession => ({
  id,
  harness: "opencode",
  kind: extra.parentID ? "subagent" : "conversation",
  ...extra,
});

function fixture(options: { pinned?: string; crewStatus?: boolean } = {}) {
  const store = openStore(":memory:");
  const cronStore = new CronStore(":memory:");
  closers.push(
    () => store.close(),
    () => cronStore.close(),
  );
  const config = bot();
  const key = botKey(config, identity);
  const known = new Map<string, HistorySession>();
  const calls = { roots: 0, describe: 0, entries: [] as string[] };
  let crewRoots: HistorySession[] | Error = [];
  const leaked: HistorySession[] = [];

  let crewStatus: CrewStatus = {
    total: 2,
    truncated: false,
    members: [member("chief", true), member("twiki", false)],
  };

  const history: SessionHistory = {
    async roots() {
      calls.roots++;

      if (crewRoots instanceof Error) {
        throw crewRoots;
      }

      return crewRoots;
    },
    async describe(ids) {
      calls.describe++;

      return ids.flatMap((id) => {
        const found = known.get(id);

        return found ? [found] : [];
      });
    },
    async children({ parentID, cursor }) {
      return {
        sessions: cursor
          ? leaked
          : [...known.values()].filter((item) => item.parentID === parentID),
      };
    },
    async entries({ sessionID }) {
      calls.entries.push(sessionID);

      return { entries: [] };
    },
  };

  const backend: AgentBackend = {
    sessionID: options.pinned,
    history,
    async createSession() {
      return "unused";
    },
    async prompt() {
      return "";
    },
    async close() {},
    ...(options.crewStatus === false
      ? {}
      : {
          async crewStatus() {
            return crewStatus;
          },
        }),
  };

  let clock = 1_000_000;
  const ship: DashboardShip = { bot: config, identity, key, backend };

  const map = (thread: string, sessionID: string, owner = key) => {
    const conversation = conversationKey(owner, "C123", thread);
    store.enqueue({
      eventId: `C123:${thread}`,
      botKey: owner,
      conversation,
      channel: "C123",
      thread,
      user: "U123",
      text: "private prompt text",
    });
    store.saveSession(conversation, sessionID);
  };

  return {
    store,
    cronStore,
    ship,
    key,
    known,
    calls,
    setCrewStatus: (value: CrewStatus) => {
      crewStatus = value;
    },
    map,
    leak: (value: HistorySession) => {
      leaked.push(value);
    },
    setCrewRoots: (value: HistorySession[] | Error) => {
      crewRoots = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    source: dashboardSource([ship], store, cronStore, () => clock),
  };
}

function member(id: string, busy: boolean) {
  const task = {
    id: `task-${id}`,
    status: "running" as const,
    kind: "assignment" as const,
    summary: "Work",
    phase: "",
    progress: "",
    createdAt: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
  };

  return {
    id,
    name: id,
    backend: "opencode" as const,
    provisioned: "ready" as const,
    observed: false,
    current: busy ? task : null,
    queuedCount: 0,
    queued: [],
    lastOutcome: null,
    recent: [],
    recentCount: 0,
  };
}

describe("dashboard source", () => {
  test("Fleet sampling only supports the unfiltered unredacted view", async () => {
    const { ship, store, cronStore } = fixture();
    const calls: FleetCrewStatusInput[] = [];
    ship.backend.fleetCrewStatus = async (input) => {
      calls.push(input);

      const members = input.member
        ? [member(input.member, true)]
        : [member("pilot", true), member("other", false)];

      return {
        status: { members, total: members.length, truncated: false },
        metadata: { projectDirectory: "/fixture", contexts: [] },
      };
    };

    const source = dashboardSource([ship], store, cronStore);
    expectTypeOf<
      Parameters<typeof source.fleetWithCrew>["length"]
    >().toEqualTypeOf<2 | 3>();

    await source.shipWithCrew(ship.bot.id, signal, {
      member: "pilot",
      taskText: "full",
    });
    const sample = await source.fleetWithCrew(signal, new Set([ship.bot.id]));
    expect(sample.ships[0]?.members?.map(({ id }) => id)).toEqual([
      "pilot",
      "other",
    ]);
    expect(calls).toEqual([
      { member: "pilot", taskText: "full" },
      { taskText: "unredacted" },
    ]);
  });

  test.each([true, false])(
    "retiring an unused alias leaves the primary crew read running (healthy: %s)",
    async (healthy) => {
      const { ship, store, cronStore } = fixture({ pinned: "ses_captain" });
      const started = Promise.withResolvers<AbortSignal>();
      const finish = Promise.withResolvers<CrewStatus>();
      ship.backend.crewStatus = async (_input, reading) => {
        started.resolve(reading);

        return finish.promise;
      };

      const aliasStatus = mock(async () => ({
        members: [],
        total: 0,
        truncated: false,
      }));

      const alias = {
        ...ship,
        bot: { ...ship.bot, id: "unused" },
        key: "unused",
        transport: {
          kind: "teams",
          tenantId: "example",
          botClientId: "alias",
        },
        backend: { ...ship.backend, crewStatus: aliasStatus },
      } satisfies DashboardShip;

      const ships = [ship, alias];
      const source = dashboardSource(ships, store, cronStore);
      const read = source.fleetWithCrew(signal, new Set([ship.bot.id]));
      const reading = await started.promise;
      ships.pop();
      source.retireFleetBackend(alias.backend);

      if (healthy) {
        finish.resolve({
          members: [member("pilot", false)],
          total: 1,
          truncated: false,
        });
      } else {
        finish.reject(new Error("Primary unavailable"));
      }

      const [result] = (await read).ships;
      expect(reading.aborted).toBe(false);
      expect(aliasStatus).not.toHaveBeenCalled();

      if (healthy) {
        expect(result?.summary.crew?.total).toBe(1);
      } else {
        expect(result?.error).toBe("Crew status unavailable.");
      }
    },
  );

  test("truncated crew summaries use exact aggregates or explicitly report a partial busy count", async () => {
    const f = fixture();

    const members = Array.from({ length: 20 }, (_, index) =>
      member(`worker${index}`, false),
    );

    f.setCrewStatus({ total: 36, truncated: true, members, busy: 1 });
    expect((await f.source.fleet(signal)).ships[0]?.crew).toEqual({
      total: 36,
      busy: 1,
      people: { total: 20, busy: 0, partial: true },
    });
    f.setCrewStatus({ total: 36, truncated: true, members });
    expect((await f.source.fleet(signal)).ships[0]?.crew).toEqual({
      total: 36,
      busy: 0,
      busyPartial: true,
      people: { total: 20, busy: 0, partial: true },
    });
  });
  test("fleet and ship views report state without prompt or reply text", async () => {
    const f = fixture({ pinned: "ses_captain" });
    f.known.set("ses_captain", session("ses_captain", { title: "Captain" }));
    f.known.set("ses_old", session("ses_old"));
    f.map("1.000", "ses_captain");
    f.map("2.000", "ses_old");
    f.setCrewRoots([
      session("ses_chief", { kind: "crew", member: "chief" }),
      session("pi:twiki", {
        kind: "crew",
        member: "twiki",
        harness: "pi-durable",
      }),
    ]);
    f.cronStore.add(
      { botKey: f.key, channel: "C123", user: "U123" },
      {
        name: "Report",
        expression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Private cron prompt.",
      },
      Date.parse("2026-01-01T00:00:00Z"),
    );

    const fleet = await f.source.fleet(signal);
    expect(fleet.ships).toEqual([
      {
        id: "helper",
        name: "helper",
        backend: "opencode",
        crew: { total: 2, busy: 1, people: { total: 2, busy: 1 } },
        queue: { queued: 2, running: 0, responding: 0, done: 0, failed: 0 },
        cronjobs: 1,
      },
    ]);

    const ship = await f.source.ship("helper", signal);
    expect(ship?.sessions.map((item) => [item.id, item.kind])).toEqual([
      ["ses_captain", "captain"],
      ["ses_chief", "crew"],
      ["pi:twiki", "crew"],
      ["ses_old", "conversation"],
    ]);
    expect(ship?.sessionsMore).toBe(false);
    expect(ship?.queue.recent).toHaveLength(2);
    expect(ship?.cron).toMatchObject({ fileBacked: false, runs: [] });
    const text = JSON.stringify([fleet, ship]);
    expect(text).not.toContain("private prompt text");
    expect(text).not.toContain("Private cron prompt.");
    expect(text).not.toContain("TOKEN");
    expect(await f.source.ship("missing", signal)).toBeUndefined();
  });

  test("a backend without crew or history reports that plainly", async () => {
    const f = fixture({ crewStatus: false });
    f.setCrewRoots(new Error("no plugin"));
    const ship = await f.source.ship("helper", signal);
    expect(ship?.crew).toBeNull();
    expect(ship?.crewError).toBeUndefined();
    expect(ship?.sessionsError).toBeUndefined();
    expect((await f.source.fleet(signal)).ships[0]?.crew).toBeNull();
  });

  test("only ship roots and their descendants are readable", async () => {
    const f = fixture({ pinned: "ses_captain" });
    const other = botKey(bot("other"), { team: "T123", user: "UOTHER" });
    f.map("1.000", "ses_mapped");
    f.map("9.000", "ses_other_bot", other);
    f.setCrewRoots([session("ses_chief", { kind: "crew", member: "chief" })]);
    f.known.set("ses_child", session("ses_child", { parentID: "ses_chief" }));
    f.known.set("ses_grand", session("ses_grand", { parentID: "ses_child" }));
    f.known.set("ses_foreign", session("ses_foreign"));
    f.known.set(
      "ses_foreign_child",
      session("ses_foreign_child", { parentID: "ses_foreign" }),
    );
    f.known.set(
      "ses_other_child",
      session("ses_other_child", { parentID: "ses_other_bot" }),
    );

    const read = (sessionID: string) =>
      f.source.entries(
        "helper",
        { sessionID, limit: 30, order: "desc", detail: "summary" },
        signal,
      );

    for (const id of [
      "ses_captain",
      "ses_mapped",
      "ses_chief",
      "ses_child",
      "ses_grand",
    ]) {
      expect(await read(id)).toEqual({ entries: [] });
    }

    for (const id of [
      "ses_foreign",
      "ses_foreign_child",
      "ses_other_bot",
      "ses_other_child",
      "ses_unknown",
    ]) {
      expect(await read(id)).toBeUndefined();
    }

    expect(f.calls.entries).toEqual([
      "ses_captain",
      "ses_mapped",
      "ses_chief",
      "ses_child",
      "ses_grand",
    ]);
    expect(
      await f.source.children("helper", { parentID: "ses_foreign" }, signal),
    ).toBeUndefined();
    expect(
      await f.source.children("helper", { parentID: "ses_chief" }, signal),
    ).toMatchObject({ sessions: [{ id: "ses_child" }] });
    expect(
      await f.source.entries(
        "missing",
        {
          sessionID: "ses_captain",
          limit: 30,
          order: "desc",
          detail: "summary",
        },
        signal,
      ),
    ).toBeUndefined();
  });

  test("a child page that leaves the requested parent is rejected", async () => {
    const f = fixture({ pinned: "ses_captain" });
    const ship = f.source;
    f.known.set("ses_ok", session("ses_ok", { parentID: "ses_captain" }));
    expect(
      await ship.children("helper", { parentID: "ses_captain" }, signal),
    ).toMatchObject({ sessions: [{ id: "ses_ok" }] });
    // A backend that follows a foreign cursor returns another parent's rows.
    f.leak(session("ses_leak", { parentID: "ses_foreign" }));
    await expect(
      ship.children(
        "helper",
        { parentID: "ses_captain", cursor: "foreign" },
        signal,
      ),
    ).rejects.toThrow("left the requested session");
  });

  test("a parent chain beyond the depth limit or with a cycle is refused", async () => {
    const f = fixture({ pinned: "ses_captain" });
    let parent = "ses_captain";

    for (let depth = 1; depth <= 9; depth++) {
      f.known.set(
        `ses_d${depth}`,
        session(`ses_d${depth}`, { parentID: parent }),
      );
      parent = `ses_d${depth}`;
    }

    f.known.set("ses_a", session("ses_a", { parentID: "ses_b" }));
    f.known.set("ses_b", session("ses_b", { parentID: "ses_a" }));

    const read = (sessionID: string) =>
      f.source.entries(
        "helper",
        { sessionID, limit: 30, order: "desc", detail: "summary" },
        signal,
      );

    expect(await read("ses_d7")).toEqual({ entries: [] });
    expect(await read("ses_d9")).toBeUndefined();
    expect(await read("ses_a")).toBeUndefined();
  });

  test("unreadable crew roots deny crew sessions and are not cached", async () => {
    const f = fixture({ pinned: "ses_captain" });

    const read = () =>
      f.source.entries(
        "helper",
        { sessionID: "ses_chief", limit: 30, order: "desc", detail: "summary" },
        signal,
      );

    f.setCrewRoots(new Error("private RPC detail"));
    expect(await read()).toBeUndefined();
    const ship = await f.source.ship("helper", signal);
    expect(ship?.sessionsError).toBe("Crew sessions unavailable.");
    expect(JSON.stringify(ship)).not.toContain("private RPC detail");

    f.setCrewRoots([session("ses_chief", { kind: "crew", member: "chief" })]);
    expect(await read()).toEqual({ entries: [] });
    const before = f.calls.roots;
    expect(await read()).toEqual({ entries: [] });
    expect(f.calls.roots).toBe(before);
    f.advance(10_001);
    await read();
    expect(f.calls.roots).toBe(before + 1);
  });

  test("older conversation roots are bounded and flagged", async () => {
    const f = fixture({ pinned: "ses_captain" });
    f.known.set("ses_captain", session("ses_captain"));

    for (let index = 0; index < 55; index++) {
      f.known.set(`ses_${index}`, session(`ses_${index}`));
      f.map(`${index}.000`, `ses_${index}`);
    }

    const ship = await f.source.ship("helper", signal);
    expect(ship?.sessions).toHaveLength(50);
    expect(ship?.sessions[0]?.id).toBe("ses_captain");
    expect(ship?.sessions[1]?.id).toBe("ses_54");
    expect(ship?.sessionsMore).toBe(true);
  });
});

describe("dashboard store accessors", () => {
  test("recent cron runs carry metadata only", () => {
    const cronStore = new CronStore(":memory:");
    closers.push(() => cronStore.close());
    const now = Date.parse("2026-01-01T00:00:00Z");
    const scope = { botKey: "bot", channel: "C123", user: "U123" };
    cronStore.add(
      scope,
      {
        name: "Report",
        expression: "* * * * *",
        timezone: "UTC",
        prompt: "Private cron prompt.",
        report: "daily",
      },
      now,
    );
    const [run] = cronStore.claimDue("bot", now + 60_000);

    if (!run) {
      throw new Error("Expected due run");
    }

    cronStore.finish(run.id, "failed", now + 61_000);
    expect(cronStore.recentRuns("bot")).toEqual([
      {
        id: run.id,
        name: "Report",
        status: "failed",
        dueAt: now + 60_000,
        finishedAt: now + 61_000,
        manual: false,
        report: "daily",
      },
    ]);
    expect(cronStore.recentRuns("other")).toEqual([]);
    expect(() => cronStore.recentRuns("bot", 101)).toThrow();
  });

  test("session ownership is scoped to the bot namespace", () => {
    const store = openStore(":memory:");
    closers.push(() => store.close());
    const conversation = conversationKey("bot", "C123", "1.000");
    store.enqueue({
      eventId: "C123:1.000",
      botKey: "bot",
      conversation,
      channel: "C123",
      thread: "1.000",
      user: "U123",
      text: "hello",
    });
    store.saveSession(conversation, "ses_one");
    expect(store.transcript.ownsSession("bot", "ses_one")).toBe(true);
    expect(store.transcript.ownsSession("other", "ses_one")).toBe(false);
    expect(store.transcript.ownsSession("bot", "ses_two")).toBe(false);
    expect(store.transcript.sessionIDs("bot", 10)).toEqual(["ses_one"]);
    expect(store.queueCounts("bot").queued).toBe(1);
  });
});
