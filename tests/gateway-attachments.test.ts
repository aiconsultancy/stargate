import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import pino from "pino";
import type { AttachmentTransport } from "../src/attachments/attachment-delivery";
import type { Attachment } from "../src/attachments/attachments";
import type { AgentBackend } from "../src/backends/backend";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import { routeEvent } from "../src/gateway/routing";
import { openStore } from "../src/app/open-store";
import { publishedFileDirectory } from "./file-fixture";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8i0AAAAASUVORK5CYII=",
    "base64",
  ),
);

async function fixture(pinned = false) {
  const directory = await publishedFileDirectory("stargate-media-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const image = join(directory, "proof.png");
  await writeFile(image, png);
  const config = bot();
  config.access.channels = ["*"];
  const database = join(directory, "state.sqlite");
  const store = openStore(database);
  let closed = false;

  const closeStore = () => {
    if (!closed) {
      closed = true;
      store.close();
    }
  };

  cleanup.push(closeStore);
  const posts: { channel: string; thread: string; text: string }[] = [];

  const uploads: {
    channel: string;
    thread: string;
    id: string;
    title: string;
  }[] = [];

  const prompts: { text: string; files: readonly Attachment[] }[] = [];
  let reservations = 0;
  let puts = 0;
  let answer = "Received";
  let failComplete = false;
  let isShared = true;

  const transport: AttachmentTransport = {
    async download(ids, channel) {
      expect(channel).toBe("D123");
      expect(ids).toEqual(["FPROOF"]);

      return [{ name: "proof.png", mime: "image/png", data: png }];
    },
    async reserveUpload(name, length) {
      expect(name).toBe("proof.png");
      expect(length).toBe(png.byteLength);

      return {
        fileID: `FUPLOAD${++reservations}`,
        url: "https://files.slack.com/upload/v1/test",
      };
    },
    async putUpload(_url, data) {
      expect(data).toEqual(png);
      expect(
        store.attachmentRecords.attachments(
          store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0]?.id ?? 1,
        )[0]?.phase,
      ).toBe("reserved");
      puts++;
    },
    async completeUpload(channel, thread, id, title) {
      uploads.push({ channel, thread, id, title });

      if (failComplete) throw new Error("Lost completion response");
    },
    async sharedIn() {
      return isShared;
    },
  };

  const backend: AgentBackend = {
    ...(pinned ? { sessionID: "ses_captain" } : {}),
    supportsAttachments: true,
    async createSession() {
      return "ses_captain";
    },
    async prompt(_session, text, _signal, onText, onInput, files = []) {
      prompts.push({ text, files });
      onInput?.(`msg_input${prompts.length}`);
      onText?.(answer);

      return answer;
    },
    async close() {},
  };

  const slack: TransportDelivery = {
    files: transport,
    async post(channel, thread, text) {
      posts.push({ channel, thread, text });
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

  cleanup.push(() => gateway.close());

  const source = (
    channel: string,
    text: string,
    ts: string,
    files?: { id: string }[],
  ) => {
    const body = event(text, ts);

    return {
      ...body,
      event: {
        ...body.event,
        type: "message",
        channel,
        ...(channel.startsWith("D") ? { channel_type: "im" } : {}),
        ...(files ? { subtype: "file_share", files } : {}),
      },
    };
  };

  const signal = new AbortController().signal;

  const drain = async () => {
    for (const job of store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 20))
      await gateway.process(job, signal);
  };

  return {
    directory,
    database,
    closeStore,
    image,
    config,
    store,
    posts,
    prompts,
    backend,
    transport,
    slack,
    gateway,
    signal,
    source,
    drain,
    uploads,
    answer(text: string) {
      answer = text;
    },
    failCompletion(shared: boolean) {
      failComplete = true;
      isShared = shared;
    },
    counters: () => ({ reservations, puts }),
  };
}

test("attachment eval: Slack file-only request persists IDs and reaches agent as bytes", async () => {
  const f = await fixture();
  const request = f.source("D123", "", "1.000", [{ id: "FPROOF" }]);
  expect(f.gateway.accept(request)).toBe(true);
  expect(f.gateway.accept(request)).toBe(false);
  expect(f.store.attachmentRecords.inputFiles(1)).toEqual(["FPROOF"]);
  await f.drain();
  expect(f.prompts).toEqual([
    { text: "", files: [{ name: "proof.png", mime: "image/png", data: png }] },
  ]);
  expect(f.posts).toEqual([
    { channel: "D123", thread: "1.000", text: "Received" },
  ]);
});

test("attachment eval: denied users and unrelated message subtypes cannot load files", async () => {
  const f = await fixture();
  const request = f.source("D123", "", "1.000", [{ id: "FPROOF" }]);
  expect(
    routeEvent(
      { ...request, event: { ...request.event, user: "UDENIED" } },
      f.config,
      identity,
    ),
  ).toBeUndefined();
  expect(
    routeEvent(
      { ...request, event: { ...request.event, subtype: "message_changed" } },
      f.config,
      identity,
    ),
  ).toBeUndefined();
  expect(
    routeEvent(
      { ...request, event: { ...request.event, bot_id: "BBOT" } },
      f.config,
      identity,
    ),
  ).toBeUndefined();
  expect(f.prompts).toEqual([]);
});

test("attachment eval: missing read permission fails before any agent admission", async () => {
  const f = await fixture();
  f.transport.download = async () => {
    throw new Error("missing_scope");
  };

  f.gateway.accept(f.source("D123", "Read this", "1.000", [{ id: "FPROOF" }]));
  await f.drain();
  expect(f.prompts).toEqual([]);
  expect(f.posts[0]?.text).toContain("files:read");
});

for (const shared of [true, false]) {
  test(`attachment eval: lost completion response never republishes or reruns, shared=${shared}`, async () => {
    const f = await fixture();
    f.answer(`Proof\n![Desktop proof](${pathToFileURL(f.image).href})`);
    f.failCompletion(shared);
    f.gateway.accept(f.source("D123", "Screen grab proof", "1.000"));
    await f.drain();
    expect(f.uploads).toHaveLength(1);
    expect(f.store.attachmentRecords.attachments(1)[0]?.phase).toBe(
      "completing",
    );
    await f.drain();
    expect(f.prompts).toHaveLength(1);
    expect(f.uploads).toHaveLength(1);
    expect(f.counters()).toEqual({ reservations: 1, puts: 1 });
    expect(f.posts.map((post) => post.text).join("\n")).not.toContain(
      f.directory,
    );
    expect(f.posts.map((post) => post.text).join("\n")).not.toContain(
      "file://",
    );
    expect(f.store.attachmentRecords.attachments(1)[0]?.phase).toBe(
      shared ? "shared" : "unavailable",
    );

    if (!shared) expect(f.posts.at(-1)?.text).toContain("unconfirmed");
  });
}

test("attachment eval: natural long captions are normalized before one-shot upload completion", async () => {
  const f = await fixture();
  f.answer(
    `![Before/after\tlogin proof ${"x".repeat(300)}](${pathToFileURL(f.image).href})`,
  );
  f.gateway.accept(f.source("D123", "Send proof", "1.000"));
  await f.drain();
  expect(f.uploads).toHaveLength(1);
  const title = f.uploads[0]?.title ?? "";
  expect(title).toStartWith("Before after login proof");
  expect(title).not.toContain("/");
  expect(title).not.toContain("\t");
  expect(title.length).toBeLessThanOrEqual(255);
  expect(f.store.attachmentRecords.attachments(1)[0]?.title).toBe(title);
  expect(f.store.attachmentRecords.attachments(1)[0]?.phase).toBe("shared");
  expect(f.posts.some((post) => post.text.includes("unavailable"))).toBe(false);
  expect(f.counters()).toEqual({ reservations: 1, puts: 1 });
});

test("attachment eval: restart reconciles persisted upload without a second prompt or completion", async () => {
  const f = await fixture();
  f.answer(`![Proof](${pathToFileURL(f.image).href})`);
  f.failCompletion(true);
  f.gateway.accept(f.source("D123", "Send proof", "1.000"));
  await f.drain();
  const before = f.store.attachmentRecords.attachments(1)[0];
  expect(before?.phase).toBe("completing");
  await f.gateway.close();
  f.closeStore();
  const reopened = openStore(f.database);
  cleanup.push(() => reopened.close());
  expect(reopened.attachmentRecords.attachments(1)[0]?.fileID).toBe(
    before?.fileID,
  );

  const gateway = new Gateway(
    f.config,
    identity,
    reopened,
    f.backend,
    f.slack,
    pino({ enabled: false }),
  );

  cleanup.push(() => gateway.close());

  for (const job of reopened.ready(gateway.key, Number.MAX_SAFE_INTEGER, 20))
    await gateway.process(job, f.signal);
  expect(reopened.attachmentRecords.attachments(1)[0]?.phase).toBe("shared");
  expect(f.uploads).toHaveLength(1);
  expect(f.prompts).toHaveLength(1);
  expect(f.posts).toHaveLength(1);
});

test("attachment eval: real OpenCode parser routes late private proof, not public or unknown output", async () => {
  const f = await fixture(true);
  const history: Record<string, unknown>[] = [];
  let time = 0;

  const add = (message: Record<string, unknown>) =>
    history.push({
      ...message,
      time: {
        created: ++time,
        ...(message["type"] === "assistant" ? { completed: time } : {}),
      },
    });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);

      if (!url.pathname.endsWith("/message"))
        return Response.json({
          data: { id: "ses_captain", time: { busy: 0, idle: time + 1 } },
        });
      const start = Number(url.searchParams.get("cursor") ?? 0);

      const end =
        start + Math.min(3, Number(url.searchParams.get("limit") ?? 20));

      return Response.json({
        data: history.toReversed().slice(start, end),
        cursor: end < history.length ? { next: String(end) } : {},
      });
    },
  });

  cleanup.push(() => server.stop(true));

  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url: server.url.href,
    directory: f.directory,
  });

  if (config.type !== "opencode") throw new Error("Invalid fixture");
  const native = new OpenCodeBackend(config);
  f.backend.transcript = (...args) => native.transcript(...args);
  f.backend.prompt = async (_session, text, _signal, _onText, onInput) => {
    f.prompts.push({ text, files: [] });
    const id = `msg_input${f.prompts.length}`;
    onInput?.(id);
    add({ id, type: "user", text });
    add({
      id: `${id}_answer`,
      type: "assistant",
      content: [{ type: "text", text: `Answer ${f.prompts.length}` }],
    });

    return `Answer ${f.prompts.length}`;
  };

  f.gateway.accept(f.source("D123", "Private proof A", "1.000"));
  await f.drain();
  f.gateway.accept(f.source("C456", "<@UBOT> Public B", "2.000"));
  await f.drain();
  add({
    id: "wakeA",
    type: "synthetic",
    metadata: {
      pogoCrew: {
        originCaptainID: "ses_captain",
        originInputID: "msg_input1",
      },
    },
  });
  add({
    id: "privateProof",
    type: "assistant",
    content: [
      {
        type: "text",
        text: `![Private proof](${pathToFileURL(f.image).href})`,
      },
    ],
  });
  add({ id: "unknownWake", type: "synthetic", metadata: { pogoCrew: {} } });
  add({
    id: "unknownProof",
    type: "assistant",
    content: [
      {
        type: "text",
        text: `![Unknown proof](${pathToFileURL(f.image).href})`,
      },
    ],
  });
  f.gateway.settle("ses_captain");
  await f.gateway.catchUp(f.signal);
  await f.drain();
  expect(f.uploads).toEqual([
    {
      channel: "D123",
      thread: "1.000",
      id: "FUPLOAD1",
      title: "Private proof",
    },
  ]);
  expect(f.prompts).toHaveLength(2);
  expect(f.posts.map((post) => post.text).join("\n")).not.toContain("file://");
});

test("attachment delivery rechecks a live deny after upload and before sharing", async () => {
  const f = await fixture();
  const put = f.transport.putUpload;

  if (!put) throw new Error("Missing upload fixture");
  f.transport.putUpload = async (...args) => {
    await put(...args);
    f.gateway.reconfigure({
      ...f.config,
      access: { ...f.config.access, deniedUsers: ["U123"] },
    });
  };

  f.answer(`Proof.\n![proof](${pathToFileURL(f.image).href})`);
  f.gateway.accept(f.source("D123", "Show proof", "1.000"));
  await f.drain();
  expect(f.counters().puts).toBe(1);
  expect(f.uploads).toEqual([]);
});
