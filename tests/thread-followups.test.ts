import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { AgentBackend, SteerResult } from "../src/backends/backend";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import type { DrainControl } from "../src/maintenance/maintenance-drain";
import { openStore } from "../src/app/open-store";
import { type Store } from "../src/gateway/store";
import { bot, event, identity } from "./fixtures";

const stores: Store[] = [];
afterEach(() => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
});

function fixture(enabled = true, drain?: DrainControl) {
  const config = bot();
  if (config.backend.type !== "opencode")
    throw new Error("Expected OpenCode config");
  config.backend.sessionID = "ses_captain";
  config.slack.steerThreadFollowUps = enabled;
  const store = openStore(":memory:");
  stores.push(store);
  const writes: string[] = [];
  const posts: { thread: string; text: string }[] = [];
  const reactions: string[] = [];
  let result: SteerResult = { status: "accepted" };
  let duringWrite: (() => void) | undefined;
  const backend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      return "ses_captain";
    },
    async prompt() {
      return "Done";
    },
    async steer(input) {
      expect(store.followUps(gateway.key)[0]?.state).toBe("writing");
      duringWrite?.();
      if (!input.allowed()) return { status: "refused" };
      writes.push(input.id);
      return result;
    },
    async close() {},
  };
  const slack: TransportDelivery = {
    async post(_channel, thread, text) {
      posts.push({ thread, text });
    },
    async react(_channel, message) {
      reactions.push(message);
    },
  };
  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    drain,
  );
  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1, true)[0];
    if (!job) throw new Error("Expected queued request");
    return job;
  };
  const start = () => {
    expect(gateway.accept(event())).toBe(true);
    const job = next();
    expect(store.running(job.id, job.text)).toBe(true);
    store.saveInput(gateway.key, job.id, "msg_original", "ses_captain");
    return job;
  };
  const follow = (thread = "1.000", ts = "2.000") => {
    const request = event("<@UBOT> use the revised scope", ts);
    return {
      ...request,
      event: { ...request.event, type: "message", thread_ts: thread },
    };
  };
  return {
    config,
    store,
    gateway,
    backend,
    slack,
    writes,
    posts,
    reactions,
    start,
    next,
    follow,
    result(value: SteerResult) {
      result = value;
    },
    duringWrite(value: () => void) {
      duringWrite = value;
    },
  };
}

test("same-thread busy follow-up persists before native write, steers once and links the original reply", async () => {
  const f = fixture();
  const owner = f.start();
  expect(f.gateway.accept(f.follow())).toBe(true);
  expect(f.gateway.accept(f.follow())).toBe(false);
  expect(f.writes).toEqual([]);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(0);
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(f.writes).toHaveLength(1);
  expect(f.reactions).toEqual(["2.000"]);
  expect(f.store.followUpLinks(owner.id)).toContain("/archives/C123/p2000");
});

test("flag defaults off and idle intake remains an ordinary request", () => {
  expect(bot().slack.steerThreadFollowUps).toBe(false);
  const disabled = fixture(false);
  disabled.start();
  expect(disabled.gateway.accept(disabled.follow())).toBe(true);
  expect(disabled.store.queueCounts(disabled.gateway.key).queued).toBe(1);
  const idle = fixture();
  expect(idle.gateway.accept(event())).toBe(true);
  expect(idle.next().text).toBe("hello");
});

test("another thread or DM queues with a short note, never steers", async () => {
  const f = fixture();
  f.start();
  expect(f.gateway.accept(f.follow("3.000"))).toBe(true);
  const dm = event("separate request", "4.000");
  expect(
    f.gateway.accept({
      ...dm,
      event: {
        ...dm.event,
        type: "message",
        channel: "D123",
        channel_type: "im",
      },
    }),
  ).toBe(true);
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(f.writes).toEqual([]);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(2);
  expect(f.posts.map((post) => post.text)).toEqual([
    "Queued behind another request.",
    "Queued behind another request.",
  ]);
});

test("native refusal queues once and says so; uncertain write never queues or replays", async () => {
  for (const status of ["refused", "uncertain"] as const) {
    const f = fixture();
    f.start();
    f.result({ status });
    f.gateway.accept(f.follow());
    await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
    expect(f.gateway.accept(f.follow())).toBe(false);
    await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
    expect(f.writes).toHaveLength(1);
    expect(f.store.queueCounts(f.gateway.key).queued).toBe(
      status === "refused" ? 1 : 0,
    );
    expect(f.reactions).toEqual([]);
    expect(f.posts[0]?.text).toContain(
      status === "refused" ? "queued" : "unconfirmed",
    );
  }
});

test("completed ownership and Stop during preflight prevent a native steer", async () => {
  const f = fixture();
  const owner = f.start();
  f.gateway.accept(f.follow());
  f.duringWrite(() =>
    f.store.cancelTurn(f.gateway.key, owner.conversation, owner.thread),
  );
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(f.writes).toEqual([]);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(1);
});

test("a maintenance drain queues follow-ups instead of extending the running native turn", async () => {
  let held = false;
  const f = fixture(true, { held: () => held, tick() {}, attach() {} });
  f.start();
  f.gateway.accept(f.follow());
  held = true;
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(f.writes).toEqual([]);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(1);
  expect(f.posts[0]?.text).toContain("queued");
});

test("files, denied users, bot senders and meta controls never steer", async () => {
  const f = fixture();
  f.start();
  const file = f.follow();
  expect(
    f.gateway.accept({
      ...file,
      event: { ...file.event, files: [{ id: "F123" }] },
    }),
  ).toBe(true);
  const denied = f.follow("1.000", "3.000");
  expect(
    f.gateway.accept({ ...denied, event: { ...denied.event, user: "UOTHER" } }),
  ).toBe(false);
  expect(
    f.gateway.accept({ ...denied, event: { ...denied.event, bot_id: "B123" } }),
  ).toBe(false);
  const meta = f.follow("1.000", "4.000");
  expect(
    f.gateway.accept({
      ...meta,
      event: { ...meta.event, text: "<@UBOT> /status" },
    }),
  ).toBe(false);
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(f.writes).toEqual([]);
});

test("uncertain receipt later reconciles read-only with bounded retries and one reaction", async () => {
  const f = fixture();
  f.start();
  f.result({ status: "uncertain" });
  let reads = 0;
  f.backend.reconcileSteer = async () => {
    reads++;
    return { status: "accepted" };
  };
  f.gateway.accept(f.follow());
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(reads).toBe(0);
  setSystemTime(new Date(Date.now() + 5000));
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(reads).toBe(1);
  expect(f.writes).toHaveLength(1);
  expect(f.reactions).toEqual(["2.000"]);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(0);
});

test("failed uncertainty notices cannot bypass native reconciliation backoff or cap", async () => {
  const f = fixture();
  f.start();
  f.result({ status: "uncertain" });
  f.slack.post = async () => {
    throw new Error("Notification unavailable");
  };
  let reads = 0;
  f.backend.reconcileSteer = async () => {
    reads++;
    return { status: "uncertain" };
  };
  f.gateway.accept(f.follow());
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  for (let i = 0; i < 12; i++)
    await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(reads).toBe(0);
  for (let i = 0; i < 12; i++) {
    setSystemTime(new Date(Date.now() + 120_000));
    await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  }
  expect(reads).toBe(7);
  expect(f.writes).toHaveLength(1);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(0);
});

test("restart catch-up keeps accepted follow-up references on the original source", async () => {
  const f = fixture();
  f.store.captainCursor(f.gateway.key, "ses_captain");
  const owner = f.start();
  f.gateway.accept(f.follow());
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  f.store.recover(f.gateway.key);
  expect(f.store.finish(owner.id)).toBe(true);
  await f.gateway.close();
  f.backend.prompt = async () => {
    throw new Error("Catch-up must not prompt");
  };
  f.backend.transcript = async (_session, after) => {
    expect(after).toBe("msg_original");
    return {
      cursor: "msg_final",
      input: "msg_original",
      entries: [
        {
          id: "msg_final",
          input: "msg_original",
          text: "Recovered final answer",
          created: 5,
        },
      ],
    };
  };
  const restarted = new Gateway(
    f.config,
    identity,
    f.store,
    f.backend,
    f.slack,
    pino({ enabled: false }),
  );
  try {
    restarted.settle("ses_captain");
    await restarted.catchUp(AbortSignal.timeout(1000));
    await restarted.process(f.next(), AbortSignal.timeout(1000));
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.thread).toBe("1.000");
    expect(f.posts[0]?.text).toContain("Recovered final answer");
    expect(f.posts[0]?.text).toContain("https://slack.com/archives/C123/p2000");
    expect(f.writes).toHaveLength(1);
  } finally {
    await restarted.close();
  }
});

test("stale or prompt-pending source ownership queues without calling native steer", async () => {
  for (const pending of [false, true]) {
    const f = fixture();
    if (pending) {
      f.gateway.accept(event());
      const owner = f.next();
      f.store.running(owner.id, owner.text);
      f.gateway.accept(f.follow());
    } else {
      const owner = f.start();
      f.gateway.accept(f.follow());
      f.store.respond(owner.id, ["Already finished"]);
    }
    await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
    expect(f.writes).toEqual([]);
    expect(f.store.queueCounts(f.gateway.key).queued).toBe(1);
  }
});

test("writing receipt recovery reads evidence only, without resubmitting or queueing", async () => {
  const f = fixture();
  f.start();
  f.gateway.accept(f.follow());
  const receipt = f.store.followUps(f.gateway.key)[0];
  if (!receipt) throw new Error("Missing receipt");
  expect(f.store.claimFollowUp(receipt)).toBe(true);
  let reads = 0;
  f.backend.reconcileSteer = async () => {
    reads++;
    return { status: "accepted" };
  };
  await f.gateway.pollFollowUps(AbortSignal.timeout(1000));
  expect(reads).toBe(1);
  expect(f.writes).toEqual([]);
  expect(f.reactions).toEqual(["2.000"]);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(0);
});

test("accepted-event receipt and deterministic native identity survive SQLite reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "stargate-followup-"));
  const path = join(directory, "store.sqlite");
  let store = openStore(path);
  try {
    const input = {
      botKey: "bot",
      eventId: "C123:1.000",
      conversation: "thread",
      channel: "C123",
      thread: "1.000",
      user: "U123",
      text: "Original",
    };
    store.enqueue(input);
    const owner = store.ready("bot", Date.now(), 1)[0];
    if (!owner) throw new Error("Missing owner");
    store.running(owner.id);
    store.saveInput("bot", owner.id, "msg_original");
    const followup = { ...input, eventId: "C123:2.000", text: "Revised scope" };
    expect(store.admitFollowUp(followup, "ses_captain")).toBe(true);
    const receipt = store.followUps("bot")[0];
    if (!receipt) throw new Error("Missing receipt");
    store.claimFollowUp(receipt);
    store.close();
    store = openStore(path);
    expect(store.admitFollowUp(followup, "ses_captain")).toBe(false);
    expect(store.followUps("bot")[0]).toMatchObject({
      nativeID: receipt.nativeID,
      inputID: "msg_original",
      state: "writing",
    });
    expect(store.enqueue(followup)).toBe(false);
    expect(store.queueCounts("bot").queued).toBe(0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
