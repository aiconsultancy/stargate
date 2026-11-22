import { expect, spyOn, test } from "bun:test";
import pino from "pino";
import type {
  ActivitySnapshot,
  ActivityView,
  ActivityWatch,
  CrewActivitySettings,
} from "../src/activity/activity";
import { ActivityDelivery } from "../src/activity/activity-delivery";
import type { AgentBackend } from "../src/backend";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import { Store } from "../src/gateway/store";
import { bot, event, identity } from "./fixtures";

const signal = () => new AbortController().signal;
function snapshot(
  revision = 1,
  status: ActivitySnapshot["status"] = "collecting",
): ActivitySnapshot {
  return {
    id: "report-1",
    revision,
    status,
    reporter: "Twiki",
    summary: "",
    entries: [
      {
        id: 1,
        taskID: "task-1",
        member: "Chief",
        kind: "assignment",
        text: "Check formatting",
      },
    ],
    truncated: false,
  };
}
function fixture(
  watch: ActivityWatch,
  settings: CrewActivitySettings = { detail: "summary", reporter: "twiki" },
  options: { finalizeTimeoutMs?: number } = {},
) {
  const config = bot();
  const store = new Store(":memory:");
  let starts = 0;
  let allowed = true;
  const views: {
    channel: string;
    thread: string;
    ts?: string;
    view: ActivityView;
  }[] = [];
  const written = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  const backend: AgentBackend = {
    async createSession() {
      return "captain";
    },
    async prompt() {
      return "Captain answer";
    },
    async startActivity(_session, requestID) {
      expect(requestID).toStartWith("slack-job-");
      starts++;
      return watch;
    },
    async close() {},
  };
  const slack: TransportDelivery = {
    async post() {},
    async activity(channel, thread, view, ts) {
      views.push({ channel, thread, view, ...(ts ? { ts } : {}) });
      written[views.length - 1]?.resolve();
      return "report-message";
    },
  };
  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
  );
  gateway.accept(event());
  const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
  if (!job) throw new Error("No fixture job");
  const pending = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const delivery = new ActivityDelivery(
    backend,
    slack,
    () => settings,
    () => allowed,
    pino({ enabled: false }),
    {
      ...options,
      store,
      wait: async (_ms, stop) => {
        waiting.resolve();
        if (stop.aborted) throw new Error("aborted");
        await Promise.race([
          pending.promise,
          new Promise<never>((_, reject) => {
            stop.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
        ]);
      },
    },
  );
  return {
    backend,
    slack,
    store,
    views,
    written,
    job,
    delivery,
    waiting: waiting.promise,
    tick: () => pending.resolve(),
    revoke: () => {
      allowed = false;
    },
    get starts() {
      return starts;
    },
    async close() {
      await delivery.close();
      await gateway.close();
      store.close();
    },
  };
}

test("activity is opt-in and disabled mode starts no capture or inference", async () => {
  const f = fixture(
    {
      async read() {
        throw new Error("must not read");
      },
      async finish() {
        throw new Error("must not finish");
      },
      async cancel() {},
    },
    { detail: "off", reporter: "twiki" },
  );
  try {
    expect(
      await f.delivery.start(f.job, "captain", signal(), signal()),
    ).toBeUndefined();
    expect(f.starts).toBe(0);
    expect(f.views).toEqual([]);
  } finally {
    await f.close();
  }
});

test("restart and terminal late refresh reuse persisted capture and Slack timestamp", async () => {
  let current = snapshot();
  let cancels = 0;
  let finishes = 0;
  const watch: ActivityWatch = {
    id: "report-1",
    async read() {
      return current;
    },
    async finish() {
      finishes++;
      return current;
    },
    async cancel() {
      cancels++;
    },
  };
  const f = fixture(watch);
  const create = () =>
    new ActivityDelivery(
      f.backend,
      f.slack,
      () => ({ detail: "summary" }),
      () => true,
      pino({ enabled: false }),
      { store: f.store },
    );
  try {
    await f.delivery.start(f.job, "captain", signal(), signal());
    await f.waiting;
    await f.delivery.close();
    expect(cancels).toBe(0);
    expect(f.store.activity(f.job.id)).toMatchObject({
      capture: "report-1",
      ts: "report-message",
      done: false,
    });
    f.backend.resumeActivity = (session, capture) => {
      expect(session).toBe("captain");
      expect(capture).toBe("report-1");
      return watch;
    };
    current = snapshot(2, "complete");
    const resumed = create();
    await resumed.resume(f.job, "captain", signal());
    await f.written[1]?.promise;
    await resumed.close();
    expect(f.views[1]?.ts).toBe("report-message");
    expect(f.store.activity(f.job.id)?.done).toBe(true);
    expect(f.starts).toBe(1);
    expect(finishes).toBe(1);
    current = {
      ...snapshot(3, "complete"),
      entries: [
        { id: 3, member: "Chief", kind: "note", text: "Late verified fact" },
      ],
    };
    const published = Promise.withResolvers<void>();
    const publish = f.slack.activity;
    if (!publish) throw new Error("Missing activity writer");
    f.slack.activity = async (...args) => {
      const ts = await publish(...args);
      published.resolve();
      return ts;
    };
    const late = create();
    await late.resume(f.job, "captain", signal());
    await published.promise;
    await late.close();
    expect(f.views.at(-1)?.ts).toBe("report-message");
    expect(f.views.at(-1)?.view.entries[0]?.text).toBe("Late verified fact");
    expect(finishes).toBe(1);
    expect(f.starts).toBe(1);
  } finally {
    await f.close();
  }
});

test("missing saved capture stops retries without opening a new capture", async () => {
  const watch: ActivityWatch = {
    id: "missing",
    async read() {
      throw new Error("This captain does not own the activity capture.");
    },
    async finish() {
      throw new Error("This captain does not own the activity capture.");
    },
    async cancel() {},
  };
  const f = fixture(watch);
  try {
    f.store.saveActivity(f.job.id, {
      capture: "missing",
      revision: -1,
      done: false,
    });
    const saved = Promise.withResolvers<void>();
    const save = f.store.saveActivity.bind(f.store);
    f.store.saveActivity = (id, progress) => {
      save(id, progress);
      if (progress.done) saved.resolve();
    };
    f.backend.resumeActivity = () => watch;
    await f.delivery.resume(f.job, "captain", signal());
    await saved.promise;
    await f.delivery.close();
    expect(f.store.activity(f.job.id)?.done).toBe(true);
    expect(f.starts).toBe(0);
    expect(f.views).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a saved Stop never starts a summary if native cancellation was unconfirmed", async () => {
  let finishes = 0;
  const f = fixture({
    id: "report-1",
    async read() {
      return snapshot(2);
    },
    async finish() {
      finishes++;
      throw new Error("Must not finalize a stopped capture");
    },
    async cancel() {},
  });
  try {
    f.store.saveActivity(f.job.id, {
      capture: "report-1",
      ts: "report-message",
      revision: 1,
      done: true,
    });
    f.backend.resumeActivity = () => ({
      async read() {
        return snapshot(2);
      },
      async finish() {
        finishes++;
        return snapshot(3, "complete");
      },
      async cancel() {},
    });
    await f.delivery.resume(f.job, "captain", signal());
    await f.written[0]?.promise;
    await f.delivery.close();
    expect(finishes).toBe(0);
    expect(f.views[0]).toMatchObject({
      ts: "report-message",
      view: { status: "cancelled" },
    });
    expect(f.starts).toBe(0);
  } finally {
    await f.close();
  }
});

test("finish wakes the poll interval and updates the original thread", async () => {
  const first = Promise.withResolvers<ActivitySnapshot>();
  const final = Promise.withResolvers<void>();
  let finished = 0;
  let cancelled = 0;
  const f = fixture(
    {
      async read() {
        return first.promise;
      },
      async finish() {
        finished++;
        final.resolve();
        return {
          ...snapshot(2, "complete"),
          summary: "Chief verified formatting.",
        };
      },
      async cancel() {
        cancelled++;
      },
    },
    { detail: "detailed", reporter: "twiki" },
  );
  try {
    const handle = await f.delivery.start(f.job, "captain", signal(), signal());
    first.resolve(snapshot());
    await f.waiting;
    handle?.finish();
    expect(f.views[0]).toMatchObject({
      channel: "C123",
      thread: "1.000",
      view: { detail: "detailed" },
    });
    await final.promise;
    await f.written[1]?.promise;
    await f.delivery.close();
    expect(finished).toBe(1);
    expect(cancelled).toBe(0);
    expect(f.views[1]).toMatchObject({
      channel: "C123",
      thread: "1.000",
      ts: "report-message",
      view: { summary: "Chief verified formatting.", status: "complete" },
    });
  } finally {
    await f.close();
  }
});

test("finish interrupts an outstanding read and uses a separate finalization signal", async () => {
  const blocked = Promise.withResolvers<ActivitySnapshot>();
  const final = Promise.withResolvers<void>();
  let reading: AbortSignal | undefined;
  const f = fixture({
    async read(stop) {
      reading = stop;
      return blocked.promise;
    },
    async finish(stop) {
      expect(stop.aborted).toBe(false);
      final.resolve();
      return snapshot(2, "complete");
    },
    async cancel() {},
  });
  try {
    const handle = await f.delivery.start(f.job, "captain", signal(), signal());
    handle?.finish();
    await final.promise;
    expect(reading?.aborted).toBe(true);
    await f.written[0]?.promise;
    expect(f.views[0]?.view.status).toBe("complete");
  } finally {
    await f.close();
  }
});

test("access revocation cancels reporting before another Slack update", async () => {
  const cancelled = Promise.withResolvers<void>();
  const f = fixture({
    async read() {
      return snapshot();
    },
    async finish() {
      return snapshot();
    },
    async cancel() {
      cancelled.resolve();
    },
  });
  try {
    await f.delivery.start(f.job, "captain", signal(), signal());
    await f.waiting;
    expect(f.views).toHaveLength(1);
    f.revoke();
    f.tick();
    await cancelled.promise;
    expect(f.views).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("captain answer delivery does not wait for reporting or replay on retry", async () => {
  const config = bot();
  config.crewActivity = { detail: "summary", reporter: "twiki" };
  const store = new Store(":memory:");
  const blocked = Promise.withResolvers<ActivitySnapshot>();
  let captures = 0;
  let turns = 0;
  let posts = 0;
  let cancel = 0;
  const answers: string[] = [];
  const backend: AgentBackend = {
    async createSession() {
      return "captain";
    },
    async prompt() {
      turns++;
      return "Final answer";
    },
    async startActivity() {
      captures++;
      return {
        read: () => blocked.promise,
        finish: () => blocked.promise,
        async cancel() {
          cancel++;
        },
      };
    },
    async close() {},
  };
  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    {
      async post(_channel, _thread, text) {
        if (posts++ === 0) throw new Error("Temporary Slack failure");
        answers.push(text);
      },
      async activity() {
        return "report";
      },
    },
    pino({ enabled: false }),
  );
  try {
    gateway.accept(event());
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("No job");
    await gateway.process(job, signal());
    const retry = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!retry) throw new Error("No pending answer delivery");
    await gateway.process(retry, signal());
    expect(answers).toEqual(["Final answer"]);
    expect(captures).toBe(1);
    expect(turns).toBe(1);
    await gateway.close();
    expect(cancel).toBe(0);
  } finally {
    await gateway.close();
    store.close();
  }
});

test("reporting transport failure cannot turn a successful answer into an error", async () => {
  const config = bot();
  config.crewActivity.detail = "summary";
  const store = new Store(":memory:");
  const answers: string[] = [];
  const backend: AgentBackend = {
    async createSession() {
      return "captain";
    },
    async prompt() {
      return "Still answered";
    },
    async startActivity() {
      throw new Error("PRIVATE transport error");
    },
    async close() {},
  };
  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    {
      async post(_channel, _thread, text) {
        answers.push(text);
      },
      async activity() {
        throw new Error("must not post");
      },
    },
    pino({ enabled: false }),
  );
  try {
    gateway.accept(event());
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("No job");
    await gateway.process(job, signal());
    expect(answers).toEqual(["Still answered"]);
  } finally {
    await gateway.close();
    store.close();
  }
});

test("empty captures and summary-only status never create an activity box", async () => {
  const read = Promise.withResolvers<void>();
  const f = fixture({
    async read() {
      read.resolve();
      return { ...snapshot(), entries: [], summary: "Collecting activity" };
    },
    async finish() {
      return {
        ...snapshot(2, "complete"),
        entries: [],
        summary: "No assignments",
      };
    },
    async cancel() {},
  });
  try {
    const handle = await f.delivery.start(f.job, "captain", signal(), signal());
    await read.promise;
    await f.waiting;
    expect(f.views).toEqual([]);
    handle?.finish();
    f.tick();
    await f.delivery.close();
    expect(f.views).toEqual([]);
  } finally {
    await f.close();
  }
});

test("explicit Stop cancels capture and terminalizes an existing activity box", async () => {
  const cancelled = Promise.withResolvers<void>();
  const request = new AbortController();
  const f = fixture({
    async read() {
      return snapshot();
    },
    async finish() {
      throw new Error("must not summarize aborted work");
    },
    async cancel() {
      cancelled.resolve();
    },
  });
  try {
    const handle = await f.delivery.start(
      f.job,
      "captain",
      request.signal,
      signal(),
    );
    await f.waiting;
    expect(f.views[0]?.view.status).toBe("collecting");
    handle?.cancel();
    await cancelled.promise;
    await f.written[1]?.promise;
    expect(f.views[1]).toMatchObject({
      ts: "report-message",
      view: { status: "cancelled" },
    });
  } finally {
    await f.close();
  }
});

test("a report read failure terminalizes the visible activity box", async () => {
  let reads = 0;
  const f = fixture({
    async read() {
      if (reads++) throw new Error("PRIVATE transport error");
      return snapshot();
    },
    async finish() {
      return snapshot(2, "complete");
    },
    async cancel() {},
  });
  try {
    await f.delivery.start(f.job, "captain", signal(), signal());
    await f.waiting;
    f.tick();
    await f.written[1]?.promise;
    expect(f.views[1]).toMatchObject({
      ts: "report-message",
      view: { status: "unavailable" },
    });
    expect(JSON.stringify(f.views)).not.toContain("PRIVATE");
  } finally {
    await f.close();
  }
});

test("finalization grace bounds a stuck report and marks the existing box unavailable", async () => {
  const blocked = Promise.withResolvers<ActivitySnapshot>();
  let cancelled = 0;
  const f = fixture(
    {
      async read() {
        return snapshot();
      },
      async finish() {
        return blocked.promise;
      },
      async cancel() {
        cancelled++;
      },
    },
    { detail: "summary", reporter: "twiki" },
    { finalizeTimeoutMs: 10 },
  );
  try {
    const handle = await f.delivery.start(f.job, "captain", signal(), signal());
    await f.waiting;
    handle?.finish();
    await f.written[1]?.promise;
    expect(f.views[1]).toMatchObject({
      ts: "report-message",
      view: { status: "unavailable" },
    });
    expect(cancelled).toBe(0);
  } finally {
    await f.close();
  }
});

for (const outcome of ["complete", "failure"] as const) {
  test(`retained activity handle cannot restart timers after ${outcome}`, async () => {
    const calls: string[] = [];
    const f = fixture({
      async read() {
        calls.push("read");
        if (outcome === "failure") throw new Error("Read failed");
        return snapshot(2, "complete");
      },
      async finish() {
        calls.push("finish");
        return snapshot(2, "complete");
      },
      async cancel() {
        calls.push("cancel");
      },
    });
    try {
      const handle = await f.delivery.start(
        f.job,
        "captain",
        signal(),
        signal(),
      );
      expect(handle).toBeDefined();
      // Drain terminal/failure cleanup before exercising the retained handle.
      await f.delivery.close();
      const before = [...calls];
      const unexpectedTimer = Object.assign(
        () => {
          throw new Error("Settled activity must not create timers");
        },
        { __promisify__: setTimeout.__promisify__ },
      );
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(
        unexpectedTimer,
      );
      try {
        expect(() => {
          handle?.finish();
          handle?.finish();
          handle?.cancel();
          handle?.cancel();
        }).not.toThrow();
        await f.delivery.close();
        expect(timer).not.toHaveBeenCalled();
        expect(calls).toEqual(before);
      } finally {
        timer.mockRestore();
      }
    } finally {
      await f.close();
    }
  });
}

test("retained handle stays inert while failed activity cleanup is still draining", async () => {
  const read = Promise.withResolvers<ActivitySnapshot>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<ActivitySnapshot>();
  let readSignal: AbortSignal | undefined;
  let reads = 0;
  let finishes = 0;
  let cancels = 0;
  const f = fixture({
    async read(signal) {
      readSignal = signal;
      if (!reads++) return snapshot();
      return read.promise;
    },
    async finish() {
      finishes++;
      cleaning.resolve();
      return release.promise;
    },
    async cancel() {
      cancels++;
    },
  });
  try {
    const handle = await f.delivery.start(f.job, "captain", signal(), signal());
    expect(handle).toBeDefined();
    await f.waiting;
    f.tick();
    read.reject(new Error("Read failed"));
    await cleaning.promise;
    const unexpectedTimer = Object.assign(
      () => {
        throw new Error("Activity cleanup must not create grace timers");
      },
      { __promisify__: setTimeout.__promisify__ },
    );
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
      unexpectedTimer,
    );
    try {
      expect(() => {
        handle?.finish();
        handle?.finish();
        handle?.cancel();
        handle?.cancel();
      }).not.toThrow();
      expect(timer).not.toHaveBeenCalled();
      expect(readSignal?.aborted).toBe(false);
      expect(finishes).toBe(1);
      expect(cancels).toBe(0);
    } finally {
      timer.mockRestore();
    }
    release.resolve(snapshot(2, "complete"));
    await f.written[1]?.promise;
    expect(f.views[1]?.view.status).toBe("unavailable");
  } finally {
    release.resolve(snapshot(2, "complete"));
    await f.close();
  }
});
