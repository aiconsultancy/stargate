import { expect, test } from "bun:test";
import pino from "pino";
import type {
  ActivitySnapshot,
  ActivityView,
  ActivityWatch,
  CrewActivitySettings,
} from "../src/activity";
import { ActivityDelivery } from "../src/activity-delivery";
import type { AgentBackend } from "../src/backend";
import { Gateway, type SlackDelivery } from "../src/gateway";
import { Store } from "../src/store";
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
  const slack: SlackDelivery = {
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

test("finish during an outstanding read still finalizes and updates the original thread", async () => {
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
    handle?.finish();
    first.resolve(snapshot());
    await f.waiting;
    expect(f.views[0]).toMatchObject({
      channel: "C123",
      thread: "1.000",
      view: { detail: "detailed" },
    });
    f.tick();
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
    expect(cancel).toBe(1);
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
