import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, Exit, Result, Scope } from "effect";
import type {
  Destination,
  NotificationInput,
  Source,
} from "../src/notifications/ingest/model";
import {
  makeNotifications,
  type NotificationCore,
  type NotificationOptions,
  type NotificationTiming,
} from "../src/notifications/ingest/notifications";
import type {
  NotificationSink,
  SinkOutcome,
} from "../src/notifications/ingest/sink";
import { NotifyStore } from "../src/notifications/ingest/store";

const source: Source = {
  adapter: "http",
  principal: "ci",
  audience: "internal",
  topics: ["release.*"],
};
const destination: Destination = {
  transport: "slack",
  registrationId: "pegasus",
  appId: "AONE",
  workspaceId: "TONE",
  botUserId: "UONE",
  channel: "CONE",
  audience: "internal",
};
const input = (title = "Ready"): NotificationInput => ({
  schema: 1,
  topic: "release.desktop",
  occurredAt: "2026-11-19T02:00:00Z",
  payload: { title },
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
class TestClock implements NotificationTiming {
  time = 1000;
  readonly waits = new Set<{ at: number; finish: () => void }>();
  now = () => this.time;
  wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const item = {
        at: this.time + ms,
        finish: () => {
          signal.removeEventListener("abort", abort);
          this.waits.delete(item);
          resolve();
        },
      };
      const abort = () => {
        this.waits.delete(item);
        reject(new Error("cancelled test wait"));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      this.waits.add(item);
      signal.addEventListener("abort", abort, { once: true });
    });
  async advance(ms: number) {
    this.time += ms;
    for (const item of [...this.waits]) if (item.at <= this.time) item.finish();
    await turn();
  }
}
const directories: string[] = [];
const owned: { scope: Scope.Closeable; core: NotificationCore }[] = [];
async function open(
  options: Partial<Omit<NotificationOptions, "path">> = {},
  path?: string,
) {
  const directory = path
    ? undefined
    : mkdtempSync(
        join(
          process.env["TMPDIR"] ?? "/home/jack/.cache/tmp/opencode",
          "notify-core-",
        ),
      );
  if (directory) directories.push(directory);
  const databasePath = path ?? join(directory ?? "", "notify.sqlite");
  const clock = new TestClock();
  const scope = Effect.runSync(Scope.make());
  const core = await Effect.runPromise(
    makeNotifications({
      path: databasePath,
      subscriptions: [{ topic: "release.*", to: ["one"] }],
      destinations: { one: destination },
      sink: { allowed: () => true, send: async () => ({ state: "sent" }) },
      timing: clock,
      ...options,
    }).pipe(Scope.provide(scope)),
  );
  owned.push({ scope, core });
  await turn();
  return { core, clock, path: databasePath };
}
afterEach(async () => {
  for (const { scope, core } of owned.splice(0)) {
    expect((await core.shutdown()).state).toBe("closed");
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function disk(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      rows: db
        .query<
          {
            attempts: number;
            state: string;
            admittedAt: number;
            leaseEnd: number | null;
            title: string;
          },
          []
        >(
          "SELECT attempts,state,admittedAt,leaseEnd,json_extract(payload,'$.title') AS title FROM notify_outbox ORDER BY id",
        )
        .all(),
      dedup: db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM notify_dedup")
        .get()?.n,
    };
  } finally {
    db.close();
  }
}

test("publish commits before resolution, caller cancellation cannot undo admission, reopen deduplicates", async () => {
  const first = await open();
  const controller = new AbortController();
  const response = Effect.runPromise(
    first.core.publish(source, input()).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(disk(first.path)).toMatchObject({
            dedup: 1,
            rows: [{ attempts: 0, state: "pending", title: "Ready" }],
          });
          controller.abort();
        }),
      ),
      Effect.andThen(Effect.never),
    ),
    { signal: controller.signal },
  );
  await expect(response).rejects.toThrow();
  expect((await first.core.shutdown()).state).toBe("closed");
  const reopened = await open(
    { sink: { allowed: () => true, send: async () => ({ state: "unknown" }) } },
    first.path,
  );
  const duplicate = await Effect.runPromise(
    reopened.core.publish(source, input()),
  );
  expect(duplicate.duplicate).toBe(true);
  expect(disk(first.path).rows).toHaveLength(1);
});

test("queue saturation is QueueFull, shutdown resolves every queued waiter", async () => {
  const { core, path } = await open({ limits: { admissionQueue: 1 } });
  const replies = Array.from({ length: 20 }, (_, n) =>
    Effect.runPromise(
      core.publish(source, input(`event-${n}`)).pipe(Effect.result),
    ),
  );
  core.closeAdmission();
  const results = await Promise.all(replies);
  const errors = results.flatMap((result) =>
    Result.isFailure(result) ? [result.failure._tag] : [],
  );
  expect(errors).toContain("QueueFull");
  expect(errors).toContain("ShuttingDown");
  expect(results).toHaveLength(20);
  expect(disk(path).rows).toHaveLength(0);
  const closed = await Effect.runPromise(
    core.publish(source, input()).pipe(Effect.result),
  );
  expect(Result.isFailure(closed) && closed.failure._tag).toBe("ShuttingDown");
});

test("cancelling an offered caller detaches its wait, not admission ownership", async () => {
  const { core, path } = await open();
  const controller = new AbortController();
  const response = Effect.runPromise(core.publish(source, input()), {
    signal: controller.signal,
  });
  controller.abort();
  await expect(response).rejects.toThrow();
  await turn();
  expect(disk(path)).toMatchObject({
    dedup: 1,
    rows: [{ title: "Ready", attempts: 0, state: "pending" }],
  });
  expect(
    (await Effect.runPromise(core.publish(source, input()))).duplicate,
  ).toBe(true);
});

test("interrupted acquisition still registers and runs ordered core cleanup", async () => {
  const directory = mkdtempSync(
    join(
      process.env["TMPDIR"] ?? "/home/jack/.cache/tmp/opencode",
      "notify-acquire-",
    ),
  );
  directories.push(directory);
  const path = join(directory, "notify.sqlite");
  const clock = new TestClock();
  const controller = new AbortController();
  const response = Effect.runPromise(
    Effect.scoped(
      makeNotifications({
        path,
        subscriptions: [],
        destinations: {},
        sink: { allowed: () => true, send: async () => ({ state: "sent" }) },
        timing: {
          now: () => {
            controller.abort();
            return clock.now();
          },
          wait: clock.wait,
        },
      }),
    ),
    { signal: controller.signal },
  );
  await expect(response).rejects.toThrow();
  expect(clock.waits.size).toBe(0);
  const reopened = new NotifyStore(path);
  reopened.recover(clock.now());
  expect(reopened.claim(clock.now())).toBeUndefined();
  reopened.close();
});

test("admission snapshots caller data and topology before queued work", async () => {
  const target = { ...destination };
  const { core, path } = await open({ destinations: { one: target } });
  const value = input();
  const principal = { ...source };
  const response = Effect.runPromise(core.publish(principal, value));
  target.channel = "COTHER";
  value.payload.title = "changed";
  principal.principal = "other";
  await response;
  expect(disk(path).rows[0]?.title).toBe("Ready");
  const db = new Database(path, { readonly: true });
  try {
    expect(
      db
        .query<{ scope: string; channel: string }, []>(
          "SELECT scope,json_extract(destination,'$.channel') AS channel FROM notify_outbox",
        )
        .get(),
    ).toEqual({ scope: '["http","ci"]', channel: "CONE" });
  } finally {
    db.close();
  }
});

test("grants, invalid fanout and audience refusal store no partial admission", async () => {
  const { core, path } = await open({
    destinations: {
      one: destination,
      public: { ...destination, channel: "CPUBLIC", audience: "public" },
    },
    subscriptions: [{ topic: "release.*", to: ["one", "public"] }],
  });
  const forbidden = await Effect.runPromise(
    core
      .publish({ ...source, topics: ["other.*"] }, input())
      .pipe(Effect.result),
  );
  expect(Result.isFailure(forbidden) && forbidden.failure._tag).toBe(
    "TopicNotGranted",
  );
  const denied = await Effect.runPromise(
    core.publish(source, input()).pipe(Effect.result),
  );
  expect(Result.isFailure(denied) && denied.failure._tag).toBe(
    "StoreUnavailable",
  );
  expect(disk(path)).toEqual({ dedup: 0, rows: [] });
});

test("SQLite admission failure is StoreUnavailable and a same-envelope retry can commit", async () => {
  const { core, path } = await open();
  const db = new Database(path);
  try {
    db.exec(
      "CREATE TRIGGER fail AFTER INSERT ON notify_dedup BEGIN SELECT RAISE(ABORT,'test'); END",
    );
    const refused = await Effect.runPromise(
      core.publish(source, input()).pipe(Effect.result),
    );
    expect(Result.isFailure(refused) && refused.failure._tag).toBe(
      "StoreUnavailable",
    );
    expect(disk(path)).toEqual({ dedup: 0, rows: [] });
    db.exec("DROP TRIGGER fail");
    expect(
      (await Effect.runPromise(core.publish(source, input()))).duplicate,
    ).toBe(false);
    expect(disk(path).rows).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("four destinations progress independently, claims persist before send, spacing survives retries", async () => {
  const started: string[] = [];
  const releases = new Map<string, (outcome: SinkOutcome) => void>();
  const sink: NotificationSink = {
    allowed: () => true,
    send: async (target) => {
      started.push(target.channel);
      return await new Promise<SinkOutcome>((resolve) =>
        releases.set(target.channel, resolve),
      );
    },
  };
  const destinations = Object.fromEntries(
    Array.from({ length: 5 }, (_, n) => [
      `d${n}`,
      { ...destination, channel: `C${n}` },
    ]),
  );
  const { core, clock, path } = await open({
    sink,
    destinations,
    subscriptions: [{ topic: "release.*", to: Object.keys(destinations) }],
  });
  await Effect.runPromise(core.publish(source, input()));
  await clock.advance(25);
  expect(started).toEqual(["C0", "C1", "C2", "C3"]);
  expect(disk(path).rows.map((row) => [row.state, row.attempts])).toEqual([
    ["leased", 1],
    ["leased", 1],
    ["leased", 1],
    ["leased", 1],
    ["pending", 0],
  ]);
  releases.get("C1")?.({ state: "sent" });
  await turn();
  await clock.advance(25);
  expect(started).toEqual(["C0", "C1", "C2", "C3", "C4"]);
  for (const release of releases.values()) release({ state: "sent" });
  await turn();
  expect(disk(path).rows).toHaveLength(0);
  expect(core.counters.sent).toBe(5);
});

test("unknown outcomes replay exactly three claims; RetryAfter and admission age bound retries", async () => {
  const claims: number[] = [];
  const { core, clock, path } = await open({
    sink: {
      allowed: () => true,
      send: async () => {
        claims.push(clock.now());
        return { state: "unknown" };
      },
    },
  });
  await Effect.runPromise(core.publish(source, input()));
  await clock.advance(25);
  await clock.advance(999);
  expect(claims).toHaveLength(1);
  await clock.advance(25);
  expect(claims).toHaveLength(2);
  await clock.advance(2000);
  expect(claims).toHaveLength(3);
  await clock.advance(100000);
  expect(claims).toHaveLength(3);
  expect(disk(path).rows).toHaveLength(0);
  expect(core.counters.dropped).toBe(1);

  let sends = 0;
  const limited = await open({
    limits: { maxAgeMs: 3000 },
    sink: {
      allowed: () => true,
      send: async () => {
        sends++;
        return { state: "refused", retryable: true, retryAfterMs: 10000 };
      },
    },
  });
  await Effect.runPromise(limited.core.publish(source, input()));
  await limited.clock.advance(25);
  await limited.clock.advance(2975);
  expect(sends).toBe(1);
  expect(disk(limited.path).rows).toHaveLength(0);
});

test("send-time current policy drops a frozen binding, never redirects", async () => {
  let allowed = true;
  const sent: string[] = [];
  const { core, clock, path } = await open({
    sink: {
      allowed: (target) =>
        allowed &&
        target.channel === "CONE" &&
        target.sourceAudience === "internal",
      send: async (target) => {
        sent.push(target.channel);
        return { state: "sent" };
      },
    },
  });
  await Effect.runPromise(core.publish(source, input()));
  allowed = false;
  await clock.advance(25);
  expect(sent).toEqual([]);
  expect(disk(path).rows).toHaveLength(0);
  expect(core.counters.refused).toBe(1);
});

test("success respects destination spacing for the next queued occurrence", async () => {
  let sends = 0;
  const { core, clock, path } = await open({
    sink: {
      allowed: () => true,
      send: async () => {
        sends++;
        return { state: "sent" };
      },
    },
  });
  await Effect.runPromise(core.publish(source, input("first")));
  await Effect.runPromise(core.publish(source, input("second")));
  await clock.advance(25);
  expect(sends).toBe(1);
  expect(disk(path).rows[0]?.attempts).toBe(0);
  await clock.advance(999);
  expect(sends).toBe(1);
  await clock.advance(25);
  expect(sends).toBe(2);
  expect(disk(path).rows).toHaveLength(0);
});

test("shutdown aborts underlying send, waits for actual settlement before closing SQLite", async () => {
  const aborted = Deferred.makeUnsafe<void>();
  let release: (outcome: SinkOutcome) => void = () => {
    throw new Error("send not started");
  };
  const { core, clock, path } = await open({
    sink: {
      allowed: () => true,
      send: async (_target, _payload, signal) => {
        signal.addEventListener(
          "abort",
          () => Deferred.doneUnsafe(aborted, Effect.void),
          { once: true },
        );
        return await new Promise<SinkOutcome>((resolve) => {
          release = resolve;
        });
      },
    },
  });
  await Effect.runPromise(core.publish(source, input()));
  await clock.advance(25);
  let closed = false;
  const stopping = core.shutdown().then((result) => {
    closed = true;
    return result;
  });
  await Effect.runPromise(Deferred.await(aborted));
  expect(closed).toBe(false);
  expect(disk(path).rows[0]?.state).toBe("leased");
  release({ state: "unknown" });
  expect(await stopping).toEqual({ state: "closed" });
  expect(disk(path).rows[0]).toMatchObject({
    state: "pending",
    attempts: 1,
    admittedAt: 1000,
  });
});

test("nonsettling sink remains owned after deadline, expired lease, and unresolved shutdown", async () => {
  let sends = 0;
  let aborted = false;
  let release: (outcome: SinkOutcome) => void = () => {
    throw new Error("send not started");
  };
  const { core, clock, path } = await open({
    sink: {
      allowed: () => true,
      send: async (_target, _payload, signal) => {
        sends++;
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return await new Promise<SinkOutcome>((resolve) => {
          release = resolve;
        });
      },
    },
  });
  await Effect.runPromise(core.publish(source, input()));
  await clock.advance(25);
  await clock.advance(61000);
  expect(aborted).toBe(true);
  expect(sends).toBe(1);
  expect(disk(path).rows[0]).toMatchObject({ state: "leased", attempts: 1 });
  const stop = core.shutdown();
  await clock.advance(25000);
  expect(await stop).toEqual({ state: "unresolved", active: 1 });
  expect(disk(path).rows[0]?.state).toBe("leased");
  release({ state: "unknown" });
  await turn();
  expect(await core.shutdown()).toEqual({ state: "closed" });
  expect(disk(path).rows[0]?.attempts).toBe(1);
});

test.each(["before-commit", "after-commit", "after-claim", "after-acceptance"])(
  "process kill %s preserves actual row/attempt state on same-file reopen",
  async (point) => {
    const directory = mkdtempSync(
      join(
        process.env["TMPDIR"] ?? "/home/jack/.cache/tmp/opencode",
        "notify-crash-",
      ),
    );
    directories.push(directory);
    const path = join(directory, "notify.sqlite");
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "notify-crash-fixture.ts"),
        path,
        point,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "" },
      },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
      const store = new NotifyStore(path);
      try {
        const before = disk(path);
        if (point === "before-commit")
          expect(before).toEqual({ dedup: 0, rows: [] });
        else {
          const attempts = point === "after-commit" ? 0 : 1;
          expect(before).toMatchObject({
            dedup: 1,
            rows: [
              {
                attempts,
                state: attempts ? "leased" : "pending",
                admittedAt: 1000,
              },
            ],
          });
        }
        store.recover(2000);
        console.info(
          JSON.stringify({
            crash: point,
            before: {
              dedup: before.dedup,
              rows: before.rows.map(({ title: _title, ...row }) => row),
            },
            recovered: disk(path).rows.map(({ title: _title, ...row }) => row),
          }),
        );
        const accepted = store.admit(
          source,
          input(),
          () => [destination],
          2000,
        );
        expect(accepted.duplicate).toBe(point !== "before-commit");
        const claim = store.claim(2000);
        if (!claim) throw new Error("recovered claim missing");
        expect(claim.attempts).toBe(
          point === "after-claim" || point === "after-acceptance" ? 2 : 1,
        );
        if (point === "after-acceptance") {
          expect(readFileSync(`${path}.sent`, "utf8")).toBe("accepted\n");
          const replay: NotificationSink = {
            allowed: () => true,
            send: async () => {
              appendFileSync(`${path}.sent`, "accepted\n");
              return { state: "sent" };
            },
          };
          expect(
            await replay.send(
              claim.destination,
              claim.payload,
              new AbortController().signal,
            ),
          ).toEqual({ state: "sent" });
          expect(readFileSync(`${path}.sent`, "utf8")).toBe(
            "accepted\naccepted\n",
          );
        }
        store.settle(claim, { state: "sent" }, 2001);
        expect(disk(path).rows).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      await child.exited;
    }
  },
);
