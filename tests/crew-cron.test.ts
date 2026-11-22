import { expect, test } from "bun:test";
import { CrewCron } from "../src/crew/cron/cron";
import type { CrewCaller } from "../src/crew/execution/engine";
import { CrewError } from "../src/crew/execution/state";
import { CronControlError, type runCronOperation } from "../src/cron/control";

function fixture() {
  const calls: {
    raw: unknown;
    binding: Parameters<typeof runCronOperation>[1];
    signal: AbortSignal;
  }[] = [];
  const checks: CrewCaller[] = [];
  const authority = {
    options: {
      captainDirectory: "/captain",
      cron: { configPath: "/private/stargate.json", bot: "captain-bot" },
    },
    async captain(caller: CrewCaller) {
      checks.push(caller);
      if (caller.agent !== "captain") throw new CrewError("Captain only.");
    },
  };
  const runner: typeof runCronOperation = async (raw, binding, signal) => {
    calls.push({ raw, binding, signal });
    return { status: "queued", effect: "durably-admitted-not-completed" };
  };
  const caller: CrewCaller = {
    agent: "captain",
    sessionID: "ses_captain",
    id: "call_retry",
    signal: new AbortController().signal,
  };
  return { calls, checks, authority, runner, caller };
}

test("cron requires captain verification even for reads", async () => {
  const f = fixture();
  const cron = new CrewCron(f.authority, f.runner);
  for (const op of ["list", "report"])
    await expect(
      cron.run({ op }, { ...f.caller, agent: "worker" }),
    ).rejects.toThrow("Captain only.");
  expect(f.checks).toHaveLength(2);
  expect(f.calls).toHaveLength(0);
});

test("cron uses only configured binding and forwards cancellation signal", async () => {
  const f = fixture();
  const cron = new CrewCron(f.authority, f.runner);
  expect(await cron.run({ op: "list" }, f.caller)).toEqual({
    status: "queued",
    effect: "durably-admitted-not-completed",
  });
  expect(f.calls).toEqual([
    {
      raw: { op: "list", page: 0 },
      binding: {
        configPath: "/private/stargate.json",
        bot: "captain-bot",
        expectedDirectory: "/captain",
      },
      signal: f.caller.signal,
    },
  ]);
  for (const injected of [
    { configPath: "/other/stargate.json" },
    { bot: "other" },
    { expectedDirectory: "/other" },
  ])
    await expect(
      cron.run({ op: "list", ...injected }, f.caller),
    ).rejects.toThrow("Invalid stargate_cron input");
  expect(f.calls).toHaveLength(1);
});

test("cron missing configuration fails explicitly without running", async () => {
  const f = fixture();
  const cron = new CrewCron(
    { ...f.authority, options: { captainDirectory: "/captain" } },
    f.runner,
  );
  await expect(cron.run({ op: "list" }, f.caller)).rejects.toThrow(
    "Cronjobs unavailable",
  );
  expect(f.checks).toEqual([f.caller]);
  expect(f.calls).toHaveLength(0);
});

test("cron run retries retain host identity and explicit request IDs", async () => {
  const f = fixture();
  const cron = new CrewCron(f.authority, f.runner);
  const input = { op: "run", name: "nightly" };
  await cron.run(input, f.caller);
  await cron.run(input, f.caller);
  await cron.run({ ...input, requestId: "explicit" }, f.caller);
  await cron.run({ op: "report" }, f.caller);
  expect(f.calls.map(({ raw }) => raw)).toEqual([
    { ...input, requestId: "call_retry" },
    { ...input, requestId: "call_retry" },
    { ...input, requestId: "explicit" },
    { op: "report" },
  ]);
  expect(input).toEqual({ op: "run", name: "nightly" });
});

test("cron cancellation prevents admission before and after authorization", async () => {
  const f = fixture();
  const stop = new AbortController();
  const caller = { ...f.caller, signal: stop.signal };
  const cron = new CrewCron(
    {
      ...f.authority,
      async captain(caller: CrewCaller) {
        await f.authority.captain(caller);
        stop.abort(new Error("private abort detail"));
      },
    },
    f.runner,
  );
  await expect(cron.run({ op: "list" }, caller)).rejects.toThrow(
    "cancelled; inspect retained status",
  );
  await expect(cron.run({ op: "list" }, caller)).rejects.toThrow(CrewError);
  expect(f.checks).toHaveLength(1);
  expect(f.calls).toHaveLength(0);
});

test("cron in-flight cancellation reaches runner without exposing abort reason", async () => {
  const f = fixture();
  const stop = new AbortController();
  const cron = new CrewCron(f.authority, async (_raw, _binding, signal) => {
    expect(signal).toBe(stop.signal);
    stop.abort(new Error("private abort detail"));
    signal.throwIfAborted();
  });
  await expect(
    cron.run(
      { op: "run", name: "nightly" },
      { ...f.caller, signal: stop.signal },
    ),
  ).rejects.toThrow("cancelled; inspect retained status");
});

test("cron exposes only declared safe control failures", async () => {
  const f = fixture();
  const safe = new CrewCron(f.authority, async () => {
    throw new CronControlError("Cronjob user or channel is not allowed.");
  });
  await expect(safe.run({ op: "list" }, f.caller)).rejects.toThrow(
    "Cronjob user or channel is not allowed.",
  );
  for (const error of [new Error("secret"), new CrewError("secret")]) {
    const unsafe = new CrewCron(f.authority, async () => {
      throw error;
    });
    await expect(unsafe.run({ op: "list" }, f.caller)).rejects.toThrow(
      "raw details withheld",
    );
  }
  const unsafeAuthority = new CrewCron(
    {
      ...f.authority,
      async captain() {
        throw new Error("secret");
      },
    },
    f.runner,
  );
  await expect(unsafeAuthority.run({ op: "list" }, f.caller)).rejects.toThrow(
    "Captain verification unavailable; raw details withheld.",
  );
});
