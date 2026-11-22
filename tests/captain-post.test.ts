import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import {
  CaptainPostError,
  CaptainPostStore,
  type PostAudit,
  type PostDependencies,
  postInputSchema,
  runCaptainPost,
} from "../src/captain-post/captain-post";
import { configSchema } from "../src/config";
import type { CrewCaller } from "../src/crew/engine";
import { CrewPost } from "../src/crew/post";
import { CrewError } from "../src/crew/state";
import { settingsIssues } from "../src/settings-schema";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;

test("stored post files remain unbounded while new posts permit at most ten paths", () => {
  const store = new CaptainPostStore(":memory:");
  const file = {
    path: "/report.txt",
    caption: "report",
    name: "report.txt",
    mime: "Text/Plain",
    size: 1,
    sha256: "a".repeat(64),
  };
  const files = Array.from({ length: 11 }, () => ({
    file,
    status: "pending" as const,
  }));
  try {
    store.admit(
      "bot",
      "key",
      {
        channel: "C123",
        thread: null,
        length: 4,
        files,
        fingerprint: "f",
      },
      1000,
      10,
      "owner",
    );
    const stored = store.get("bot", "key");
    expect(stored?.files).toEqual(files);
    expect(Object.keys(stored?.files[0]?.file ?? {})).toEqual([
      "path",
      "caption",
      "name",
      "mime",
      "size",
      "sha256",
    ]);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(postInputSchema)({
          channel: "C123",
          text: "note",
          files: Array(11).fill("/report.txt"),
        }),
      ),
    ).toBe(true);
  } finally {
    store.close();
  }
});

type Call = { method: string; params: URLSearchParams };

type FixtureOptions = {
  channels?: string[];
  deniedChannels?: string[];
  /** Merged over `{ channels: ["C123"], fileDirectories: [files] }`. */
  captainPost?: Record<string, unknown> | false;
  directory?: string;
};

async function fixture(initial: FixtureOptions = {}) {
  // Under TMPDIR (often ~/.cache/tmp): hidden segments above a post
  // directory are allowed; hidden segments below it stay denied.
  const root = await realpath(await mkdtemp(join(tmpdir(), "stargate-post-")));
  directories.push(root);
  const captain = join(root, "captain");
  const files = join(root, "files");
  await mkdir(captain);
  await mkdir(files);
  const configPath = join(root, "stargate.json");
  const writeConfig = (options: FixtureOptions) =>
    writeFile(
      configPath,
      JSON.stringify({
        dataDirectory: "state",
        bots: [
          {
            id: "galactica",
            slack: {
              appId: "A123",
              appTokenEnv: "APP_TOKEN",
              botTokenEnv: "BOT_TOKEN",
            },
            access: {
              users: ["U123"],
              channels: options.channels ?? ["C123", "COPS"],
              deniedChannels: options.deniedChannels ?? [],
            },
            backend: {
              type: "opencode",
              url: "http://127.0.0.1:4096",
              directory: options.directory ?? captain,
              sessionID: "ses_captain",
            },
            ...(options.captainPost === false
              ? {}
              : {
                  captainPost: {
                    channels: ["C123"],
                    fileDirectories: [files],
                    ...options.captainPost,
                  },
                }),
          },
        ],
      }),
    );
  await writeConfig(initial);
  const calls: Call[] = [];
  const uploads: Uint8Array[] = [];
  const audits: PostAudit[] = [];
  let clock = Date.parse("2026-11-13T10:00:00Z");
  let counter = 0;
  const shares = new Map<string, { channel: string; thread: string }>();
  const behaviour: {
    post: (params: URLSearchParams) => unknown;
    complete: (params: URLSearchParams) => unknown;
    upload: (url: URL) => Promise<Response>;
  } = {
    upload: async () => new Response("OK"),
    post: () => ({ ok: true, ts: `1700000000.00010${counter++}` }),
    complete: (params) => {
      const [file] = JSON.parse(params.get("files") ?? "[]") as {
        id: string;
      }[];
      shares.set(file?.id ?? "", {
        channel: params.get("channel_id") ?? "",
        thread: params.get("thread_ts") ?? "",
      });
      return { ok: true, files: [{ id: file?.id }] };
    },
  };
  let uploadID = 0;
  const fetch: PostDependencies["fetch"] = async (url, init) => {
    const target = new URL(url);
    if (target.origin === "https://files.slack.com") {
      uploads.push(new Uint8Array(init?.body as ArrayBuffer));
      return behaviour.upload(target);
    }
    const method = target.pathname.replace("/api/", "");
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, params });
    const json = (value: unknown) => {
      if (value instanceof Error) throw value;
      return Response.json(value);
    };
    switch (method) {
      case "auth.test":
        return json({ ok: true, bot_id: "B1", team_id: "T1", user_id: "UB" });
      case "chat.postMessage":
        return json(behaviour.post(params));
      case "chat.getPermalink":
        return json({
          ok: true,
          permalink: `https://example.slack.com/archives/${params.get("channel")}/p${params.get("message_ts")?.replace(".", "")}`,
        });
      case "files.getUploadURLExternal":
        uploadID++;
        return json({
          ok: true,
          file_id: `F${uploadID}`,
          upload_url: `https://files.slack.com/upload/v1/F${uploadID}`,
        });
      case "files.completeUploadExternal":
        return json(behaviour.complete(params));
      case "files.info": {
        const id = params.get("file") ?? "";
        const share = shares.get(id);
        return json({
          ok: true,
          file: {
            id,
            shares: share
              ? { public: { [share.channel]: [{ ts: share.thread }] } }
              : {},
          },
        });
      }
    }
    throw new Error(`Unexpected Slack method ${method}`);
  };
  const dependencies: PostDependencies = {
    now: () => clock,
    token: async () => "test-bot-token",
    fetch,
    audit: (entry) => audits.push(entry),
  };
  const binding = {
    configPath,
    bot: "galactica",
    expectedDirectory: captain,
    captainSessionID: "ses_captain",
  };
  const post = (input: Record<string, unknown>, stop = signal()) =>
    runCaptainPost(input, binding, stop, dependencies);
  const posts = () =>
    calls.filter(({ method }) => method === "chat.postMessage");
  return {
    root,
    captain,
    files,
    binding,
    dependencies,
    calls,
    posts,
    uploads,
    audits,
    behaviour,
    post,
    writeConfig,
    count: (method: string) =>
      calls.filter((call) => call.method === method).length,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("posts top-level markdown as the bound bot and returns its permalink", async () => {
  const f = await fixture();
  const result = await f.post({
    channel: "C123",
    text: "Release *ready* for <@U0ABC>",
    key: "call_1",
  });
  expect(result).toMatchObject({
    status: "posted",
    channel: "C123",
    ts: "1700000000.000100",
    permalink: "https://example.slack.com/archives/C123/p1700000000000100",
    replay: false,
    files: [],
  });
  const [sent] = f.posts();
  expect(sent?.params.get("channel")).toBe("C123");
  expect(sent?.params.has("thread_ts")).toBe(false);
  // Mentions survive as Slack user elements, not escaped text.
  expect(sent?.params.get("blocks")).toContain("U0ABC");
  expect(f.audits).toEqual([
    {
      event: "stargate_post",
      bot: "galactica",
      channel: "C123",
      thread: null,
      ts: "1700000000.000100",
      length: 28,
      files: 0,
      status: "posted",
      replay: false,
    },
  ]);
  expect(JSON.stringify(f.audits)).not.toContain("Release");
});

test("replies in a thread and broadcasts only when asked", async () => {
  const f = await fixture();
  await f.post({ channel: "C123", thread_ts: "1699.000001", text: "quiet" });
  await f.post({
    channel: "C123",
    thread_ts: "1699.000001",
    text: "loud",
    reply_broadcast: true,
  });
  const [quiet, loud] = f.posts();
  expect(quiet?.params.get("thread_ts")).toBe("1699.000001");
  expect(quiet?.params.get("reply_broadcast")).toBe("false");
  expect(loud?.params.get("reply_broadcast")).toBe("true");
  await expect(
    f.post({ channel: "C123", text: "x", reply_broadcast: true }),
  ).rejects.toThrow("Invalid stargate_post input");
});

test("posts need captainPost.channels and inbound access; denies override", async () => {
  const f = await fixture({
    channels: ["*"],
    deniedChannels: ["CSECRET"],
    captainPost: { channels: ["C123", "CSECRET", "D777", "GMPIM1"] },
  });
  // Inbound `*` never widens outbound posting; DMs and group DMs need an ID.
  for (const channel of ["CSECRET", "CUNLISTED", "D999", "GMPIM2"])
    await expect(
      f.post({ channel, text: "hello", key: channel }),
    ).rejects.toThrow("not allowed");
  expect(f.calls).toHaveLength(0);
  for (const channel of ["C123", "D777", "GMPIM1"])
    await f.post({ channel, text: "hello" });
  expect(f.posts().map(({ params }) => params.get("channel"))).toEqual([
    "C123",
    "D777",
    "GMPIM1",
  ]);
  // No conversation lookup or extra scope is used.
  expect(f.count("conversations.info")).toBe(0);

  const narrow = await fixture({
    channels: ["C123"],
    captainPost: { channels: ["C123", "COPS"] },
  });
  await expect(narrow.post({ channel: "COPS", text: "x" })).rejects.toThrow(
    "not allowed",
  );
  expect(narrow.calls).toHaveLength(0);
});

test("disabled bots and mismatched bindings refuse before Slack", async () => {
  const off = await fixture({ captainPost: false });
  await expect(off.post({ channel: "C123", text: "x" })).rejects.toThrow(
    "stargate_post is off",
  );
  const f = await fixture();
  for (const binding of [
    { ...f.binding, expectedDirectory: "/other" },
    { ...f.binding, captainSessionID: "ses_other" },
    { ...f.binding, bot: "other" },
  ])
    await expect(
      runCaptainPost(
        { channel: "C123", text: "x" },
        binding,
        signal(),
        f.dependencies,
      ),
    ).rejects.toThrow(CaptainPostError);
  expect(off.calls).toHaveLength(0);
  expect(f.calls).toHaveLength(0);
});

test("a retry with the same key returns the recorded post without resending", async () => {
  const f = await fixture();
  const input = { channel: "C123", text: "once", key: "call_retry" };
  const first = await f.post(input);
  const second = await f.post(input);
  expect(f.posts()).toHaveLength(1);
  expect(second).toMatchObject({
    status: "posted",
    ts: (first as { ts: string }).ts,
    replay: true,
    effect: "already-posted-not-resent",
  });
  await expect(f.post({ ...input, text: "different" })).rejects.toThrow(
    "different post",
  );
  expect(f.posts()).toHaveLength(1);
});

test("uncertain sends are reported and never resent", async () => {
  const f = await fixture();
  f.behaviour.post = () => new TypeError("connection reset");
  const input = { channel: "C123", text: "maybe", key: "call_lost" };
  expect(await f.post(input)).toMatchObject({
    status: "uncertain",
    effect: "outcome-unconfirmed-not-resent",
  });
  f.behaviour.post = () => ({ ok: true, ts: "1.2" });
  expect(await f.post(input)).toMatchObject({
    status: "uncertain",
    replay: true,
  });
  expect(f.posts()).toHaveLength(1);
});

test("Slack refusals are definite failures and not retried", async () => {
  const f = await fixture();
  f.behaviour.post = () => ({ ok: false, error: "not_in_channel" });
  const input = { channel: "C123", text: "hi", key: "call_refused" };
  expect(await f.post(input)).toMatchObject({
    status: "failed",
    error: "not_in_channel",
  });
  expect(await f.post(input)).toMatchObject({ status: "failed", replay: true });
  expect(f.posts()).toHaveLength(1);
});

test("rolling hourly limit is per bot and retries do not count", async () => {
  const f = await fixture({
    captainPost: { postsPerHour: 2, fileDirectories: [] },
  });
  await f.post({ channel: "C123", text: "1", key: "a" });
  await f.post({ channel: "C123", text: "1", key: "a" });
  await f.post({ channel: "C123", text: "2", key: "b" });
  await expect(
    f.post({ channel: "C123", text: "3", key: "c" }),
  ).rejects.toThrow("rate limit reached (2 per hour");
  expect(f.posts()).toHaveLength(2);
  f.advance(3_600_001);
  await f.post({ channel: "C123", text: "3", key: "c" });
  expect(f.posts()).toHaveLength(3);
});

test("files must be canonical regular files inside post directories", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside.txt");
  await writeFile(outside, "private");
  const linked = join(f.files, "linked.txt");
  await symlink(outside, linked);
  const hidden = join(f.files, ".hidden.txt");
  await writeFile(hidden, "hidden");
  for (const path of [outside, linked, hidden, "relative.txt"])
    await expect(
      f.post({ channel: "C123", text: "proof", files: [path] }),
    ).rejects.toThrow("nothing was posted");
  expect(f.calls.filter(({ method }) => method !== "auth.test")).toHaveLength(
    0,
  );

  const off = await fixture({ captainPost: { fileDirectories: [] } });
  await writeFile(join(off.files, "a.txt"), "a");
  await expect(
    off.post({
      channel: "C123",
      text: "proof",
      files: [join(off.files, "a.txt")],
    }),
  ).rejects.toThrow("outside this captain's post directories");
});

test("files upload into the new message's thread and resume on retry", async () => {
  const f = await fixture();
  const report = join(f.files, "report.txt");
  const second = join(f.files, "second.txt");
  await writeFile(report, "report body");
  await writeFile(second, "second body");
  let completions = 0;
  const complete = f.behaviour.complete;
  f.behaviour.complete = (params) => {
    completions++;
    return completions === 2
      ? { ok: false, error: "internal_error" }
      : complete(params);
  };
  const input = {
    channel: "C123",
    text: "See files",
    files: [report, second],
    key: "call_files",
  };
  const result = await f.post(input);
  expect(result).toMatchObject({
    status: "partial",
    ts: "1700000000.000100",
    files: [
      { name: "report.txt", status: "shared" },
      { name: "second.txt", status: "unconfirmed" },
    ],
  });
  const share = f.calls.find(
    ({ method }) => method === "files.completeUploadExternal",
  );
  expect(share?.params.get("thread_ts")).toBe("1700000000.000100");
  expect(new TextDecoder().decode(f.uploads[0])).toBe("report body");
  // Unconfirmed completion is checked, not completed again.
  expect(await f.post(input)).toMatchObject({
    status: "partial",
    files: [
      { name: "report.txt", status: "shared" },
      { name: "second.txt", status: "unconfirmed" },
    ],
  });
  expect(completions).toBe(2);
  expect(f.posts()).toHaveLength(1);
  expect(f.audits.at(-1)).toMatchObject({ files: 2, replay: true });
});

test("captainPost config needs explicit channels and an OpenCode backend", () => {
  const check = (captainPost: unknown, type = "opencode") =>
    Schema.decodeUnknownResult(configSchema)({
      bots: [
        {
          id: "captain",
          slack: { appId: "A1", appTokenEnv: "A", botTokenEnv: "B" },
          access: { users: ["U1"], channels: ["*"] },
          backend:
            type === "opencode"
              ? { type, url: "http://127.0.0.1:4096", directory: "/srv/c" }
              : { type, module: "/srv/module.ts" },
          captainPost,
        },
      ],
    });
  expect(Result.isSuccess(check({ channels: ["C1", "G2", "D3"] }))).toBe(true);
  expect(Result.isSuccess(check({ channels: ["C1"] }, "module"))).toBe(false);
  for (const invalid of [{}, { channels: [] }, { channels: ["#general"] }])
    expect(Result.isSuccess(check(invalid))).toBe(false);
  const wildcard = check({ channels: ["*"] });
  expect(Result.isSuccess(wildcard)).toBe(false);
  if (Result.isFailure(wildcard))
    expect(
      JSON.stringify(settingsIssues(wildcard.failure.issue).issues),
    ).toContain("* is not accepted");
});

function crew() {
  const calls: { raw: unknown; binding: unknown }[] = [];
  const authority = {
    options: {
      captainDirectory: "/captain",
      captainSessionID: "ses_captain",
      cron: { configPath: "/private/stargate.json", bot: "galactica" },
    },
    async captain(caller: CrewCaller) {
      if (caller.agent !== "adama") throw new CrewError("Captain only.");
    },
  };
  const runner = (async (raw: unknown, binding: unknown) => {
    calls.push({ raw, binding });
    return { status: "posted" };
  }) as unknown as typeof runCaptainPost;
  const caller: CrewCaller = {
    agent: "adama",
    sessionID: "ses_captain",
    id: "call_tool",
    signal: signal(),
  };
  return { calls, authority, runner, caller };
}

test("crew members cannot post and binding fields cannot be injected", async () => {
  const c = crew();
  const post = new CrewPost(c.authority, c.runner);
  await expect(
    post.run({ channel: "C123", text: "x" }, { ...c.caller, agent: "apollo" }),
  ).rejects.toThrow("Captain only.");
  await expect(
    post.run(
      { channel: "C123", text: "x", configPath: "/other.json" },
      c.caller,
    ),
  ).rejects.toThrow("Invalid stargate_post input");
  expect(c.calls).toHaveLength(0);
  await post.run({ channel: "C123", text: "x" }, c.caller);
  await post.run({ channel: "C123", text: "x", key: "explicit" }, c.caller);
  expect(c.calls).toEqual([
    {
      raw: {
        channel: "C123",
        text: "x",
        files: [],
        reply_broadcast: false,
        key: "call_tool",
      },
      binding: {
        configPath: "/private/stargate.json",
        bot: "galactica",
        expectedDirectory: "/captain",
        captainSessionID: "ses_captain",
      },
    },
    expect.objectContaining({
      raw: expect.objectContaining({ key: "explicit" }),
    }),
  ]);
  const unbound = new CrewPost(
    { ...c.authority, options: { captainDirectory: "/captain" } },
    c.runner,
  );
  await expect(
    unbound.run({ channel: "C123", text: "x" }, c.caller),
  ).rejects.toThrow("stargate_post unavailable");
});

test("default file roots follow OpenCode's tmpdir rule at call time", async () => {
  const f = await fixture({ captainPost: { fileDirectories: undefined } });
  const previous = process.env["TMPDIR"];
  const scratch = join(f.root, ".cache", "tmp");
  const opencode = join(scratch, "opencode");
  await mkdir(join(opencode, ".git"), { recursive: true });
  await writeFile(join(opencode, "proof.txt"), "proof");
  await writeFile(join(opencode, ".git", "config"), "private");
  await writeFile(join(f.captain, "notes.txt"), "notes");
  await writeFile(join(f.files, "elsewhere.txt"), "elsewhere");
  process.env["TMPDIR"] = scratch;
  try {
    expect(
      await f.post({
        channel: "C123",
        text: "proof",
        files: [join(opencode, "proof.txt"), join(f.captain, "notes.txt")],
      }),
    ).toMatchObject({
      status: "posted",
      files: [
        { name: "proof.txt", status: "shared" },
        { name: "notes.txt", status: "shared" },
      ],
    });
    for (const path of [
      join(opencode, ".git", "config"),
      join(f.files, "elsewhere.txt"),
    ])
      await expect(
        f.post({ channel: "C123", text: "x", files: [path] }),
      ).rejects.toThrow("nothing was posted");
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
  }
  expect(f.posts()).toHaveLength(1);
});

test("concurrent same-key retries never upload one file twice", async () => {
  const f = await fixture();
  const path = join(f.files, "report.txt");
  await writeFile(path, "report body");
  const input = { channel: "C123", text: "files", files: [path], key: "k" };
  f.behaviour.upload = async () => new Response("no", { status: 500 });
  expect(await f.post(input)).toMatchObject({
    status: "partial",
    files: [{ status: "not-shared" }],
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: (() => void)[] = [];
  const putStarted = [0, 1].map(
    (index) =>
      new Promise<void>((resolve) => {
        started[index] = resolve;
      }),
  );
  let puts = 0;
  f.behaviour.upload = async () => {
    started[puts++]?.();
    await gate;
    return new Response("OK");
  };
  const first = f.post(input);
  await putStarted[0];
  const second = f.post(input);
  // Without an ownership claim the second caller would also reach the PUT.
  await Promise.race([second, putStarted[1]]);
  release();
  const results = await Promise.all([first, second]);
  expect(f.count("files.completeUploadExternal")).toBe(1);
  expect(results[0]).toMatchObject({ files: [{ status: "shared" }] });
  expect(results[1]).toMatchObject({ files: [{ status: "in-progress" }] });
  expect(await f.post(input)).toMatchObject({
    status: "posted",
    files: [{ status: "shared" }],
  });
  expect(f.count("files.completeUploadExternal")).toBe(1);
});

test("an abandoned upload claim is reclaimed only after its lease expires", async () => {
  const { CaptainPostStore } = await import("../src/captain-post/captain-post");
  const store = new CaptainPostStore(":memory:");
  store.admit(
    "bot",
    "key",
    { channel: "C1", thread: null, length: 1, files: [], fingerprint: "f" },
    1000,
    10,
    "owner-a",
  );
  expect(store.claim("bot", "key", "owner-b", 2000)).toBe(false);
  expect(store.claim("bot", "key", "owner-a", 2000)).toBe(true);
  store.release("bot", "key", "owner-a");
  expect(store.claim("bot", "key", "owner-b", 3000)).toBe(true);
  expect(store.claim("bot", "key", "owner-c", 3000 + 299_999)).toBe(false);
  expect(store.claim("bot", "key", "owner-c", 3000 + 300_001)).toBe(true);
  store.close();
});

test("retries re-check files against the current post directories", async () => {
  const f = await fixture();
  const path = join(f.files, "report.txt");
  await writeFile(path, "report body");
  const input = { channel: "C123", text: "files", files: [path], key: "k" };
  f.behaviour.upload = async () => new Response("no", { status: 500 });
  await f.post(input);
  const reserved = f.count("files.getUploadURLExternal");
  f.behaviour.upload = async () => new Response("OK");
  await f.writeConfig({ captainPost: { fileDirectories: [] } });
  expect(await f.post(input)).toMatchObject({
    status: "partial",
    files: [{ status: "unavailable" }],
  });
  expect(f.count("files.getUploadURLExternal")).toBe(reserved);
  expect(f.count("files.completeUploadExternal")).toBe(0);
});
