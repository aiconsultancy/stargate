import { afterEach, expect, test } from "bun:test";
import { Store, TranscriptConflict } from "../src/store";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("captain cursor seeds only from its matching root's last started owner", () => {
  const store = new Store(":memory:");
  stores.push(store);
  store.enqueue({
    eventId: "old",
    botKey: "bot",
    conversation: "source",
    channel: "C123",
    thread: "1.000",
    user: "U123",
    text: "old",
  });
  const job = store.ready("bot", Date.now(), 1)[0];
  if (!job) throw new Error("Missing job");
  store.running(job.id);
  store.saveSession("source", "captain", "head");
  store.respond(job.id, ["old answer"]);
  store.finish(job.id);
  store.enqueue({
    eventId: "queued",
    botKey: "bot",
    conversation: "source",
    channel: "C123",
    thread: "1.000",
    user: "U123",
    text: "not started",
  });
  expect(store.captainCursor("bot", "captain")).toEqual({
    cursor: "head",
    owner: job.id,
  });
  expect(store.captainCursor("other-bot", "captain")).toEqual({
    cursor: undefined,
    owner: null,
  });
  expect(store.session("source")).toBe("captain");
  expect(store.transcriptCursor("source")).toBe("head");
});

test("captain response, cursor and explicit previous-source outbox commit atomically", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const enqueue = (eventId: string, channel: string) => {
    store.enqueue({
      eventId,
      botKey: "bot",
      conversation: channel,
      channel,
      thread: "1.000",
      user: "U123",
      text: eventId,
    });
    const job = store
      .ready("bot", Date.now(), 10)
      .find((job) => job.eventId === eventId);
    if (!job) throw new Error("Missing job");
    return job;
  };
  const old = enqueue("old", "D123");
  store.running(old.id);
  store.respond(old.id, ["old answer"]);
  store.finish(old.id);
  const current = enqueue("current", "C123");
  store.running(current.id);
  const from = store.captainCursor("bot", "pin");
  const commit = {
    botKey: "bot",
    sessionID: "pin",
    from,
    cursor: "head",
    owner: current.id,
    replies: [
      { job: old.id, eventId: "transcript:late", chunks: ["old continuation"] },
    ],
  };
  store.respond(current.id, ["current answer"], undefined, { captain: commit });
  expect(store.captainCursor("bot", "pin")).toEqual({
    cursor: "head",
    owner: current.id,
  });
  const outbox = store
    .ready("bot", Date.now(), 10)
    .find((job) => job.eventId === "transcript:late");
  expect(outbox).toMatchObject({
    channel: "D123",
    thread: "1.000",
    user: "U123",
    conversation: "D123",
  });
  expect(() =>
    store.respond(current.id, ["must roll back"], undefined, {
      captain: commit,
    }),
  ).toThrow(TranscriptConflict);
  expect(store.replies("bot", "C123")).toEqual([["current answer"]]);
  expect(store.captainCursor("bot", "pin")).toEqual({
    cursor: "head",
    owner: current.id,
  });
});

test("persisted input anchors failed baselines and cannot cross bot namespaces", () => {
  const store = new Store(":memory:");
  stores.push(store);
  store.enqueue({
    eventId: "start",
    botKey: "bot",
    conversation: "source",
    channel: "D123",
    thread: "1.000",
    user: "U123",
    text: "start",
  });
  const job = store.ready("bot", Date.now(), 1)[0];
  if (!job) throw new Error("Missing job");
  store.running(job.id);
  store.captainCursor("bot", "pin");
  store.saveInput("bot", job.id, "native-input", "pin");
  expect(store.captainCursor("bot", "pin")).toEqual({
    cursor: "native-input",
    owner: job.id,
  });
  expect(store.jobByInput("bot", "native-input")?.id).toBe(job.id);
  expect(store.jobByInput("other", "native-input")).toBeNull();
  expect(() => store.saveInput("other", job.id, "wrong", "pin")).toThrow();
  expect(store.jobByInput("bot", "native-input")?.id).toBe(job.id);
});

test("serial ready selection keeps FIFO across sources during delivery backoff", () => {
  const store = new Store(":memory:");
  stores.push(store);
  for (const [eventId, conversation] of [
    ["reply", "a"],
    ["first-input", "a"],
    ["later-input", "b"],
  ]) {
    if (!eventId || !conversation) throw new Error("Missing fixture");
    store.enqueue({
      eventId,
      botKey: "bot",
      conversation,
      channel: conversation,
      thread: "1.000",
      user: "U123",
      text: eventId,
    });
  }
  const first = store.ready("bot", Date.now(), 1)[0];
  if (!first) throw new Error("Missing job");
  store.respond(first.id, ["reply"]);
  store.retry(first.id, Date.now() + 60_000);
  expect(store.ready("bot", Date.now(), 10, true)).toEqual([]);
  expect(store.ready("bot", Date.now(), 10).map((job) => job.eventId)).toEqual([
    "later-input",
  ]);
});
