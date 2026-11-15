import { expect, test } from "bun:test";
import { CrewMaintenance } from "../src/crew/maintenance";
import { maintenanceWindowMs, TurnBudget } from "../src/maintenance";

const plan = {
  plan: "Restart Stargate",
  impact: "Brief disconnect",
  rollback: "Restore release",
};
const caller = (signal = new AbortController().signal) => ({
  sessionID: "captain",
  agent: "adama",
  signal,
});
const owner = { sessionID: "captain", id: "turn" };

function fixture() {
  let now = 0;
  let authorized = true;
  const waiting = new Set<() => void>();
  const gate = new CrewMaintenance(
    {
      options: { team: { captain: { id: "adama" } } },
      async captain(input) {
        if (
          !authorized ||
          input.agent !== "adama" ||
          input.sessionID !== "captain"
        )
          throw new Error("Not captain");
      },
    },
    {
      now: () => now,
      wait: (_ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const done = () => {
            signal.removeEventListener("abort", abort);
            waiting.delete(done);
            resolve();
          };
          const abort = () => {
            signal.removeEventListener("abort", abort);
            waiting.delete(done);
            reject(new Error("Cancelled"));
          };
          waiting.add(done);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
    },
  );
  return {
    gate,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => {
      for (const resolve of [...waiting]) resolve();
    },
    deny: () => {
      authorized = false;
    },
  };
}

test("maintenance requires confirmed notice delivery and the full opt-out window", async () => {
  let now = 1000;
  const waits: (() => void)[] = [];
  const gate = new CrewMaintenance(
    { options: { team: { captain: { id: "adama" } } }, async captain() {} },
    {
      now: () => now,
      wait: () => new Promise<void>((resolve) => waits.push(resolve)),
    },
  );
  const signal = new AbortController().signal;
  const owner = { sessionID: "captain", id: "turn" };
  await gate.open(owner, signal);
  const task = gate.run(
    {
      plan: "Restart Stargate",
      impact: "Brief disconnect",
      rollback: "Restore release",
    },
    { sessionID: "captain", agent: "adama", signal },
  );
  await Promise.resolve();
  const notice = gate.read(owner);
  expect(notice?.plan).toBe("Restart Stargate");
  if (!notice) throw new Error("Notice missing");
  const advance = (ms: number) => {
    while (ms > 0) {
      const step = Math.min(ms, 5000);
      now += step;
      gate.read(owner);
      ms -= step;
    }
  };
  advance(maintenanceWindowMs);
  expect(gate.read(owner)?.id).toBe(notice.id);
  gate.delivered({ ...owner, noticeID: notice.id });
  advance(maintenanceWindowMs - 1);
  gate.read(owner);
  let permitted = false;
  void task.then(() => {
    permitted = true;
  });
  await Promise.resolve();
  expect(permitted).toBe(false);
  now++;
  gate.read(owner);
  expect(await task).toMatchObject({
    status: "window-elapsed",
    windowMs: 300_000,
  });
  gate.close(owner);
  for (const resolve of waits) resolve();
});

test("cancellation, disposal, expired lease and failed authority never grant permission", async () => {
  for (const action of ["cancel", "dispose", "disconnect"] as const) {
    const f = fixture();
    const stop = new AbortController();
    await f.gate.open(owner, stop.signal);
    const result = f.gate.run(plan, caller(stop.signal));
    const rejected = result.then(
      () => false,
      () => true,
    );
    await Promise.resolve();
    const notice = f.gate.read(owner);
    if (!notice) throw new Error("Missing notice");
    f.gate.delivered({ ...owner, noticeID: notice.id });
    if (action === "cancel") stop.abort();
    if (action === "dispose") f.gate.dispose();
    if (action === "disconnect") {
      f.advance(10_001);
      f.tick();
    }
    expect(await rejected).toBe(true);
    f.gate.dispose();
  }
  const f = fixture();
  f.deny();
  await expect(f.gate.open(owner, caller().signal)).rejects.toThrow(
    "Not captain",
  );
  await expect(f.gate.run(plan, caller())).rejects.toThrow("Not captain");
});

test("turn ownership, stale delivery and unregistered tool calls fail closed", async () => {
  const f = fixture();
  await expect(f.gate.run(plan, caller())).rejects.toThrow(
    "No live maintenance gateway",
  );
  await f.gate.open(owner, caller().signal);
  await expect(f.gate.open(owner, caller().signal)).rejects.toThrow(
    "already registered",
  );
  for (const other of [
    { ...owner, sessionID: "other" },
    { ...owner, id: "other" },
  ]) {
    expect(() => f.gate.read(other)).toThrow("ownership unavailable");
    expect(() => f.gate.delivered({ ...other, noticeID: "old" })).toThrow();
  }
  expect(() => f.gate.close({ ...owner, id: "other" })).toThrow("turn changed");
  const result = f.gate.run(plan, caller());
  const rejected = result.then(
    () => false,
    () => true,
  );
  await Promise.resolve();
  expect(() => f.gate.delivered({ ...owner, noticeID: "old" })).toThrow(
    "notice changed",
  );
  await expect(f.gate.run(plan, caller())).rejects.toThrow("notice is pending");
  f.gate.close(owner);
  expect(await rejected).toBe(true);
  await expect(f.gate.run(plan, caller())).rejects.toThrow(
    "No live maintenance gateway",
  );
  await expect(f.gate.run({ ...plan, plan: "" }, caller())).rejects.toThrow(
    "Invalid maintenance plan",
  );
});

test("duplicate delivery cannot shorten the window and expired gateway cannot reconnect", async () => {
  const f = fixture();
  await f.gate.open(owner, caller().signal);
  const result = f.gate.run(plan, caller());
  const rejected = result.then(
    () => false,
    () => true,
  );
  await Promise.resolve();
  const notice = f.gate.read(owner);
  if (!notice) throw new Error("Missing notice");
  f.gate.delivered({ ...owner, noticeID: notice.id });
  f.advance(5000);
  f.gate.delivered({ ...owner, noticeID: notice.id });
  expect(f.gate.read(owner)?.id).toBe(notice.id);
  f.advance(10_001);
  expect(() => f.gate.read(owner)).toThrow("disconnected");
  expect(await rejected).toBe(true);
});

test("turn budget pauses only the maintenance wait and does not replenish work time", () => {
  let now = 0;
  const timers: { ms: number; cancelled: boolean; expire(): void }[] = [];
  const budget = new TurnBudget(
    30_000,
    () => now,
    (ms, expire) => {
      const timer = { ms, expire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  );
  try {
    now = 1000;
    budget.pause();
    expect(timers[0]?.cancelled).toBe(true);
    now += maintenanceWindowMs;
    budget.resume();
    expect(timers[1]?.ms).toBe(29_000);
    expect(budget.controller.signal.aborted).toBe(false);
    budget.pause();
    budget.resume();
    expect(timers[2]?.ms).toBe(29_000);
    expect(budget.controller.signal.aborted).toBe(false);
    timers[2]?.expire();
    expect(budget.controller.signal.aborted).toBe(true);
  } finally {
    budget.close();
  }
});
