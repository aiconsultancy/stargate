import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/app/open-store";
import { type Store } from "../src/gateway/store";

test("IRC reply parent migrates, survives reopen and stays scoped to the registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-thread-store-"));
  const path = join(directory, "store.sqlite");
  let store: Store | undefined;

  try {
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, eventId TEXT NOT NULL, botKey TEXT NOT NULL,
      conversation TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL,
      user TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      response TEXT, sent INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, UNIQUE(botKey,eventId));
      INSERT INTO jobs (eventId,botKey,conversation,channel,thread,user,text)
      VALUES ('old','bot','old','#ship','old','jack','old');`);
    legacy.close();
    store = openStore(path);

    const input = {
      eventId: "#ship:request",
      botKey: "bot",
      conversation: "channel",
      channel: "#ship",
      thread: "request",
      user: "jack",
      text: "check",
      replyParent: "root;with\\slash",
    };

    store.enqueue(input);
    store.close();
    store = openStore(path);
    expect(
      store
        .ready("bot", Date.now(), 10)
        .find((job) => job.thread === "request"),
    ).toMatchObject({ thread: "request", replyParent: input.replyParent });
    expect(store.irc.ircReplyParent("bot", "request")).toBe(input.replyParent);
    expect(store.irc.ircReplyParent("other", "request")).toBeUndefined();
    expect(store.irc.ircReplyParent("bot", "old")).toBeUndefined();
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("IRC reply parent follows both transcript outbox paths and Stop keeps the request", () => {
  const store = openStore(":memory:");

  try {
    store.enqueue({
      eventId: "#ship:request",
      botKey: "bot",
      conversation: "channel",
      channel: "#ship",
      thread: "request",
      user: "jack",
      text: "check",
      replyParent: "root",
    });
    const request = store.ready("bot", Date.now(), 1)[0];

    if (!request) throw new Error("missing request");
    expect(store.cancelTurn("bot", "channel", "root")).toBeUndefined();
    expect(store.cancelTurn("bot", "channel", "request")).toBe(request.id);
    store.finish(request.id);
    store.saveSession("channel", "session", "before");
    expect(
      store.appendTranscript({
        botKey: "bot",
        conversation: "channel",
        from: "before",
        cursor: "after",
        replies: [{ eventId: "transcript:ordinary", chunks: ["continuation"] }],
      }),
    ).toBe(1);
    const ordinary = store.ready("bot", Date.now(), 1)[0];
    expect(ordinary).toMatchObject({ thread: "request", replyParent: "root" });

    if (!ordinary) throw new Error("missing continuation");
    store.finish(ordinary.id);
    const from = store.captainCursor("bot", "captain");
    expect(
      store.appendCaptainTranscript({
        botKey: "bot",
        sessionID: "captain",
        from,
        cursor: "head",
        owner: request.id,
        replies: [
          {
            job: request.id,
            eventId: "transcript:captain",
            chunks: ["late captain"],
          },
        ],
      }),
    ).toBe(true);
    expect(store.ready("bot", Date.now(), 1)[0]).toMatchObject({
      thread: "request",
      replyParent: "root",
    });
  } finally {
    store.close();
  }
});
