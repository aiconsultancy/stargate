import { afterEach, expect, test } from "bun:test";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { botSchema } from "../src/config";
import { Gateway, type SlackDelivery } from "../src/gateway";
import { Store } from "../src/store";
import type { Transcriber } from "../src/transcription";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(
  prompt: AgentBackend["prompt"] = async () => "Answer.",
  transcriber?: Transcriber,
  files?: SlackDelivery["files"],
) {
  const config = bot();
  const store = new Store(":memory:");
  const posts: string[] = [];
  const slack: SlackDelivery = {
    files,
    async post(_channel, _thread, text) {
      posts.push(text);
      return "2.000";
    },
    async update(_channel, _ts, text) {
      posts.push(text);
    },
    async remove() {},
  };
  const backend: AgentBackend = {
    async createSession() {
      return "session";
    },
    prompt,
    async close() {},
  };
  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
    transcriber,
  );
  cleanup.push(
    () => store.close(),
    () => gateway.close(),
  );
  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("Missing job");
    return job;
  };
  return { config, store, posts, slack, gateway, next };
}

test("reconfiguration changes access and text-mention admission without reconnect", () => {
  const f = fixture();
  const body = {
    ...event("Apollo, inspect", "2.000"),
    event: {
      ...event("Apollo, inspect", "2.000").event,
      type: "message",
      user: "U456",
    },
  };
  expect(f.gateway.accept(body)).toBe(false);
  f.gateway.reconfigure(
    Schema.decodeUnknownSync(botSchema)({
      ...f.config,
      access: {
        ...f.config.access,
        users: ["U456"],
        textMentions: { channels: ["C123"], names: ["Apollo"] },
      },
    }),
  );
  expect(f.gateway.accept(body)).toBe(true);
  expect(f.gateway.accept(event("<@UBOT> old user", "3.000"))).toBe(false);
});

test("the starting transcriber survives a reload during file download", async () => {
  const downloading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const providers: string[] = [];
  const provider = (label: string): Transcriber => ({
    label,
    async transcribe() {
      providers.push(label);
      return "Spoken text.";
    },
  });
  const f = fixture(async () => "Done.", provider("old"), {
    async download() {
      downloading.resolve();
      await release.promise;
      return [
        {
          name: "voice.m4a",
          mime: "audio/mp4",
          data: new Uint8Array([1]),
          source: { id: "F123" },
        },
      ];
    },
  });
  const config = Schema.decodeUnknownSync(botSchema)({
    ...f.config,
    transcription: {
      provider: {
        type: "azure-openai",
        endpoint: "https://example.test",
        deployment: "old",
        apiVersion: "2024-06-01",
        auth: "managedIdentity",
      },
    },
  });
  f.gateway.reconfigure(config, provider("old"));
  const body = event();
  f.gateway.accept({
    ...body,
    event: { ...body.event, files: [{ id: "F123" }] },
  });
  const work = f.gateway.process(f.next(), new AbortController().signal);
  await downloading.promise;
  f.gateway.reconfigure(
    Schema.decodeUnknownSync(botSchema)({
      ...config,
      transcription: {
        ...config.transcription,
        provider: { ...config.transcription?.provider, deployment: "new" },
      },
    }),
    provider("new"),
  );
  release.resolve();
  await work;
  expect(providers).toEqual(["old"]);
});

test("a deny reload blocks streaming updates after an earlier preview", async () => {
  const visible = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture(async (_session, _text, _signal, onText) => {
    onText?.("Before deny.");
    await release.promise;
    onText?.("After deny.");
    return "Final after deny.";
  });
  const post = f.slack.post;
  f.slack.post = async (...args) => {
    const ts = await post(...args);
    visible.resolve();
    return ts ?? "2.000";
  };
  f.gateway.accept(event());
  const work = f.gateway.process(f.next(), new AbortController().signal);
  await visible.promise;
  f.gateway.reconfigure(
    Schema.decodeUnknownSync(botSchema)({
      ...f.config,
      access: { ...f.config.access, deniedChannels: ["C123"] },
    }),
  );
  release.resolve();
  await work;
  expect(f.posts).toEqual(["Before deny."]);
});

test("live peer limits enforce caps above the old query bound", () => {
  const f = fixture();
  const configure = (cap: number) =>
    f.gateway.reconfigure(
      Schema.decodeUnknownSync(botSchema)({
        ...f.config,
        access: {
          ...f.config.access,
          users: ["*"],
          peerCaptains: true,
          peerTurnsPerHour: cap,
        },
      }),
    );
  const peer = { user: "UPEER", bot: "BPEER" };
  const send = (index: number) => {
    const body = event("<@UBOT> peer", `${index}.000`);
    return f.gateway.accept(
      {
        ...body,
        event: {
          ...body.event,
          type: "message",
          user: peer.user,
          bot_id: peer.bot,
          thread_ts: "1.000",
        },
      },
      peer,
    );
  };
  configure(101);
  for (let index = 1; index <= 101; index++) expect(send(index)).toBe(true);
  expect(send(102)).toBe(false);
  configure(102);
  expect(send(102)).toBe(true);
  configure(0);
  expect(send(103)).toBe(false);
});

test("a deny reload blocks a Slack reaction from an active turn", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const f = fixture(async () => {
    entered.resolve();
    await resume.promise;
    return "[[stargate:react:eyes]]";
  });
  let reactions = 0;
  f.slack.react = async () => {
    reactions++;
  };
  f.gateway.accept(event());
  const work = f.gateway.process(f.next(), new AbortController().signal);
  await entered.promise;
  f.gateway.reconfigure({
    ...f.config,
    access: { ...f.config.access, deniedChannels: ["C123"] },
  });
  resume.resolve();
  await work;
  expect(reactions).toBe(0);
});
