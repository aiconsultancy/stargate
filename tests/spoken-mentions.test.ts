import { afterEach, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Result, Schema } from "effect";
import pino from "pino";
import type { Attachment } from "../src/attachments";
import type { AgentBackend } from "../src/backend";
import { botSchema } from "../src/config";
import { Gateway, type SlackDelivery } from "../src/gateway";
import type { RequestFailure } from "../src/request-failure";
import { conversationKey, routeEvent } from "../src/routing";
import { Store } from "../src/store";
import {
  spokenMention,
  spokenMentionNote,
  type Transcriber,
  transcriptionSchema,
} from "../src/transcription";
import { identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const names = ["Galactica", "Adama", "captain"];
const provider = {
  type: "azure-openai",
  endpoint: "https://example.openai.azure.com",
  deployment: "whisper-transcription",
  apiVersion: "2024-06-01",
  auth: "managedIdentity",
};
const voice = (transcript?: string): Attachment => ({
  name: "Audio clip.m4a",
  mime: "audio/mp4",
  data: new TextEncoder().encode("fixture m4a"),
  source: {
    id: "F0VOICE",
    durationMs: 4000,
    ...(transcript ? { transcript } : {}),
  },
});

function config(
  options: {
    spoken?: boolean;
    mentionOnly?: boolean;
    channels?: string[];
  } = {},
) {
  return Schema.decodeUnknownSync(botSchema)({
    id: "galactica-captain",
    slack: {
      appId: "A123",
      appTokenEnv: "APP_TOKEN",
      botTokenEnv: "BOT_TOKEN",
    },
    access: {
      users: ["U123", "U456"],
      channels: ["C123", "C999", "D123"],
      deniedUsers: ["U456"],
      mentionOnly: options.mentionOnly ?? false,
    },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
    },
    transcription: {
      provider,
      ...(options.spoken === false
        ? {}
        : {
            spokenMentions: { channels: options.channels ?? ["C123"], names },
          }),
    },
  });
}

function message(
  options: {
    text?: string;
    ts?: string;
    thread?: string;
    channel?: string;
    user?: string;
    files?: string[];
  } = {},
) {
  const channel = options.channel ?? "C123";
  return {
    api_app_id: "A123",
    team_id: "T123",
    event_id: `Ev${options.ts ?? "1.000"}`,
    event: {
      type: "message",
      subtype: "file_share",
      user: options.user ?? "U123",
      channel,
      ...(channel.startsWith("D") ? { channel_type: "im" } : {}),
      text: options.text ?? "",
      ts: options.ts ?? "1.000",
      ...(options.thread ? { thread_ts: options.thread } : {}),
      files: (options.files ?? ["F0VOICE"]).map((id) => ({ id })),
    },
  };
}

test("setting: off by default; channels are IDs, names are words", () => {
  expect(
    Schema.decodeUnknownSync(transcriptionSchema)({ provider }).spokenMentions,
  ).toBeUndefined();
  const valid = { channels: ["C0EXAMPLE04", "G123"], names };
  expect(
    Schema.decodeUnknownSync(transcriptionSchema)({
      provider,
      spokenMentions: valid,
    }).spokenMentions,
  ).toEqual(valid);
  for (const spokenMentions of [
    { channels: ["*"], names },
    { channels: ["D123"], names },
    { channels: [], names },
    { channels: ["C1"], names: [] },
    { channels: ["C1"], names: ["Gal.*"] },
    { channels: ["C1"], names: ["x".repeat(41)] },
    { channels: ["C1"], names, extra: true },
  ])
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(transcriptionSchema)({
          provider,
          spokenMentions,
        }),
      ),
    ).toBe(false);
});

test("spoken mentions are whole words in any letter case", () => {
  for (const text of [
    "Galactica, please check the deploy.",
    "ok adama what's the status",
    "Adama's crew can take it",
    "Hey CAPTAIN — merge it",
    "status for\ngalactica",
  ])
    expect(spokenMention([text], names)).toBe(true);
  for (const text of [
    "the galactic fleet",
    "all captains report",
    "Adamant about it",
    "",
  ])
    expect(spokenMention([text], names)).toBe(false);
  expect(spokenMention(["admiral   adama here"], ["Admiral Adama"])).toBe(true);
  // A configured variant is literal, not a pattern.
  expect(spokenMention(["Adamah, go"], ["Adamah"])).toBe(true);
  expect(spokenMention(["a.b"], ["a.b"])).toBe(true);
  expect(spokenMention(["axb"], ["a.b"])).toBe(false);
});

test("routing holds only unmentioned file messages in configured channels", () => {
  const held = config();
  expect(routeEvent(message(), held, identity)).toMatchObject({
    gate: "spoken",
    startsConversation: false,
  });
  // Typed mention, DM, other channel, setting off, or no file: unchanged.
  for (const [body, cfg] of [
    [message({ text: "<@UBOT> look" }), held],
    [message({ channel: "D123" }), held],
    [message({ channel: "C999" }), held],
    [message(), config({ spoken: false })],
  ] as const)
    expect(routeEvent(body, cfg, identity)).not.toHaveProperty("gate");
  // Deny lists still win; mentionOnly still admits a held voice message.
  expect(routeEvent(message({ user: "U456" }), held, identity)).toBeUndefined();
  expect(
    routeEvent(message(), config({ mentionOnly: true }), identity),
  ).toMatchObject({ gate: "spoken" });
  expect(
    routeEvent(
      message({ channel: "C999" }),
      config({ mentionOnly: true }),
      identity,
    ),
  ).toBeUndefined();
});

function fixture(options: Parameters<typeof config>[0] = {}) {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const cfg = config(options);
  const logged: string[] = [];
  const log = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _encoding, done) {
        logged.push(String(chunk));
        done();
      },
    }),
  );
  let files: Attachment[] = [voice()];
  let heard = "Galactica, merge pull request 42. SPOKEN_PRIVATE";
  let fail = false;
  let downloads = 0;
  const calls: string[] = [];
  const prompts: { text: string; files: readonly Attachment[] }[] = [];
  const posts: { thread: string; text: string }[] = [];
  const failures: RequestFailure[] = [];
  const transcriber: Transcriber = {
    label: "Azure OpenAI deployment whisper-transcription",
    async transcribe() {
      calls.push("provider");
      if (fail) throw new Error("PRIVATE provider failure");
      return heard;
    },
  };
  const sessions: string[] = [];
  const backend: AgentBackend = {
    supportsAttachments: true,
    async createSession() {
      sessions.push("created");
      return "session";
    },
    async prompt(_session, text, _signal, _onText, _onInput, files = []) {
      prompts.push({ text, files });
      return "On it.";
    },
    async close() {},
  };
  const slack: SlackDelivery = {
    files: {
      async download() {
        downloads++;
        return files;
      },
      async reserveUpload() {
        throw new Error("unused");
      },
      async putUpload() {},
      async completeUpload() {},
      async sharedIn() {
        return false;
      },
    },
    async post(_channel, thread, text) {
      posts.push({ thread, text });
    },
    async failure(_channel, _thread, cause) {
      failures.push(cause);
      return "status";
    },
  };
  const gateway = new Gateway(
    cfg,
    identity,
    store,
    backend,
    slack,
    log,
    transcriber,
  );
  cleanup.push(() => gateway.close());
  const drain = async (signal = new AbortController().signal) => {
    for (
      let jobs = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 20);
      jobs.length;
      jobs = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 20)
    ) {
      for (const job of jobs) await gateway.process(job, signal);
      if (signal.aborted) return;
    }
  };
  return {
    store,
    gateway,
    prompts,
    posts,
    failures,
    logged,
    calls,
    sessions,
    drain,
    downloads: () => downloads,
    followed: (thread: string) =>
      store.follows(conversationKey(gateway.key, "C123", thread)),
    set(next: { files?: Attachment[]; heard?: string; fail?: boolean }) {
      if (next.files) files = next.files;
      if (next.heard !== undefined) heard = next.heard;
      if (next.fail !== undefined) fail = next.fail;
    },
  };
}

test("a voice message that names the bot starts a turn, marked as admitted by speech", async () => {
  const f = fixture();
  expect(f.gateway.accept(message({ text: "fyi" }))).toBe(true);
  // Held: it does not make the thread followed before its speech is known.
  expect(f.followed("1.000")).toBe(false);
  await f.drain();
  expect(f.calls).toEqual(["provider"]);
  expect(f.downloads()).toBe(1);
  expect(f.prompts).toHaveLength(1);
  const [typed, note, block] = f.prompts[0]?.text.split("\n\n") ?? [];
  expect(typed).toBe("fyi");
  expect(note).toBe(spokenMentionNote);
  expect(block).toStartWith("[Voice message transcript: file F0VOICE, 4.0 s");
  expect(f.prompts[0]?.files).toEqual([]);
  expect(f.posts).toEqual([{ thread: "1.000", text: "On it." }]);
  // Admitted: the thread now continues without another mention.
  expect(f.followed("1.000")).toBe(true);
  expect(
    f.gateway.accept({
      ...message({ text: "and the tests", ts: "1.100", thread: "1.000" }),
      event: {
        ...message({ ts: "1.100", thread: "1.000" }).event,
        subtype: undefined,
        text: "and the tests",
        files: undefined,
      },
    }),
  ).toBe(true);
});

test("a voice message that does not name the bot leaves nothing behind", async () => {
  const f = fixture();
  f.set({ heard: "Jac, can you look at the staging deploy? SPOKEN_PRIVATE" });
  f.gateway.accept(message({ text: "typed PRIVATE_TYPED" }));
  await f.drain();
  expect(f.prompts).toEqual([]);
  expect(f.posts).toEqual([]);
  expect(f.failures).toEqual([]);
  // The row is deleted; the thread is not followed.
  expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 5)).toEqual([]);
  expect(JSON.stringify(f.store.recentJobs(f.gateway.key, 5))).not.toContain(
    "PRIVATE_TYPED",
  );
  expect(f.store.inputFiles(1)).toEqual([]);
  expect(f.sessions).toEqual([]);
  // Slack redelivery of the same event is deduplicated: no second transcription.
  expect(f.gateway.accept(message({ text: "typed PRIVATE_TYPED" }))).toBe(
    false,
  );
  await f.drain();
  expect(f.calls).toEqual(["provider"]);
  expect(f.followed("1.000")).toBe(false);
  expect(
    f.gateway.accept({
      ...message({ ts: "1.100", thread: "1.000" }),
      event: {
        ...message({ ts: "1.100", thread: "1.000" }).event,
        subtype: undefined,
        text: "reply",
        files: undefined,
      },
    }),
  ).toBe(false);
  const logs = f.logged.join("");
  expect(logs).toContain("Voice message without spoken mention ignored");
  expect(logs).not.toContain("SPOKEN_PRIVATE");
  expect(logs).not.toContain("PRIVATE_TYPED");
});

test("a failed transcription, an oversize file or no media is ignored without a notice", async () => {
  for (const arrange of [
    (f: ReturnType<typeof fixture>) => f.set({ fail: true }),
    (f: ReturnType<typeof fixture>) =>
      f.set({ files: [{ ...voice(), name: "note.ogg", mime: "audio/ogg" }] }),
    (f: ReturnType<typeof fixture>) =>
      f.set({
        files: [{ ...voice(), data: new Uint8Array(10 * 1024 * 1024 + 1) }],
      }),
    (f: ReturnType<typeof fixture>) =>
      f.set({
        files: [{ name: "a.png", mime: "image/png", data: new Uint8Array(1) }],
      }),
  ]) {
    const f = fixture();
    arrange(f);
    f.gateway.accept(message());
    await f.drain();
    expect(f.prompts).toEqual([]);
    expect(f.posts).toEqual([]);
    expect(f.failures).toEqual([]);
    expect(f.followed("1.000")).toBe(false);
    expect(f.logged.join("")).not.toContain("PRIVATE provider failure");
  }
});

test("held and ignored messages never become a thread's delivery target", () => {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const key = "bot";
  const conversation = conversationKey(key, "C123", "1.000");
  const base = {
    botKey: key,
    conversation,
    channel: "C123",
    thread: "1.000",
    text: "",
  };
  store.enqueue({ ...base, eventId: "C123:1.000", user: "U123" });
  store.saveSession(conversation, "session", "cursor");
  store.enqueue({
    ...base,
    eventId: "C123:1.100",
    user: "U789",
    gate: "spoken",
  });
  expect(store.transcriptTarget(key, conversation)?.user).toBe("U123");
  const id = store.queuedJob(key, "C123:1.100")?.id;
  if (id === undefined) throw new Error("Missing held job");
  store.discard(id);
  expect(store.transcriptTarget(key, conversation)?.user).toBe("U123");
  expect(store.enqueue({ ...base, eventId: "C123:1.100", user: "U789" })).toBe(
    false,
  );
});

test("Slack's own transcript decides the mention without a provider request", async () => {
  const f = fixture();
  f.set({ files: [voice("Adama, ship it.")] });
  f.gateway.accept(message());
  await f.drain();
  expect(f.calls).toEqual([]);
  expect(f.prompts[0]?.text).toContain("machine transcription by Slack");
  expect(f.prompts[0]?.text).toContain("\nAdama, ship it.\n");
});

test("typed mentions, other channels and followed threads keep today's behaviour", async () => {
  const f = fixture();
  // Typed mention: ordinary request, transcribed once, no spoken-mention note.
  f.set({ heard: "nothing that names anyone" });
  f.gateway.accept(message({ text: "<@UBOT> listen" }));
  await f.drain();
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]?.text).not.toContain(spokenMentionNote);
  expect(f.calls).toEqual(["provider"]);
  // A voice reply in that followed thread is an ordinary follow-up.
  f.gateway.accept(message({ ts: "1.100", thread: "1.000" }));
  await f.drain();
  expect(f.prompts).toHaveLength(2);
  expect(f.prompts[1]?.text).not.toContain(spokenMentionNote);
  // A channel without the setting ignores an unmentioned voice message.
  expect(f.gateway.accept(message({ channel: "C999", ts: "2.000" }))).toBe(
    false,
  );
  await f.drain();
  expect(f.prompts).toHaveLength(2);
  expect(f.downloads()).toBe(2);
});

test("with mentionOnly, a followed-thread voice reply still needs its speech to name the bot", async () => {
  const f = fixture({ mentionOnly: true });
  f.gateway.accept(message({ text: "<@UBOT> start" }));
  await f.drain();
  f.set({ heard: "talking to Jac" });
  f.gateway.accept(message({ ts: "1.100", thread: "1.000" }));
  await f.drain();
  expect(f.prompts).toHaveLength(1);
  f.set({ heard: "Galactica, and one more" });
  f.gateway.accept(message({ ts: "1.200", thread: "1.000" }));
  await f.drain();
  expect(f.prompts).toHaveLength(2);
  expect(f.prompts[1]?.text).toContain(spokenMentionNote);
});

test("shutdown during transcription keeps the held message for the next run", async () => {
  const f = fixture();
  const stop = new AbortController();
  f.set({ fail: true });
  f.gateway.accept(message());
  stop.abort();
  await f.drain(stop.signal);
  const pending = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 5);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.gate).toBe("spoken");
  expect(pending[0]?.status).toBe("queued");
  // Recovery after a restart does not post an "interrupted" notice for it.
  f.store.recover(f.gateway.key);
  f.set({ fail: false });
  await f.drain();
  expect(f.prompts).toHaveLength(1);
  expect(f.failures).toEqual([]);
});

test("an admitted message whose memory copy was lost is transcribed again and keeps its note", async () => {
  const f = fixture();
  f.gateway.accept(message());
  const job = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
  if (!job) throw new Error("Missing job");
  // As after a restart between the gate and the turn.
  expect(f.store.admitSpoken(job.id)).toBe(true);
  await f.drain();
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]?.text).toContain(spokenMentionNote);
  expect(f.calls).toEqual(["provider"]);
});
