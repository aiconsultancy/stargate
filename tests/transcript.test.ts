import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  type AgentBackend,
  latestInput,
  type TextSink,
  type Transcript,
  TranscriptUnavailable,
} from "../src/backends/backend";
import { cancellationNotice } from "../src/gateway/cancellation";
import type { BotConfig } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import type { RequestFailure } from "../src/shared/request-failure";
import { conversationKey } from "../src/gateway/routing";
import { prepareSlackReply } from "../src/shared/slack-format";
import { openStore } from "../src/app/open-store";
import { type Job, type Store } from "../src/gateway/store";
import { repairTranscript } from "../src/ops/transcript";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

type Message = { id: string; text: string | undefined; settled: boolean };

/** Native session model: chronological messages with settled state. */
function nativeSession() {
  const log: Message[] = [];
  const reads: (string | undefined)[] = [];
  let next = 0;

  return {
    log,
    reads,
    /** Latest submitted input, as the OpenCode adapter records it. */
    input: undefined as string | undefined,
    /** Runs before each read; throw to model unreadable history. */
    beforeRead: () => {},
    add(text?: string, settled = true) {
      const id = `msg_${String(++next).padStart(4, "0")}`;
      log.push({ id, text, settled });

      return id;
    },
    async transcript(cursor: string | undefined): Promise<Transcript> {
      reads.push(cursor);
      this.beforeRead();

      if (cursor === latestInput && !this.input) {
        throw new TranscriptUnavailable("cursor");
      }

      const after = cursor === latestInput ? this.input : cursor;
      const open = log.findIndex((message) => !message.settled);
      const done = open < 0 ? log : log.slice(0, open);
      const head = done.at(-1)?.id ?? "";

      if (after === undefined) {
        return { cursor: head, entries: [] };
      }

      const start =
        after === "" ? 0 : done.findIndex((m) => m.id === after) + 1;

      if (after !== "" && start === 0) {
        throw new TranscriptUnavailable("cursor");
      }

      const newer = done.slice(start);

      return {
        ...(open < 0 ? {} : { pending: true }),
        cursor: newer.at(-1)?.id ?? after,
        entries: newer.flatMap((message, index) =>
          message.text
            ? [
                {
                  id: message.id,
                  text: message.text,
                  created: Date.UTC(2026, 10, 8, 3, start + index),
                },
              ]
            : [],
        ),
      };
    },
  };
}

type Turn = (signal: AbortSignal, onText?: TextSink) => Promise<string>;

function fixture(
  options: {
    store?: Store;
    config?: BotConfig;
    native?: ReturnType<typeof nativeSession>;
    session?: string;
  } = {},
) {
  const store = options.store ?? openStore(":memory:");

  if (!options.store) {
    cleanup.push(() => store.close());
  }

  const native = options.native ?? nativeSession();
  const prompts: string[] = [];
  let turn: Turn = async () => "";

  const backend: AgentBackend = {
    async createSession() {
      return options.session ?? "session-1";
    },
    async prompt(_session, text, signal, onText) {
      prompts.push(text);
      native.input = native.add(); // Submitted user input, not assistant text.

      return turn(signal, onText);
    },
    transcript: (_session, after) => native.transcript(after),
    async close() {},
  };

  const posts: { channel: string; thread: string; text: string }[] = [];
  const updates: string[] = [];
  const failures: RequestFailure[] = [];

  const slack: TransportDelivery = {
    async post(channel, thread, text) {
      posts.push({ channel, thread, text });

      return `${posts.length + 100}.000`;
    },
    async update(_channel, _ts, text) {
      updates.push(text);
    },
    async remove() {},
    async failure(_channel, _thread, cause) {
      failures.push(cause);

      return "status";
    },
  };

  const config = options.config ?? bot();

  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
  );

  cleanup.push(() => gateway.close());
  const signal = new AbortController().signal;
  const next = () => store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];

  const drain = async () => {
    for (let job = next(); job; job = next()) {
      await gateway.process(job, signal);
    }
  };

  return {
    store,
    native,
    prompts,
    posts,
    updates,
    failures,
    slack,
    backend,
    gateway,
    signal,
    next,
    drain,
    texts: () => posts.map((post) => post.text),
    setTurn(next: Turn) {
      turn = next;
    },
    async settle(session?: string) {
      gateway.settle(session);
      await gateway.catchUp(signal);
      await drain();
    },
  };
}

const followUp = (text: string, ts: string) => ({
  ...event(),
  event: { ...event(text, ts).event, type: "message", thread_ts: "1.000" },
});

function pending(f: { next(): Job | undefined }) {
  const job = f.next();

  if (!job) {
    throw new Error("Missing job");
  }

  return job;
}

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

test("a turn delivers every public reply since the last delivery, not only the last", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("Compile failure found; fixes in place.");
    f.native.add(); // Tool-only step.
    f.native.add("Pushed 79233; 40 tests pass.");
    f.native.add(); // Empty final step.

    return "Pushed 79233; 40 tests pass.";
  });
  f.gateway.accept(event());
  await f.drain();
  expect(f.texts()).toEqual([
    "Compile failure found; fixes in place.\n\nPushed 79233; 40 tests pass.",
  ]);
  await f.settle("session-1");
  expect(f.posts).toHaveLength(1);
  expect(f.prompts).toHaveLength(1);
});

test("continuations after a turn reach the exact thread once, in order", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("Queued CI.");

    return "Queued CI.";
  });
  f.gateway.accept(event());
  await f.drain();
  // Background shell completion resumes the session after the turn returned.
  f.native.add(); // Synthetic notification.
  f.native.add("CI found 4 stale assertions.");
  f.native.add("Pushed 229; 26 tests passed.");
  f.native.add("Still streaming", false);
  await f.settle("session-1");
  await f.settle("session-1");
  expect(f.posts.slice(1)).toEqual([
    {
      channel: "C123",
      thread: "1.000",
      text: "CI found 4 stale assertions.\n\nPushed 229; 26 tests passed.",
    },
  ]);
  const streaming = f.native.log.at(-1);

  if (streaming) {
    streaming.settled = true;
  }

  f.native.add(); // Tool-only continuation advances without a reply.
  await f.settle("unrelated-worker-session");
  expect(f.posts).toHaveLength(2);
  await f.settle("session-1");
  f.native.add();
  await f.settle("session-1");
  expect(f.texts().slice(2)).toEqual(["Still streaming"]);
  expect(f.prompts).toHaveLength(1);
});

test("settle events never cross bot namespaces that share a native session", async () => {
  const store = openStore(":memory:");
  cleanup.push(() => store.close());
  const a = fixture({ store });
  const b = fixture({ store, config: bot("other") });

  for (const f of [a, b]) {
    f.setTurn(async () => "");
    f.gateway.accept(event());
    await f.drain();
  }

  a.native.add("Only for bot A.");
  b.native.add("Only for bot B.");
  a.gateway.settle("session-1");
  await a.gateway.catchUp(a.signal);
  expect(b.next()).toBeUndefined();
  await a.drain();
  expect(a.texts().at(-1)).toBe("Only for bot A.");
  expect(b.texts()).toHaveLength(1);
});

test("failures keep public text that settled first, then one status box", async () => {
  for (const cause of ["timeout", "backend"] as const) {
    const config = bot();

    if (cause === "timeout") {
      config.turnTimeoutMs = 20;
    }

    const f = fixture({ config });
    f.setTurn(async (signal) => {
      f.native.add("Progress before the failure.");

      if (cause === "backend") {
        throw new Error("PRIVATE SDK error");
      }

      return aborted(signal);
    });
    f.gateway.accept(event());
    await f.drain();
    expect(f.texts()).toEqual(["Progress before the failure."]);
    expect(f.failures).toEqual([cause]);
    // Late completion after the timeout is surfaced, never executed again.
    f.native.add("Finished after the limit.");
    await f.settle("session-1");
    expect(f.texts()).toEqual([
      "Progress before the failure.",
      "Finished after the limit.",
    ]);
    expect(f.prompts).toHaveLength(1);
  }
});

test("Stop keeps settled public text and later results without rerunning", async () => {
  const f = fixture();
  f.setTurn(async (signal, onText) => {
    f.native.add("Interrupted public text.");
    onText?.("Interrupted public text.");

    return aborted(signal);
  });
  f.gateway.accept(event());
  const job = pending(f);
  const work = f.gateway.process(job, f.signal);

  while (!f.store.previews(job.id).length) {
    await Bun.sleep(1);
  }

  const ts = f.store.previews(job.id)[0]?.ts;
  expect(
    f.gateway.cancel({
      type: "block_actions",
      api_app_id: "A123",
      team: { id: "T123" },
      user: { id: "U123" },
      channel: { id: "C123" },
      container: { type: "message", channel_id: "C123", message_ts: ts },
      message: { user: "UBOT", ts, thread_ts: "1.000" },
      actions: [
        { type: "button", action_id: "stargate_stop", value: String(job.id) },
      ],
    }),
  ).toBe(true);
  await work;
  expect(f.store.transcript.replies(f.gateway.key, job.conversation)).toEqual([
    ["Interrupted public text.", cancellationNotice],
  ]);
  expect(f.failures).toEqual(["cancelled"]);
  f.native.add("Late result after Stop.");
  await f.settle("session-1");
  expect(f.texts().at(-1)).toBe("Late result after Stop.");
  expect(f.prompts).toHaveLength(1);
});

test("restart resumes from the durable cursor without reposting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-transcript-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stargate.sqlite");
  const native = nativeSession();
  const store = openStore(path);
  const first = fixture({ store, native });
  first.setTurn(async () => {
    native.add("Started the build.");

    return "Started the build.";
  });
  first.gateway.accept(event());
  await first.drain();
  await first.gateway.close();
  store.close();
  native.add("Build finished while Stargate was stopped.");
  const reopened = openStore(path);
  cleanup.push(() => reopened.close());
  const second = fixture({ store: reopened, native });
  await second.settle(); // Event stream (re)connected.
  expect(second.texts()).toEqual([
    "Build finished while Stargate was stopped.",
  ]);
  await second.settle();
  expect(second.posts).toHaveLength(1);
  expect(first.prompts.length + second.prompts.length).toBe(1);
});

test("upgrade baselines existing threads without backfill, then follows them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-transcript-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stargate.sqlite");
  const legacy = openStore(path);
  const f = fixture({ store: legacy });
  f.gateway.accept(event());
  const job = pending(f);
  legacy.saveSession(job.conversation, "session-1");
  legacy.running(job.id);
  legacy.respond(job.id, ["Old answer"]);
  legacy.finish(job.id);
  legacy.close();
  // Recreate the pre-feature schema without discarding rows.
  const db = new Database(path);
  db.exec("ALTER TABLE sessions DROP COLUMN cursor");
  db.close();
  const store = openStore(path);
  cleanup.push(() => store.close());
  const native = nativeSession();
  native.add("Old answer");
  native.add("Old continuation already handled manually.");
  const g = fixture({ store, native });
  await g.settle(); // Startup queues every mapping; NULL cursors only baseline.
  await g.settle("session-1");
  expect(g.posts).toEqual([]);
  native.add("New continuation after upgrade.");
  await g.settle("session-1");
  expect(g.texts()).toEqual(["New continuation after upgrade."]);
});

test("a pending turn absorbs earlier continuations so chronology holds", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("First answer.");

    return "First answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  f.native.add("Continuation before the next message.");
  f.gateway.accept(followUp("next", "2.000"));
  f.gateway.settle("session-1");
  await f.gateway.catchUp(f.signal);
  f.setTurn(async () => {
    f.native.add("Second answer.");

    return "Second answer.";
  });
  await f.drain();
  await f.settle("session-1");
  expect(f.texts()).toEqual([
    "First answer.",
    "Continuation before the next message.\n\nSecond answer.",
  ]);
});

test("passive delivery retries reuse stored chunks without rereading or rerunning", async () => {
  const f = fixture();
  f.setTurn(async () => "");
  f.gateway.accept(event());
  await f.drain();
  f.native.add("x".repeat(3000));
  f.gateway.settle("session-1");
  await f.gateway.catchUp(f.signal);
  const reads = f.native.reads.length;
  let fail = true;
  const post = f.slack.post;
  f.slack.post = async (channel, thread, text) => {
    if (fail && f.posts.length === 2) {
      throw new Error("Slack unavailable");
    }

    await post(channel, thread, text);
  };

  await f.gateway.process(pending(f), f.signal);
  fail = false;
  await f.gateway.process(pending(f), f.signal);
  expect(
    f
      .texts()
      .slice(1)
      .map((text) => text.length),
  ).toEqual([2800, 200]);
  expect(f.native.reads.length).toBe(reads);
  expect(f.prompts).toHaveLength(1);
});

test("the work loop turns watch notifications into thread delivery", async () => {
  const f = fixture();
  f.setTurn(async () => "");
  f.gateway.accept(event());
  await f.drain();
  f.native.add("Delivered by the watcher.");
  const delivered = Promise.withResolvers<void>();
  f.backend.watch = async (onSettled, signal) => {
    onSettled("session-1");
    await aborted(signal).catch(() => {});
  };

  f.slack.post = async (channel, thread, text) => {
    f.posts.push({ channel, thread, text });
    delivered.resolve();
  };

  const controller = new AbortController();
  const work = f.gateway.work(controller.signal);
  await delivered.promise;
  controller.abort();
  await work;
  expect(f.texts().at(-1)).toBe("Delivered by the watcher.");
});

test("repair queues only missing public replies of the exact thread, once", async () => {
  const f = fixture();
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");
  const answers = ["Report answer.", "Health answer."];

  for (const [index, answer] of answers.entries()) {
    f.setTurn(async () => {
      f.native.add(answer);

      return answer;
    });
    f.gateway.accept(index ? followUp("health", "2.000") : event());
    await f.drain();
  }

  // The Drive turn timed out; manual recovery stored only the latest answer.
  f.setTurn(async () => "");
  f.gateway.accept(followUp("drive", "3.000"));
  const drive = pending(f);
  f.store.running(drive.id);
  const since = f.native.add();
  const progress = f.native.add("PR 4036 compile failure; fixes in place.");
  f.native.add("Pushed 79233; 40 tests, 13 checks; CI queued.");
  const ci = f.native.add("CI: 4 stale assertions.");
  const pushed = f.native.add("Pushed 229; 26 tests passed.");
  const merged = f.native.add("Merged PR 4036 → 147494ff5d.");
  f.store.respond(drive.id, ["Pushed 79233; 40 tests, 13 checks; CI queued."]);
  await f.drain();
  // Another mapped thread must not be backfilled by this repair.
  const otherNative = nativeSession();
  otherNative.add("Other thread history.");

  const other = fixture({
    store: f.store,
    native: otherNative,
    session: "session-2",
  });

  other.gateway.accept(event("<@UBOT> other", "9.000"));
  await other.drain();

  const input = {
    store: f.store,
    backend: f.backend,
    botKey: f.gateway.key,
    channel: "C123",
    thread: "1.000",
    since,
  };

  const dry = await repairTranscript(input);
  expect(dry.missing.map((entry) => entry.id)).toEqual([
    progress,
    ci,
    pushed,
    merged,
  ]);
  expect(dry.delivered).toHaveLength(1);
  expect(dry.queued).toBe(0);
  expect(f.next()).toBeUndefined();
  await expect(repairTranscript({ ...input, limit: 3 })).rejects.toThrow(
    "limit",
  );
  await expect(
    repairTranscript({ ...input, since: "msg_gone" }),
  ).rejects.toThrow("since");
  await expect(repairTranscript({ ...input, thread: "8.000" })).rejects.toThrow(
    "No mapped",
  );
  const applied = await repairTranscript({ ...input, apply: true });
  expect(applied.queued).toBe(4);
  const before = f.posts.length;
  await f.drain();
  const repaired = f.texts().slice(before);
  expect(repaired).toHaveLength(4);
  expect(repaired[0]).toStartWith(
    "_Delayed update, originally written 2026-11-08 03:",
  );
  expect(repaired[0]).toEndWith("PR 4036 compile failure; fixes in place.");
  expect(repaired[3]).toEndWith("Merged PR 4036 → 147494ff5d.");
  expect(f.posts.slice(before).every((post) => post.thread === "1.000")).toBe(
    true,
  );
  const again = await repairTranscript({ ...input, apply: true });
  expect(again).toMatchObject({ missing: [], queued: 0 });
  await f.settle("session-1");
  expect(f.texts().slice(before)).toHaveLength(4);
  expect(other.texts()).toHaveLength(1);
  expect(
    f.store.transcript.transcriptTarget(f.gateway.key, conversation)?.cursor,
  ).toBe(merged);
});

test("catch-up failures retry with bounded backoff and keep the cursor", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("Queued CI.");

    return "Queued CI.";
  });
  f.gateway.accept(event());
  await f.drain();
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");

  const cursor = () =>
    f.store.transcript.transcriptTarget(f.gateway.key, conversation)?.cursor;

  const before = cursor();
  f.native.add("CI passed after an outage.");
  let failures = 12;
  f.native.beforeRead = () => {
    if (failures-- > 0) {
      throw new Error("history unavailable");
    }
  };

  const start = Date.now();

  try {
    setSystemTime(new Date(start));
    f.gateway.settle("session-1"); // The only event; retries need no other.
    await f.gateway.catchUp(f.signal);
    const reads = f.native.reads.length;
    await f.gateway.catchUp(f.signal);
    expect(f.native.reads.length).toBe(reads); // Backoff, not a hot loop.

    for (let attempt = 1; attempt <= 12; attempt++) {
      // Each wait is at most the five-minute ceiling.
      setSystemTime(new Date(start + attempt * 300_001));
      await f.gateway.catchUp(f.signal);

      if (attempt < 12) {
        expect(cursor()).toBe(before);
      }
    }
  } finally {
    setSystemTime();
  }

  await f.drain();
  expect(f.texts()).toEqual(["Queued CI.", "CI passed after an outage."]);
  expect(f.prompts).toHaveLength(1);
});

test("an unreadable final history defers the reply instead of an unreceipted copy", async () => {
  const f = fixture();
  let broken = false;
  f.native.beforeRead = () => {
    if (broken) {
      throw new Error("history unavailable");
    }
  };

  f.setTurn(async () => {
    f.native.add("Authoritative answer.");
    broken = true;

    return "Authoritative answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  expect(f.texts()).toEqual([]);
  expect(f.failures).toEqual(["history"]);
  broken = false;
  await f.gateway.catchUp(f.signal); // Scheduled by the turn, not an event.
  await f.drain();
  await f.settle("session-1");
  expect(f.texts()).toEqual(["Authoritative answer."]);
  expect(f.prompts).toHaveLength(1);
});

test("an unsettled final message is read again, never duplicated by a fallback", async () => {
  const f = fixture();
  let reads = 0;
  f.native.beforeRead = () => {
    if (++reads === 2) {
      for (const message of f.native.log) {
        message.settled = true;
      }
    }
  };

  f.setTurn(async () => {
    f.native.add("Final answer.", false);

    return "Final answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  expect(f.texts()).toEqual(["Final answer."]);
  // Still unsettled after every bounded read: defer, then deliver once.
  f.native.beforeRead = () => {};

  f.setTurn(async () => {
    f.native.add("Second final answer.", false);

    return "Second final answer.";
  });
  f.gateway.accept(followUp("next", "2.000"));
  await f.drain();
  expect(f.failures).toEqual(["history"]);
  expect(f.texts()).toEqual(["Final answer."]);

  for (const message of f.native.log) {
    message.settled = true;
  }

  await f.gateway.catchUp(f.signal);
  await f.drain();
  await f.settle("session-1");
  expect(f.texts()).toEqual(["Final answer.", "Second final answer."]);
  expect(f.prompts).toHaveLength(2);
});

test("reconnect catches up quiet threads of any age", async () => {
  const f = fixture();
  const now = Date.now();

  try {
    setSystemTime(new Date(now - 30 * 86_400_000));
    f.setTurn(async () => {
      f.native.add("Started a long job.");

      return "Started a long job.";
    });
    f.gateway.accept(event());
    await f.drain();
  } finally {
    setSystemTime();
  }

  f.native.add("Finished a month later.");
  await f.settle(); // Event stream (re)connected.
  expect(f.texts()).toEqual(["Started a long job.", "Finished a month later."]);
});

test("long transcript replies are delivered in full, never clipped", async () => {
  const f = fixture();
  const parts = [0, 1, 2].map((n) => `${"abcdefghi ".repeat(2500)}end-${n}`);
  f.setTurn(async () => {
    for (const text of parts) {
      f.native.add(text);
    }

    return parts.at(-1) ?? "";
  });
  f.gateway.accept(event());
  await f.drain();
  const single = `${"0123456789".repeat(7000)}tail`;
  f.native.add(single);
  await f.settle("session-1");
  const compact = (text: string) => text.replace(/\s+/g, "");
  const delivered = compact(f.texts().join(""));

  for (const text of [...parts, single]) {
    expect(delivered).toContain(compact(text));
  }

  expect(delivered).not.toContain("truncated");
  expect(f.texts().every((text) => Array.from(text).length <= 2800)).toBe(true);
});

test("a lost cursor stops catch-up, then the next request re-anchors at its own input", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("First answer.");

    return "First answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");
  const lost = f.store.transcript.transcriptCursor(conversation);
  f.native.log.pop(); // A revert removes the cursor message.
  f.native.add("Unplaceable continuation.");
  const start = Date.now();

  try {
    await f.settle("session-1");
    const reads = f.native.reads.length;
    setSystemTime(new Date(start + 3_600_000));
    await f.settle(); // Reconnect sweep and backoff time: no further probes.
    expect(f.native.reads.length).toBe(reads);
  } finally {
    setSystemTime();
  }

  expect(f.store.transcript.transcriptCursor(conversation)).toBe(lost);
  let written = false;
  f.native.beforeRead = () => {
    // Written after the streamed answer; a post-prompt head baseline skips it.
    if (written || !f.native.log.some((m) => m.text === "Second answer.")) {
      return;
    }

    written = true;
    f.native.add("Background reply after the answer.");
  };

  f.setTurn(async () => {
    f.native.add("Second answer.");

    return "Second answer.";
  });
  f.gateway.accept(followUp("next", "2.000"));
  await f.drain();
  const reply = f.texts().at(-1) ?? "";
  expect(reply).toStartWith(
    "_Stargate could not find its last delivered message",
  );
  expect(reply).toEndWith(
    "Second answer.\n\nBackground reply after the answer.",
  );
  expect(f.texts().join("\n")).not.toContain("Unplaceable");
  expect(f.failures).toEqual([]);
  f.native.add("Later continuation.");
  await f.settle("session-1");
  expect(f.texts().slice(1)).toEqual([reply, "Later continuation."]);
  expect(f.prompts).toHaveLength(2);
});

test("a failed legacy baseline anchors at the request input instead of skipping later replies", async () => {
  const f = fixture();
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");
  f.store.saveSession(conversation, "session-1"); // Pre-upgrade mapping.
  f.native.add("Old reply already in Slack.");
  let fail = true;
  f.native.beforeRead = () => {
    if (fail) {
      fail = false;
      throw new Error("history unavailable");
    }
  };

  f.setTurn(async () => {
    f.native.add("Legacy answer.");

    return "Legacy answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  f.native.add("Background after the legacy answer.");
  await f.settle("session-1");
  expect(f.texts()).toEqual([
    "Legacy answer.",
    "Background after the legacy answer.",
  ]);
});

test("an unsettled legacy reply shows delayed status after its input is anchored", async () => {
  const f = fixture();
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");
  f.store.saveSession(conversation, "session-1");
  f.native.add("Old reply already in Slack.");
  let fail = true;
  f.native.beforeRead = () => {
    if (!fail) {
      return;
    }

    fail = false;
    throw new Error("history unavailable");
  };

  f.setTurn(async () => {
    f.native.add("Legacy reply after settling.", false);

    return "Legacy reply after settling.";
  });
  f.gateway.accept(event());
  await f.drain();
  expect(f.texts()).toEqual([]);
  expect(f.failures).toEqual(["history"]);

  for (const message of f.native.log) {
    message.settled = true;
  }

  await f.gateway.catchUp(f.signal);
  await f.drain();
  await f.settle("session-1");
  expect(f.texts()).toEqual(["Legacy reply after settling."]);
  expect(f.prompts).toHaveLength(1);
});

test("a cursor moved by another writer rolls back the reply and defers instead of duplicating", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-transcript-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stargate.sqlite");
  const store = openStore(path);
  cleanup.push(() => store.close());
  const other = new Database(path);
  cleanup.push(() => other.close());
  const f = fixture({ store });
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");
  f.setTurn(async () => {
    const first = f.native.add("First part.");
    f.native.add("Second part.");
    // Another process already delivered the first part and moved the cursor.
    other
      .query("UPDATE sessions SET cursor=? WHERE conversation=?")
      .run(first, conversation);

    return "First part.\n\nSecond part.";
  });
  f.gateway.accept(event());
  await f.drain();
  expect(f.texts()).toEqual([]);
  expect(f.failures).toEqual(["history"]);
  await f.gateway.catchUp(f.signal);
  await f.drain();
  await f.settle("session-1");
  expect(f.texts()).toEqual(["Second part."]);
});

test("reactions come only from the current request, not earlier continuations", async () => {
  const f = fixture();
  const reactions: string[] = [];
  f.slack.react = async (_channel, _ts, name) => {
    reactions.push(name);
  };

  f.setTurn(async () => {
    f.native.add("First answer.");

    return "First answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  f.native.add("[[stargate:react:tada]]\nEarlier continuation.");
  f.setTurn(async () => {
    f.native.add("Current answer.");

    return "Current answer.";
  });
  f.gateway.accept(followUp("next", "2.000"));
  await f.drain();
  expect(reactions).toEqual([]);
  expect(f.texts().at(-1)).toBe("Earlier continuation.\n\nCurrent answer.");
  // A reaction-only current turn still reacts and posts nothing.
  f.setTurn(async () => {
    f.native.add("[[stargate:react:eyes]]");

    return "[[stargate:react:eyes]]";
  });
  f.gateway.accept(followUp("look", "3.000"));
  await f.drain();
  expect(reactions).toEqual(["eyes"]);
  expect(f.posts).toHaveLength(2);
});

test("a silent turn posts nothing, advances the cursor and is never replayed", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("First answer.");

    return "First answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  f.setTurn(async () => {
    f.native.add(); // Tool-only step.
    f.native.add("[[stargate:silent]]\nAddressed to another captain.");

    return "[[stargate:silent]]\nAddressed to another captain.";
  });
  f.gateway.accept(followUp("for someone else", "2.000"));
  await f.drain();
  expect(f.texts()).toEqual(["First answer."]);
  expect(f.failures).toEqual([]);
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");
  expect(f.store.transcript.transcriptCursor(conversation)).toBe(
    f.native.log.at(-1)?.id,
  );
  await f.settle("session-1");
  expect(f.posts).toHaveLength(1);
  // The next turn delivers its own text only.
  f.setTurn(async () => {
    f.native.add("Current answer.");

    return "Current answer.";
  });
  f.gateway.accept(followUp("next", "3.000"));
  await f.drain();
  expect(f.texts()).toEqual(["First answer.", "Current answer."]);
  expect(f.prompts).toHaveLength(3);
});

test("silence covers one assistant message; other public text of the turn is kept", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("Checked the thread.");
    f.native.add("[[stargate:silent]]\n![private](file:///tmp/private.txt)");

    return "Checked the thread.\n\n[[stargate:silent]]\n![private](file:///tmp/private.txt)";
  });
  f.gateway.accept(event());
  const job = pending(f);
  await f.gateway.process(job, f.signal);
  expect(f.texts()).toEqual(["Checked the thread."]);
  expect(f.store.attachmentRecords.attachments(job.id)).toEqual([]);
});

test("a silent background continuation and an unsettled follow-up cause no post or status", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("Queued CI.");

    return "Queued CI.";
  });
  f.gateway.accept(event());
  await f.drain();
  f.native.add(); // Synthetic notification.
  f.native.add("[[stargate:silent]]");
  await f.settle("session-1");
  expect(f.texts()).toEqual(["Queued CI."]);
  // The request's own reply is silent while later native work is unsettled.
  f.setTurn(async () => {
    f.native.add("[[stargate:silent]]");
    f.native.add("Still streaming", false);

    return "[[stargate:silent]]";
  });
  f.gateway.accept(followUp("not for you", "2.000"));
  await f.drain();
  expect(f.texts()).toEqual(["Queued CI."]);
  expect(f.failures).toEqual([]);
});

test("a deleted native session stops background probes and keeps its mapping", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("Answer.");

    return "Answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");
  const cursor = f.store.transcript.transcriptCursor(conversation);
  f.native.beforeRead = () => {
    throw new TranscriptUnavailable("session");
  };

  const start = Date.now();

  try {
    await f.settle("session-1");
    const reads = f.native.reads.length;
    setSystemTime(new Date(start + 3_600_000));
    await f.settle();
    await f.settle("session-1"); // Even settle events do not probe it again.
    expect(f.native.reads.length).toBe(reads);
  } finally {
    setSystemTime();
  }

  expect(f.store.session(conversation)).toBe("session-1");
  expect(f.store.transcript.transcriptCursor(conversation)).toBe(cursor);
});

test("repair requeues a failed outbox row and refuses conflicting rows atomically", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("Answer.");

    return "Answer.";
  });
  f.gateway.accept(event());
  await f.drain();
  const conversation = conversationKey(f.gateway.key, "C123", "1.000");
  const since = f.store.transcript.transcriptCursor(conversation) ?? "";
  f.native.add("Lost in delivery.");
  f.gateway.settle("session-1");
  await f.gateway.catchUp(f.signal);
  const post = f.slack.post;
  f.slack.post = async () => {
    throw new Error("Slack unavailable");
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    await f.gateway.process(pending(f), f.signal);
  }

  expect(f.next()).toBeUndefined(); // The outbox row is now failed.
  f.slack.post = post;

  const input = {
    store: f.store,
    backend: f.backend,
    botKey: f.gateway.key,
    channel: "C123",
    thread: "1.000",
    since,
  };

  const dry = await repairTranscript(input);
  expect(dry).toMatchObject({ missing: [], queued: 0, conflicts: [] });
  expect(dry.requeued).toHaveLength(1);
  expect((await repairTranscript({ ...input, apply: true })).queued).toBe(1);
  await f.drain();
  expect(f.texts().at(-1)).toBe("Lost in delivery.");
  expect(await repairTranscript({ ...input, apply: true })).toMatchObject({
    missing: [],
    requeued: [],
    queued: 0,
  });
  // A delivering row with different text for a missing reply is a conflict.
  const cursor = f.store.transcript.transcriptCursor(conversation) ?? "";
  const conflicting = f.native.add("Conflicting reply.");
  f.store.appendTranscript({
    botKey: f.gateway.key,
    conversation,
    from: cursor,
    cursor,
    replies: [{ eventId: `transcript:${conflicting}`, chunks: ["Other text"] }],
  });
  const rows = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10);
  await expect(repairTranscript({ ...input, apply: true })).rejects.toThrow(
    "conflict",
  );
  expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10)).toEqual(
    rows,
  );
  expect(f.store.transcript.transcriptCursor(conversation)).toBe(cursor);
});

test("repair deduplicates prepared replies using original Markdown source", async () => {
  const f = fixture();
  f.slack.prepareReply = prepareSlackReply;

  const source =
    "# Report\n\n**Bold** <@U123>\n\n" + "A long paragraph. ".repeat(300);

  let replyID = "";
  f.setTurn(async () => {
    replyID = f.native.add(source);

    return source;
  });
  f.gateway.accept(event());
  await f.drain();

  const result = await repairTranscript({
    store: f.store,
    backend: f.backend,
    botKey: f.gateway.key,
    channel: "C123",
    thread: "1.000",
    since: "",
  });

  expect(result.missing).toEqual([]);
  expect(result.delivered).toEqual([replyID]);
});

test("transcript cleanup retains indentation before full-source classification", async () => {
  const f = fixture();
  f.slack.prepareReply = prepareSlackReply;
  const payloads: unknown[] = [];
  f.slack.post = async (_channel, _thread, _text, _stop, _unit, content) => {
    payloads.push(content);

    return "101.000";
  };

  const source = "    <@U123> code example\n    second line";
  f.setTurn(async () => {
    f.native.add(source);

    return source;
  });
  f.gateway.accept(event());
  await f.drain();
  expect(JSON.stringify(payloads)).not.toContain('"user_id":"U123"');
  expect(JSON.stringify(payloads)).toContain('"type":"rich_text_preformatted"');
});

test("roster idle checks include pending and in-flight transcript catch-ups", async () => {
  const f = fixture();
  f.setTurn(async () => {
    f.native.add("Complete.");

    return "Complete.";
  });
  f.gateway.accept(event());
  await f.drain();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const read = f.backend.transcript;

  if (!read) {
    throw new Error("Missing transcript fixture");
  }

  f.backend.transcript = async (...args) => {
    entered.resolve();
    await resume.promise;

    return read(...args);
  };

  f.gateway.settle("session-1");
  expect(f.gateway.isIdle()).toBe(false);
  const work = f.gateway.catchUp(new AbortController().signal);
  await entered.promise;
  expect(f.gateway.isIdle()).toBe(false);
  resume.resolve();
  await work;
  expect(f.gateway.isIdle()).toBe(true);
});
