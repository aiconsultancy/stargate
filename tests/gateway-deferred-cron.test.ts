import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  type AgentBackend,
  latestInput,
  type PromptSourceContext,
  TranscriptUnavailable,
} from "../src/backend";
import { Gateway, type SlackDelivery } from "../src/gateway/gateway";
import { failureText } from "../src/shared/request-failure";
import { Store } from "../src/gateway/store";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture(path = ":memory:", pinned = false) {
  let store = new Store(path);
  cleanup.push(() => store.close());
  const config = bot();
  config.threadContext = true;
  config.waiting.delayMs = 0;
  const calls: string[] = [];
  const posts: { channel: string; thread: string; text: string }[] = [];
  const slack: SlackDelivery = {
    async post(channel, thread, text) {
      calls.push("post");
      posts.push({ channel, thread, text });
      return "10.000";
    },
    async update() {
      calls.push("update");
      return true;
    },
    async remove() {
      calls.push("remove");
    },
    async react() {
      calls.push("react");
    },
    async failure() {
      calls.push("failure");
      return "10.000";
    },
    async activity() {
      calls.push("activity");
      return "10.000";
    },
    async threadContext() {
      calls.push("threadContext");
      return { messages: [], truncated: false };
    },
    files: {
      async download() {
        calls.push("download");
        return [];
      },
      async reserveUpload() {
        calls.push("reserveUpload");
        return { fileID: "F123", url: "https://example.invalid/upload" };
      },
      async putUpload() {
        calls.push("putUpload");
      },
      async completeUpload() {
        calls.push("completeUpload");
      },
      async sharedIn() {
        calls.push("sharedIn");
        return true;
      },
    },
  };
  const prompts: { text: string; context?: PromptSourceContext }[] = [];
  let sessions = 0;
  const backend: AgentBackend = {
    ...(pinned ? { sessionID: "captain" } : {}),
    async createSession() {
      return pinned ? "captain" : `session-${++sessions}`;
    },
    async prompt(_session, text, _signal, onText, _onInput, _files, context) {
      prompts.push({ text, ...(context ? { context } : {}) });
      onText?.("[[stargate:react:eyes]]\nPublic preview");
      return "[[stargate:react:eyes]]\nPublic result\n![private file](file:///private/report.txt)";
    },
    async close() {},
  };
  const createGateway = () =>
    new Gateway(
      config,
      identity,
      store,
      backend,
      slack,
      pino({ enabled: false }),
    );
  let gateway = createGateway();
  cleanup.push(() => gateway.close());
  const signal = new AbortController().signal;
  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("Expected a job");
    return job;
  };
  const enqueue = (runId = "daily-1", deferDelivery = true) => {
    const id = gateway.enqueueScheduled({
      runId,
      channel: "C123",
      thread: deferDelivery ? "" : "1.000",
      user: "U123",
      prompt: "PRIVATE PROMPT",
      name: "Daily",
      deferDelivery,
    });
    if (id === undefined) throw new Error("Scheduled job rejected");
    return id;
  };
  return {
    get store() {
      return store;
    },
    get gateway() {
      return gateway;
    },
    backend,
    config,
    calls,
    posts,
    prompts,
    signal,
    next,
    enqueue,
    async drain() {
      while (store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1).length)
        await gateway.process(next(), signal);
    },
    async restart() {
      await gateway.close();
      store.close();
      store = new Store(path);
      gateway = createGateway();
    },
  };
}

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "stargate-deferred-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "stargate.sqlite");
}

test("deferred cron executes durably without any Slack call and survives restart", async () => {
  const f = fixture(await databasePath(), true);
  const id = f.enqueue();
  expect(f.enqueue()).toBe(id);
  expect(f.gateway.scheduledResult(id)).toEqual({
    text: "",
    status: "queued",
    failure: null,
  });
  await f.drain();
  const result = f.gateway.scheduledResult(id);
  expect(result).toMatchObject({ status: "done", failure: null });
  expect(result?.text).toContain("Public result");
  expect(result?.text).not.toContain("stargate:react");
  expect(result?.text).not.toContain("/private/report.txt");
  expect(result?.text).not.toContain("PRIVATE PROMPT");
  expect(f.calls).toEqual([]);
  expect(f.prompts).toEqual([{ text: "PRIVATE PROMPT" }]);
  await f.restart();
  await f.drain();
  expect(f.gateway.scheduledResult(id)).toEqual(result);
  expect(f.enqueue()).toBe(id);
  expect(f.prompts).toHaveLength(1);
  expect(f.calls).toEqual([]);
});

test("deferred cron failures expose only safe persisted status without Slack", async () => {
  const f = fixture(await databasePath());
  f.backend.prompt = async () => {
    throw new Error("SECRET RAW BACKEND ERROR");
  };
  const id = f.enqueue();
  await f.drain();
  expect(f.gateway.scheduledResult(id)).toEqual({
    status: "done",
    failure: "backend",
    text: failureText("backend"),
  });
  await f.restart();
  expect(f.gateway.scheduledResult(id)?.failure).toBe("backend");
  expect(f.calls).toEqual([]);
});

test("deferred cron uses run identity, isolates conversations and keeps policy guards", () => {
  const f = fixture();
  const first = f.enqueue("run-1");
  const second = f.enqueue("run-2");
  expect(first).not.toBe(second);
  const jobs = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10);
  expect(jobs).toHaveLength(2);
  expect(jobs[0]?.conversation).not.toBe(jobs[1]?.conversation);
  expect(jobs.every((job) => job.thread === "" && job.deferDelivery)).toBe(
    true,
  );
  expect(f.gateway.scheduledResult(99999)).toBeUndefined();
  const other = new Gateway(
    { ...f.config, id: "other" },
    identity,
    f.store,
    f.backend,
    { async post() {} },
    pino({ enabled: false }),
  );
  cleanup.push(() => other.close());
  expect(other.scheduledResult(first)).toBeUndefined();
  f.config.access.deniedUsers = ["U123"];
  expect(
    f.gateway.enqueueScheduled({
      runId: "denied",
      channel: "C123",
      thread: "",
      user: "U123",
      prompt: "denied",
      name: "Denied",
      deferDelivery: true,
    }),
  ).toBeUndefined();
});

test("immediate scheduled execution still delivers to its real Slack root", async () => {
  const f = fixture();
  f.config.waiting.delayMs = null;
  f.backend.prompt = async () => "Immediate result";
  const id = f.enqueue("immediate", false);
  await f.drain();
  expect(f.posts).toEqual([
    { channel: "C123", thread: "1.000", text: "Immediate result" },
  ]);
  expect(f.gateway.scheduledStatus(id)).toBe("done");
});

test("omitting deferDelivery preserves the immediate scheduled default", async () => {
  const f = fixture();
  f.backend.prompt = async () => "Default immediate result";
  f.gateway.enqueueScheduled({
    runId: "default",
    channel: "C123",
    thread: "3.000",
    user: "U123",
    prompt: "Default scheduled instruction",
    name: "Default",
  });
  expect(f.next().deferDelivery).toBe(false);
  await f.drain();
  expect(f.posts).toEqual([
    { channel: "C123", thread: "3.000", text: "Default immediate result" },
  ]);
});

test("revoked access blocks a queued deferred execution without Slack", async () => {
  const f = fixture();
  const id = f.enqueue();
  f.config.access.deniedChannels = ["C123"];
  await f.drain();
  expect(f.gateway.scheduledResult(id)).toEqual({
    status: "failed",
    text: "",
    failure: null,
  });
  expect(f.prompts).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("deferred native inputs retain the captain execution lock", () => {
  const f = fixture(":memory:", true);
  const first = f.enqueue("run-1");
  f.enqueue("run-2");
  const ready = () =>
    f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10, true);
  expect(ready().map((job) => job.id)).toEqual([first]);
  f.store.running(first);
  expect(ready()).toEqual([]);
});

test("restart finishes interrupted deferred work locally without replay", async () => {
  const f = fixture(await databasePath(), true);
  const id = f.enqueue();
  f.store.running(id);
  f.store.captainCursor(f.gateway.key, "captain");
  f.store.saveInput(f.gateway.key, id, "allocated-input", "captain");
  await f.restart();
  f.store.recover(f.gateway.key);
  await f.drain();
  expect(f.gateway.scheduledResult(id)).toEqual({
    status: "done",
    failure: "interrupted",
    text: failureText("interrupted"),
  });
  expect(f.prompts).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("scheduled result is bounded and reads no prompt or attachment metadata", async () => {
  const f = fixture();
  f.backend.prompt = async () => "x".repeat(20_000);
  const id = f.enqueue();
  await f.drain();
  expect(f.gateway.scheduledResult(id)?.text).toHaveLength(12_000);
  expect(f.calls).toEqual([]);
});

function nativeHistory(f: ReturnType<typeof fixture>) {
  const history: {
    id: string;
    kind: "input" | "assistant" | "hidden";
    text: string;
    input?: string;
  }[] = [];
  let latest: string | undefined;
  const add = (
    kind: (typeof history)[number]["kind"],
    text: string,
    input?: string,
  ) => {
    const id = `native-${history.length + 1}`;
    history.push({ id, kind, text, ...(input ? { input } : {}) });
    return id;
  };
  f.backend.prompt = async (_session, text, _signal, onText, onInput) => {
    f.prompts.push({ text });
    latest = `native-${history.length + 1}`;
    onInput?.(latest);
    add("input", text);
    add("hidden", "SECRET REASONING AND TOOL OUTPUT");
    const answer = `answer: ${text}`;
    add("assistant", answer, latest);
    onText?.(answer);
    return answer;
  };
  f.backend.transcript = async (_session, after) => {
    const cursor = after === latestInput ? latest : after;
    const index =
      cursor === "" ? -1 : history.findIndex((row) => row.id === cursor);
    if (cursor !== undefined && cursor !== "" && index < 0)
      throw new TranscriptUnavailable("cursor");
    const rows = cursor === undefined ? [] : history.slice(index + 1);
    const input = rows.findLast((row) => row.kind === "input")?.id;
    return {
      cursor: history.at(-1)?.id ?? "",
      entries: rows.flatMap((row) =>
        row.kind === "assistant"
          ? [
              {
                id: row.id,
                text: row.text,
                created: 1,
                ...(row.input ? { input: row.input } : {}),
              },
            ]
          : [],
      ),
      ...(input ? { input } : {}),
    };
  };
  return {
    add,
    get latest() {
      return latest;
    },
  };
}

for (const pinned of [false, true]) {
  test(`late deferred transcript remains local after restart, pinned=${pinned}`, async () => {
    const f = fixture(await databasePath(), pinned);
    f.config.waiting.delayMs = null;
    const history = nativeHistory(f);
    const id = f.enqueue();
    const conversation = f.next().conversation;
    await f.drain();
    const origin = history.latest;
    expect(f.calls).toEqual([]);
    await f.restart();
    if (pinned) {
      expect(
        f.gateway.accept(event("<@UBOT> immediate question", "2.000")),
      ).toBe(true);
      await f.drain();
    }
    history.add(
      "assistant",
      "[[stargate:react:eyes]]\nLate deferred result",
      origin,
    );
    f.gateway.settle(pinned ? "captain" : "session-1");
    await f.gateway.catchUp(f.signal);
    await f.drain();
    const result = f.gateway.scheduledResult(id);
    expect(result?.text).toContain("answer: PRIVATE PROMPT");
    expect(result?.text).toContain("Late deferred result");
    expect(result?.text).not.toContain("SECRET REASONING");
    expect(result?.text).not.toContain("immediate question");
    expect(result?.text).not.toContain("stargate:react");
    expect(
      f.store
        .transcriptRows(f.gateway.key, conversation)
        .every((row) => row.status === "done"),
    ).toBe(true);
    expect(f.posts.every((post) => post.thread === "2.000")).toBe(true);
    expect(f.posts.map((post) => post.text).join("\n")).not.toContain(
      "Late deferred result",
    );
    if (!pinned) expect(f.calls).toEqual([]);
    const before = result;
    f.gateway.settle();
    await f.gateway.catchUp(f.signal);
    await f.drain();
    expect(f.gateway.scheduledResult(id)).toEqual(before);
    await f.restart();
    expect(f.gateway.scheduledResult(id)).toEqual(before);
    expect(f.prompts).toHaveLength(pinned ? 2 : 1);
  });
}

test("deferred activity cannot start or resume and grants no maintenance permit", async () => {
  const f = fixture(await databasePath(), true);
  nativeHistory(f);
  f.config.crewActivity.detail = "summary";
  const started: string[] = [];
  f.backend.startMaintenance = async () => {
    started.push("maintenance");
    return {
      async read() {
        return {
          id: "notice",
          plan: "Plan",
          impact: "Impact",
          rollback: "Rollback",
        };
      },
      async delivered() {
        started.push("maintenance-permit");
      },
      async close() {},
    };
  };
  f.backend.startActivity = async () => {
    started.push("activity");
    throw new Error("Unexpected deferred activity");
  };
  f.backend.resumeActivity = () => {
    started.push("resumeActivity");
    throw new Error("Unexpected deferred activity resume");
  };
  const id = f.enqueue();
  f.store.saveActivity(id, {
    capture: "legacy-capture",
    revision: 0,
    done: false,
  });
  await f.drain();
  await f.restart();
  f.gateway.settle();
  await f.gateway.catchUp(f.signal);
  await f.drain();
  expect(started).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("late deferred completion found during an immediate turn cannot leak", async () => {
  const f = fixture(":memory:", true);
  const history = nativeHistory(f);
  const id = f.enqueue();
  await f.drain();
  const origin = history.latest;
  const prompt = f.backend.prompt;
  f.backend.prompt = async (...args) => {
    const result = await prompt(...args);
    history.add("assistant", "PRIVATE DEFERRED CONTINUATION", origin);
    return result;
  };
  f.gateway.accept(event("<@UBOT> immediate question", "2.000"));
  await f.drain();
  expect(f.gateway.scheduledResult(id)?.text).toContain(
    "PRIVATE DEFERRED CONTINUATION",
  );
  expect(f.posts.map((post) => post.text).join("\n")).not.toContain(
    "PRIVATE DEFERRED CONTINUATION",
  );
  expect(f.posts.every((post) => post.thread === "2.000")).toBe(true);
});

test("unreadable deferred history catches up locally without promising a Slack thread", async () => {
  const f = fixture(":memory:", true);
  nativeHistory(f);
  const prompt = f.backend.prompt;
  const transcript = f.backend.transcript;
  if (!transcript) throw new Error("Expected transcript");
  let readable = true;
  f.backend.prompt = async (...args) => {
    const result = await prompt(...args);
    readable = false;
    return result;
  };
  f.backend.transcript = (...args) => {
    if (!readable) throw new TranscriptUnavailable("cursor");
    return transcript(...args);
  };
  const id = f.enqueue();
  await f.drain();
  expect(f.gateway.scheduledResult(id)?.failure).toBe("history");
  expect(f.gateway.scheduledResult(id)?.text).not.toContain("this thread");
  readable = true;
  f.gateway.settle();
  await f.gateway.catchUp(f.signal);
  await f.drain();
  expect(f.gateway.scheduledResult(id)?.text).toContain(
    "answer: PRIVATE PROMPT",
  );
  expect(f.calls).toEqual([]);
  expect(f.prompts).toHaveLength(1);
});

test("legacy jobs migrate additively with immediate delivery as default", async () => {
  const path = await databasePath();
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventId TEXT NOT NULL,botKey TEXT NOT NULL,conversation TEXT NOT NULL,
    channel TEXT NOT NULL,thread TEXT NOT NULL,user TEXT NOT NULL,text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',response TEXT,sent INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(botKey,eventId)
  );
  INSERT INTO jobs (eventId,botKey,conversation,channel,thread,user,text)
  VALUES ('C123:1.000','bot','conversation','C123','1.000','U123','legacy');`);
  legacy.close();
  const store = new Store(path);
  cleanup.push(() => store.close());
  const job = store.ready("bot", Number.MAX_SAFE_INTEGER, 1)[0];
  expect(job).toMatchObject({
    text: "legacy",
    status: "queued",
    deferDelivery: false,
  });
});
