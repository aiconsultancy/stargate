import { afterEach, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Result, Schema } from "effect";
import pino from "pino";
import type { Attachment } from "../src/attachments/attachments";
import type { AgentBackend } from "../src/backends/backend";
import { botSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import type { RequestFailure } from "../src/shared/request-failure";
import { openStore } from "../src/app/open-store";
import { AzureOpenAITranscriber } from "../src/transcription/azure-openai";
import { createTranscriber } from "../src/transcription/startup";
import {
  maxTranscriptCharacters,
  type Transcriber,
  TranscriptionUnavailable,
  transcribeMedia,
  transcriptionSchema,
} from "../src/transcription/transcription";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];

test("startup constructs the configured transcription provider", () => {
  const transcriber = createTranscriber({
    provider: {
      type: "azure-openai",
      endpoint: "https://example.openai.azure.com",
      deployment: "startup-fixture",
      apiVersion: "2024-06-01",
      auth: "managedIdentity",
    },
    timeoutMs: 120_000,
  });

  expect(transcriber).toBeInstanceOf(AzureOpenAITranscriber);
  expect(transcriber.label).toBe("Azure OpenAI deployment startup-fixture");
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const audio = new TextEncoder().encode("fixture m4a bytes, not real audio");
const spoken = "Please merge pull request forty-two SPOKEN_PRIVATE_TEXT";
const secretToken = "entra-token-PRIVATE_TOKEN";

const voice = (change: Partial<Attachment> = {}): Attachment => ({
  name: "Audio clip (2026-11-11 08:14:15).m4a",
  mime: "audio/mp4",
  data: audio,
  source: { id: "F0VOICE", durationMs: 68_638 },
  ...change,
});

/** Local stand-in for Azure IMDS and the Azure OpenAI transcription route. */
function provider() {
  const tokens: (string | null)[] = [];

  const requests: {
    path: string;
    version: string | null;
    authorization: string | null;
    key: string | null;
    name: string;
    bytes: number;
    format: FormDataEntryValue | null;
  }[] = [];

  const state = {
    now: Date.UTC(2026, 10, 11, 12),
    lifetimeSeconds: 86_400,
    status: 200,
    /** Answers before `status`: [status, Retry-After header or undefined]. */
    limited: [] as [number, string | undefined][],
    tokenStatus: 200,
    body: { text: spoken } as unknown,
    hold: undefined as Promise<void> | undefined,
    active: 0,
    peak: 0,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/metadata/identity/oauth2/token") {
        tokens.push(request.headers.get("Metadata"));

        if (
          state.tokenStatus !== 200 ||
          request.headers.get("Metadata") !== "true"
        )
          return new Response("identity PRIVATE_IDENTITY_ERROR", {
            status: state.tokenStatus === 200 ? 400 : state.tokenStatus,
          });

        return Response.json({
          access_token: `${secretToken}-${tokens.length}`,
          expires_on: String(
            Math.floor(state.now / 1000) + state.lifetimeSeconds,
          ),
          token_type: "Bearer",
        });
      }

      const form = await request.formData();
      const file = form.get("file");

      if (!(file instanceof File)) return new Response(null, { status: 400 });
      requests.push({
        path: url.pathname,
        version: url.searchParams.get("api-version"),
        authorization: request.headers.get("authorization"),
        key: request.headers.get("api-key"),
        name: file.name,
        bytes: file.size,
        format: form.get("response_format"),
      });
      const limit = state.limited.shift();

      if (limit)
        return new Response("provider PRIVATE_PROVIDER_ERROR", {
          status: limit[0],
          headers: limit[1] === undefined ? {} : { "retry-after": limit[1] },
        });
      state.peak = Math.max(state.peak, ++state.active);

      try {
        await state.hold;

        return state.status === 200
          ? Response.json(state.body)
          : new Response("provider PRIVATE_PROVIDER_ERROR", {
              status: state.status,
            });
      } finally {
        state.active--;
      }
    },
  });

  cleanup.push(() => server.stop(true));
  const origin = server.url.origin;

  const config = Schema.decodeUnknownSync(transcriptionSchema)({
    provider: {
      type: "azure-openai",
      endpoint: origin,
      deployment: "whisper-transcription",
      apiVersion: "2024-06-01",
      auth: "managedIdentity",
    },
  });

  const waits: number[] = [];

  const transcriber = new AzureOpenAITranscriber(config.provider, {
    identityURL: `${origin}/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fcognitiveservices.azure.com%2F`,
    now: () => state.now,
    wait: async (ms, signal) => {
      waits.push(ms);
      signal.throwIfAborted();
    },
  });

  return { state, tokens, requests, waits, config, transcriber };
}

const signal = () => new AbortController().signal;

test("transcription is off by default and accepts only the keyless Azure shape", () => {
  expect(bot().transcription).toBeUndefined();

  const provider = {
    type: "azure-openai",
    endpoint: "https://example.openai.azure.com",
    deployment: "whisper-transcription",
    apiVersion: "2024-06-01",
    auth: "managedIdentity",
  };

  const parsed = Schema.decodeUnknownSync(botSchema)({
    ...bot(),
    transcription: { provider },
  });

  expect(parsed.transcription?.timeoutMs).toBe(120_000);

  for (const change of [
    { endpoint: "http://example.openai.azure.com" },
    { endpoint: "https://example.openai.azure.com/openai" },
    { endpoint: "https://user:pass@example.openai.azure.com" },
    { endpoint: "https://example.openai.azure.com?key=1" },
    { deployment: "../other" },
    { apiVersion: "latest" },
    { auth: "apiKey" },
    { apiKey: "not-accepted" },
    { type: "openai" },
  ])
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(transcriptionSchema)({
          provider: { ...provider, ...change },
        }),
      ),
    ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(transcriptionSchema)({
        provider,
        timeoutMs: 500,
      }),
    ),
  ).toBe(false);
});

test("Azure provider sends the audio with a cached managed-identity token and no key", async () => {
  const f = provider();
  const file = { data: audio, mime: "audio/mp4", extension: "m4a" };
  expect(await f.transcriber.transcribe(file, signal())).toBe(spoken);
  expect(await f.transcriber.transcribe(file, signal())).toBe(spoken);
  expect(f.tokens).toEqual(["true"]);
  expect(f.requests).toEqual(
    Array.from({ length: 2 }, () => ({
      path: "/openai/deployments/whisper-transcription/audio/transcriptions",
      version: "2024-06-01",
      authorization: `Bearer ${secretToken}-1`,
      key: null,
      // The user's file name stays private; only the format is sent.
      name: "audio.m4a",
      bytes: audio.byteLength,
      format: "json",
    })),
  );
  // Inside five minutes of expiry the token is read again.
  f.state.now += (f.state.lifetimeSeconds - 4 * 60) * 1000;
  await f.transcriber.transcribe(file, signal());
  expect(f.tokens).toHaveLength(2);
  expect(f.requests.at(-1)?.authorization).toBe(`Bearer ${secretToken}-2`);
});

test("Azure preserves raw transcript strings and accepts extra provider fields", async () => {
  const f = provider();
  const file = { data: audio, mime: "audio/mp4", extension: "m4a" };

  for (const text of ["", "  \t\n", "Unicode 🦘\nsecond line\u0000"]) {
    f.state.body = { text, extra: "ignored provider metadata" };
    expect(await f.transcriber.transcribe(file, signal())).toBe(text);
  }
});

test("Azure token expiry uses Number coercion and positive safe integers", async () => {
  const file = { data: audio, mime: "audio/mp4", extension: "m4a" };

  const providerConfig = Schema.decodeUnknownSync(transcriptionSchema)({
    provider: {
      type: "azure-openai",
      endpoint: "http://127.0.0.1:1",
      deployment: "fixture",
      apiVersion: "2024-06-01",
      auth: "managedIdentity",
    },
  }).provider;

  for (const [expires_on, accepted, cached] of [
    ["3600", true, true],
    [" 0xE10 ", true, true],
    ["3.6e3", true, true],
    [true, true, false],
    [[3600], true, true],
    [Number.MAX_SAFE_INTEGER, true, true],
    [null, false, false],
    [false, false, false],
    ["", false, false],
    [[], false, false],
    [{}, false, false],
    ["Infinity", false, false],
    ["NaN", false, false],
    [0, false, false],
    [-1, false, false],
    [1.5, false, false],
    [Number.MAX_SAFE_INTEGER + 1, false, false],
  ] as const) {
    let identities = 0;
    const authorizations: (string | null)[] = [];

    const transcriber = new AzureOpenAITranscriber(providerConfig, {
      now: () => 0,
      fetch: async (_url, init) => {
        if (init?.method !== "POST") {
          identities++;

          return Response.json({
            access_token: secretToken,
            expires_on,
            extra: "ignored",
          });
        }

        authorizations.push(new Headers(init.headers).get("authorization"));

        return Response.json({ text: "answer" });
      },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      if (accepted)
        expect(await transcriber.transcribe(file, signal())).toBe("answer");
      else
        await expect(transcriber.transcribe(file, signal())).rejects.toThrow(
          /^Transcription request failed$/,
        );
    }

    expect(identities).toBe(cached ? 1 : 2);
    expect(authorizations).toEqual(
      accepted ? [`Bearer ${secretToken}`, `Bearer ${secretToken}`] : [],
    );
  }
});

test("provider failures are one fixed error, drop a refused token and honour cancellation", async () => {
  const f = provider();
  const file = { data: audio, mime: "audio/mp4", extension: "m4a" };

  for (const [status, body] of [
    [500, undefined],
    [401, undefined],
    [200, { transcript: "wrong shape" }],
    [200, {}],
    [200, { text: null }],
    [200, { text: 42 }],
    [200, { text: {} }],
    [200, null],
    [200, []],
  ] as const) {
    f.state.status = status;

    if (body !== undefined) f.state.body = body;

    const error = await f.transcriber
      .transcribe(file, signal())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : undefined).toBe(
      "Transcription request failed",
    );
    expect(
      error instanceof Error ? `${error.stack} ${String(error.cause)}` : "",
    ).not.toContain("PRIVATE");
  }

  // 500 kept the token; 401 dropped it, so the next request read a new one.
  expect(f.tokens).toHaveLength(2);
  f.state.tokenStatus = 500;
  f.state.now += f.state.lifetimeSeconds * 1000;
  await expect(f.transcriber.transcribe(file, signal())).rejects.toThrow(
    "Transcription request failed",
  );
  const before = f.requests.length;
  const stopped = new AbortController();
  stopped.abort(new Error("stopped"));
  await expect(f.transcriber.transcribe(file, stopped.signal)).rejects.toThrow(
    "stopped",
  );
  expect(f.requests).toHaveLength(before);
});

test("a rate limit waits for the provider's own delay and sends the same audio again", async () => {
  const f = provider();
  const file = { data: audio, mime: "audio/mp4", extension: "m4a" };
  f.state.limited.push([429, "34"], [429, "0"]);
  expect(await f.transcriber.transcribe(file, signal())).toBe(spoken);
  expect(f.waits).toEqual([34_000, 1000]);
  expect(f.requests).toHaveLength(3);
  expect(f.tokens).toHaveLength(1);

  // No usable delay, an excessive one, or another refusal is final.
  for (const limit of [
    [429, undefined],
    [429, "soon"],
    [429, "301"],
    [503, "1"],
  ] as [number, string | undefined][]) {
    f.state.limited.push(limit);
    await expect(f.transcriber.transcribe(file, signal())).rejects.toThrow(
      "Transcription request failed",
    );
  }

  expect(f.waits).toHaveLength(2);
});

test("media becomes marked blocks; other files pass through unchanged", async () => {
  const f = provider();

  const image: Attachment = {
    name: "proof.png",
    mime: "image/png",
    data: new Uint8Array([1, 2, 3]),
    source: { id: "F0IMAGE" },
  };

  const result = await transcribeMedia(
    [
      image,
      voice(),
      voice({ name: "clip", mime: "video/mp4", source: { id: "F0VIDEO" } }),
    ],
    f.transcriber,
    5000,
    signal(),
  );

  expect(result.files).toEqual([image]);
  expect(result.blocks).toEqual([
    `[Voice message transcript: file F0VOICE, 68.6 s, machine transcription by Azure OpenAI deployment whisper-transcription. These are the sender's own spoken words. The text can contain recognition errors.]\n${spoken}\n[End of voice message transcript]`,
    `[Voice message transcript: file F0VIDEO, machine transcription by Azure OpenAI deployment whisper-transcription. These are the sender's own spoken words. The text can contain recognition errors.]\n${spoken}\n[End of voice message transcript]`,
  ]);
  expect(f.requests.map((request) => request.name)).toEqual([
    "audio.m4a",
    "audio.mp4",
  ]);
});

test("a complete Slack transcript is used without any provider or identity request", async () => {
  const f = provider();

  const result = await transcribeMedia(
    [voice({ source: { id: "F0VOICE", transcript: " Ship it. " } })],
    f.transcriber,
    5000,
    signal(),
  );

  expect(result).toEqual({
    files: [],
    transcripts: ["Ship it."],
    blocks: [
      "[Voice message transcript: file F0VOICE, machine transcription by Slack. These are the sender's own spoken words. The text can contain recognition errors.]\nShip it.\n[End of voice message transcript]",
    ],
  });
  expect(f.requests).toEqual([]);
  expect(f.tokens).toEqual([]);
});

test("silence and very long speech are marked, not hidden", async () => {
  const f = provider();
  f.state.body = { text: "  \n" };
  expect(
    (await transcribeMedia([voice()], f.transcriber, 5000, signal())).blocks[0],
  ).toContain("\n[No speech detected]\n");
  f.state.body = { text: "a".repeat(maxTranscriptCharacters + 10) };

  const long = (await transcribeMedia([voice()], f.transcriber, 5000, signal()))
    .blocks[0];

  expect(long).toContain(
    `\n${"a".repeat(maxTranscriptCharacters)}\n[Transcript cut at ${maxTranscriptCharacters} characters]\n`,
  );
});

test("unsupported formats, provider errors and timeouts are one fixed refusal", async () => {
  const f = provider();

  for (const file of [
    voice({ name: "note.ogg", mime: "audio/ogg" }),
    voice({ name: "clip.mov", mime: "video/quicktime" }),
    voice({ name: "sound", mime: "audio/flac" }),
  ]) {
    const error = await transcribeMedia(
      [file],
      f.transcriber,
      5000,
      signal(),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TranscriptionUnavailable);
    expect(error instanceof Error ? error.message : undefined).toBe("");
  }

  expect(f.requests).toEqual([]);
  f.state.status = 503;
  await expect(
    transcribeMedia([voice()], f.transcriber, 5000, signal()),
  ).rejects.toBeInstanceOf(TranscriptionUnavailable);
  f.state.status = 200;
  const release = Promise.withResolvers<void>();
  f.state.hold = release.promise;

  try {
    await expect(
      transcribeMedia([voice()], f.transcriber, 50, signal()),
    ).rejects.toBeInstanceOf(TranscriptionUnavailable);
    const stop = new AbortController();

    const waiting = transcribeMedia(
      [voice()],
      f.transcriber,
      5000,
      stop.signal,
    );

    stop.abort(new Error("Stop pressed"));
    await expect(waiting).rejects.toThrow("Stop pressed");
  } finally {
    release.resolve();
  }
});

test("only one provider request runs at a time in the process", async () => {
  const f = provider();
  const release = Promise.withResolvers<void>();
  f.state.hold = release.promise;
  const calls: number[] = [];

  const counting: Transcriber = {
    label: f.transcriber.label,
    async transcribe(file, signal) {
      calls.push(calls.length);

      return f.transcriber.transcribe(file, signal);
    },
  };

  const work = [1, 2, 3].map(() =>
    transcribeMedia([voice()], counting, 5000, signal()),
  );

  await Bun.sleep(50);
  expect(calls).toHaveLength(1);
  release.resolve();
  expect(
    (await Promise.all(work)).map((result) => result.blocks.length),
  ).toEqual([1, 1, 1]);
  expect(f.state.peak).toBe(1);
  expect(f.requests).toHaveLength(3);
});

function gatewayFixture(
  options: { configured?: boolean; supportsAttachments?: boolean } = {},
) {
  const f = provider();
  const store = openStore(":memory:");
  cleanup.push(() => store.close());

  const config = Schema.decodeUnknownSync(botSchema)({
    ...bot(),
    ...(options.configured === false ? {} : { transcription: f.config }),
  });

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
  let downloads = 0;
  const prompts: { text: string; files: readonly Attachment[] }[] = [];
  const posts: string[] = [];
  const failures: RequestFailure[] = [];

  const backend: AgentBackend = {
    ...(options.supportsAttachments === false
      ? {}
      : { supportsAttachments: true }),
    async createSession() {
      return "session";
    },
    async prompt(_session, text, _signal, _onText, _onInput, files = []) {
      prompts.push({ text, files });

      return "Understood.";
    },
    async close() {},
  };

  const slack: TransportDelivery = {
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
    async post(_channel, _thread, text) {
      posts.push(text);
    },
    async failure(_channel, _thread, cause) {
      failures.push(cause);

      return "status";
    },
  };

  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    log,
    options.configured === false ? undefined : f.transcriber,
  );

  cleanup.push(() => gateway.close());

  const accept = (text: string, ts = "1.000", ids = ["F0VOICE"]) => {
    const body = event(text, ts);
    gateway.accept({
      ...body,
      event: {
        ...body.event,
        type: "message",
        channel: "D123",
        channel_type: "im",
        subtype: "file_share",
        files: ids.map((id) => ({ id })),
      },
    });
  };

  const run = async () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];

    if (!job) throw new Error("Missing job");
    await gateway.process(job, signal());

    return job;
  };

  return {
    ...f,
    store,
    gateway,
    prompts,
    posts,
    failures,
    logged,
    accept,
    run,
    downloads: () => downloads,
    setFiles(next: Attachment[]) {
      files = next;
    },
  };
}

test("a voice-only DM reaches the agent as a marked transcript and no media", async () => {
  const f = gatewayFixture();
  f.accept("");
  await f.run();
  expect(f.prompts).toEqual([
    {
      text: `[Voice message transcript: file F0VOICE, 68.6 s, machine transcription by Azure OpenAI deployment whisper-transcription. These are the sender's own spoken words. The text can contain recognition errors.]\n${spoken}\n[End of voice message transcript]`,
      files: [],
    },
  ]);
  expect(f.posts).toEqual(["Understood."]);
  expect(f.failures).toEqual([]);

  // Typed text stays first; an image in the same message still reaches the agent.
  const image: Attachment = {
    name: "proof.png",
    mime: "image/png",
    data: new Uint8Array([1, 2, 3]),
  };

  f.setFiles([image, voice()]);
  f.accept("see the screenshot", "2.000", ["F0IMAGE", "F0VOICE"]);
  await f.run();
  expect(f.failures).toEqual([]);
  expect(f.posts).toHaveLength(2);
  expect(f.prompts[1]?.text).toStartWith(
    "see the screenshot\n\n[Voice message transcript: file F0VOICE",
  );
  expect(f.prompts[1]?.files).toEqual([image]);
});

test("the gateway prefers Slack's transcript and calls no provider", async () => {
  const f = gatewayFixture();
  f.setFiles([voice({ source: { id: "F0VOICE", transcript: "Ship it." } })]);
  f.accept("");
  await f.run();
  expect(f.prompts[0]?.text).toContain(
    "machine transcription by Slack. These are the sender's own spoken words.",
  );
  expect(f.prompts[0]?.text).toContain("\nShip it.\n");
  expect(f.requests).toEqual([]);
  expect(f.tokens).toEqual([]);
});

test("a failed transcription admits no agent turn and asks the user to type", async () => {
  for (const arrange of [
    (f: ReturnType<typeof gatewayFixture>) => {
      f.state.status = 500;
    },
    (f: ReturnType<typeof gatewayFixture>) => {
      f.state.tokenStatus = 403;
    },
    (f: ReturnType<typeof gatewayFixture>) =>
      f.setFiles([voice({ name: "note.ogg", mime: "audio/ogg" })]),
  ]) {
    const f = gatewayFixture();
    arrange(f);
    f.accept("");
    const job = await f.run();
    expect(f.prompts).toEqual([]);
    expect(f.failures).toEqual(["transcription"]);
    expect(f.store.failure(job.id)).toBe("transcription");
    // Finished: no retry repeats the download or the provider request.
    expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)).toEqual(
      [],
    );
    expect(f.downloads()).toBe(1);
  }
});

test("the transcription notice asks for typed text and names the formats", async () => {
  const { failureText } = await import("../src/shared/request-failure");
  const text = failureText("transcription");
  expect(text).toContain("No agent turn was started");
  expect(text).toContain("Please type your message");
  expect(text).toContain("m4a, mp3, mp4, mpeg, mpga, wav and webm");
});

test("an over-limit or unreadable file fails before any provider request", async () => {
  const f = gatewayFixture();
  f.setFiles([voice({ data: new Uint8Array(10 * 1024 * 1024 + 1) })]);
  f.accept("");
  await f.run();
  expect(f.prompts).toEqual([]);
  expect(f.failures).toEqual(["attachments"]);
  expect(f.requests).toEqual([]);
});

test("logs never contain speech, tokens, file names or provider errors", async () => {
  const good = gatewayFixture();
  good.accept("");
  await good.run();
  const bad = gatewayFixture();
  bad.state.status = 500;
  bad.accept("");
  await bad.run();
  const identity = gatewayFixture();
  identity.state.tokenStatus = 500;
  identity.accept("");
  await identity.run();
  const logged = [...good.logged, ...bad.logged, ...identity.logged].join("");
  expect(bad.logged.join("")).toContain("Agent request failed or timed out");

  for (const secret of [
    "SPOKEN_PRIVATE_TEXT",
    "PRIVATE_TOKEN",
    "PRIVATE_PROVIDER_ERROR",
    "PRIVATE_IDENTITY_ERROR",
    "Audio clip",
    "Voice message transcript",
  ])
    expect(logged).not.toContain(secret);
  // The request row keeps the typed text only; the transcript is not stored.
  expect(
    JSON.stringify(good.store.recentJobs(good.gateway.key, 5)),
  ).not.toContain("SPOKEN_PRIVATE_TEXT");
});

test("without the setting audio passes through as before; with it a file-less backend works", async () => {
  const off = gatewayFixture({ configured: false });
  off.accept("");
  await off.run();
  expect(off.prompts).toEqual([{ text: "", files: [voice()] }]);
  expect(off.requests).toEqual([]);
  const textOnly = gatewayFixture({ supportsAttachments: false });
  textOnly.accept("");
  await textOnly.run();
  expect(textOnly.prompts[0]?.files).toEqual([]);
  expect(textOnly.prompts[0]?.text).toContain(spoken);
  // A file that is not speech still needs a backend that accepts files.
  textOnly.setFiles([
    { name: "proof.png", mime: "image/png", data: new Uint8Array([1]) },
    voice(),
  ]);
  textOnly.accept("", "2.000", ["F0IMAGE", "F0VOICE"]);
  await textOnly.run();
  expect(textOnly.prompts).toHaveLength(1);
  expect(textOnly.failures).toEqual(["attachments"]);
  // Refused before the audio was sent to the provider.
  expect(textOnly.requests).toHaveLength(1);
});
