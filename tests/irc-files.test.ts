import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import pino from "pino";
import {
  maxAttachmentBytes,
  UploadRefused,
} from "../src/attachments/attachments";
import type {
  AgentBackend,
  PromptSourceContext,
} from "../src/backends/backend";
import { type IrcConfig, ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { Filehost, filehostURL } from "../src/irc/filehost";
import { fold, parseMessage } from "../src/irc/protocol";
import { routeIrcMessage } from "../src/irc/routing";
import { IrcShip } from "../src/irc/ship";
import { Store } from "../src/gateway/store";
import type { Transcriber } from "../src/transcription/transcription";
import { publishedFileDirectory } from "./file-fixture";
import { FakeFilehost, FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const accounts = { galactica: "captain-pass", jack: "jack-pass" };
const env = { STARGATE_IRC_GALACTICA: "captain-pass" };
const backend = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/workspace",
};

function filehostServer() {
  const host = new FakeFilehost(accounts).start();
  cleanup.push(() => host.stop());
  return host;
}

function shipConfig(port: number, server: Record<string, unknown> = {}) {
  return Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port, tls: false, ...server },
    account: "galactica",
    passwordEnv: "STARGATE_IRC_GALACTICA",
    channels: ["#galactica"],
    backend: { ...backend, sessionID: "ses_captain" },
  });
}

type Prompt = {
  text: string;
  files: { name: string; mime: string; text: string }[];
  context?: PromptSourceContext;
};

async function ship(
  options: {
    isupport?: (host: FakeFilehost) => string[];
    server?: (host: FakeFilehost) => Record<string, unknown>;
    transcriber?: Transcriber;
    answer?: string | ((directory: string) => string);
    features?: Record<string, boolean>;
  } = {},
) {
  const host = filehostServer();
  const fake = new FakeIrcServer({
    accounts,
    isupport: options.isupport?.(host) ?? [
      `soju.im/FILEHOST=${host.uploadURL}`,
    ],
  }).start();
  cleanup.push(() => fake.stop());
  // Published files use configured OpenCode scratch, including hidden TMPDIR.
  const directory = await publishedFileDirectory("stargate-irc-files-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  const config = Schema.decodeUnknownSync(ircSchema)({
    ...shipConfig(fake.port, options.server?.(host)),
    ...(options.features ? { features: options.features } : {}),
  });
  const created = await IrcShip.create(
    config,
    store,
    pino({ level: "silent" }),
    {
      env,
      timing: { reconnectMinMs: 20, intervalMs: 5, burst: 20 },
      readyMs: 2000,
    },
  );
  const prompts: Prompt[] = [];
  const agent: AgentBackend = {
    sessionID: "ses_captain",
    supportsAttachments: true,
    async createSession() {
      return "ses_captain";
    },
    async prompt(_s, text, _signal, _onText, _onInput, files, context) {
      prompts.push({
        text,
        files: (files ?? []).map((file) => ({
          name: file.name,
          mime: file.mime,
          text: new TextDecoder().decode(file.data),
        })),
        ...(context ? { context } : {}),
      });
      return typeof options.answer === "function"
        ? options.answer(directory)
        : (options.answer ?? "[[stargate:silent]]");
    },
    async close() {},
  };
  const [captain] = created.registrations;
  if (!captain) throw new Error("missing captain");
  // One gateway lifetime; `crash` ends it as a process stop would.
  const lifetime = () => {
    const controller = new AbortController();
    const worker = new Gateway(
      captain.settings,
      captain.identity,
      store,
      agent,
      captain.delivery,
      captain.log,
      options.transcriber,
      undefined,
      captain.transport,
    ).work(controller.signal);
    return async () => {
      controller.abort();
      await worker;
    };
  };
  let stop = lifetime();
  created.start(() => true);
  cleanup.push(async () => {
    await stop();
    await created.close();
  });
  await until(() => captain.client.inChannel("#galactica"), 5000, "joined");
  return {
    host,
    fake,
    store,
    captain,
    prompts,
    directory,
    crash: async () => {
      await stop();
      stop = lifetime();
    },
  };
}

test("irc filehost URL: https, or http only on loopback over plaintext IRC", () => {
  expect(filehostURL("https://irc.example/upload", false)?.href).toBe(
    "https://irc.example/upload",
  );
  expect(filehostURL("https://irc.example/upload", true)?.href).toBe(
    "https://irc.example/upload",
  );
  expect(filehostURL("http://127.0.0.1:8080/upload", false)?.origin).toBe(
    "http://127.0.0.1:8080",
  );
  // Plain http is refused over TLS IRC (spec) and off loopback.
  expect(filehostURL("http://127.0.0.1:8080/upload", true)).toBeUndefined();
  expect(filehostURL("http://irc.example/upload", false)).toBeUndefined();
  expect(filehostURL("https://u:p@irc.example/upload", false)).toBeUndefined();
  expect(filehostURL("ftp://irc.example/upload", false)).toBeUndefined();
  expect(filehostURL("not a url", false)).toBeUndefined();
});

test("irc files in: only the FILEHOST origin, with SASL credentials, bounded", async () => {
  const host = filehostServer();
  const filehost = new Filehost(() => new URL(host.uploadURL), {
    account: "galactica",
    password: "captain-pass",
  });
  const note = host.put("/files/note.txt", {
    name: "note.txt",
    type: "text/plain; charset=utf-8",
    body: new TextEncoder().encode("fuel at 40%"),
  });
  const page = host.put("/files/report.html", {
    name: "report.html",
    type: "text/html",
    body: new TextEncoder().encode("<html><script>x()</script></html>"),
  });
  const signal = AbortSignal.timeout(5000);
  const files = await filehost.download([note, page], signal);
  expect(files.map(({ name, mime }) => ({ name, mime }))).toEqual([
    { name: "note.txt", mime: "text/plain" },
    // HTML is passed as source text, never as renderable HTML.
    { name: "report.html", mime: "text/plain" },
  ]);
  expect(new TextDecoder().decode(files[0]?.data)).toBe("fuel at 40%");
  expect(host.requests.map((r) => [r.method, r.path, r.user])).toEqual([
    ["GET", "/files/note.txt", "galactica"],
    ["GET", "/files/report.html", "galactica"],
  ]);
  // Another origin is never fetched; nor a redirect followed.
  await expect(
    filehost.download(["https://elsewhere.example/files/x"], signal),
  ).rejects.toThrow();
  await expect(
    filehost.download([`${host.origin}/redirect`], signal),
  ).rejects.toThrow();
  await expect(
    filehost.download([`${host.origin}/files/missing`], signal),
  ).rejects.toThrow();
  const big = host.put("/files/big.bin", {
    name: "big.bin",
    type: "application/octet-stream",
    body: new Uint8Array(maxAttachmentBytes + 1),
  });
  await expect(filehost.download([big], signal)).rejects.toThrow();
  expect(host.requests.map((r) => r.path)).not.toContain("/x");
});

test("irc files in: routing keeps only FILEHOST links of an admitted message", () => {
  const config: IrcConfig = shipConfig(6667);
  const filehost = new URL("https://files.fleet.example/upload");
  const message = parseMessage(
    "@account=jack;msgid=m1 :jack!u@h PRIVMSG #galactica :galactica: see https://files.fleet.example/f/a.png, https://evil.example/f/b.png and (https://files.fleet.example/f/c.md).",
  );
  if (!message) throw new Error("fixture");
  const admission = routeIrcMessage(message, {
    config,
    member: {
      id: "galactica-irc",
      role: "captain",
      account: "galactica",
      nick: "galactica",
      channels: ["#galactica"],
      key: "k",
    },
    currentNick: "galactica",
    sent: () => false,
    now: () => 0,
    fold: (value) => fold(value),
    filehost,
  });
  expect(admission?.files).toEqual([
    "https://files.fleet.example/f/a.png",
    "https://files.fleet.example/f/c.md",
  ]);
  // The text keeps every link, so the agent still sees what was shared.
  expect(admission?.text).toContain("https://evil.example/f/b.png");
});

test("irc files in: a FILEHOST link reaches the backend as an attachment", async () => {
  const { host, fake, prompts } = await ship();
  const url = host.put("/files/log.txt", {
    name: "log.txt",
    type: "text/plain",
    body: new TextEncoder().encode("line one"),
  });
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    `galactica: read ${url} and https://evil.example/x.txt`,
  );
  await until(() => prompts.length === 1, 5000, "prompt");
  expect(prompts[0]?.files).toEqual([
    { name: "log.txt", mime: "text/plain", text: "line one" },
  ]);
  expect(host.requests.every((r) => r.user === "galactica")).toBe(true);
});

test("irc files in: audio goes through transcription like Slack voice notes", async () => {
  const transcriber: Transcriber = {
    label: "Test speech",
    async transcribe() {
      return "status report please";
    },
  };
  const { host, fake, prompts } = await ship({ transcriber });
  const url = host.put("/files/voice.m4a", {
    name: "voice.m4a",
    type: "audio/mp4",
    body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  });
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    `galactica: ${url}`,
  );
  await until(() => prompts.length === 1, 5000, "prompt");
  expect(prompts[0]?.files).toEqual([]);
  expect(prompts[0]?.text).toContain("status report please");
});

test("irc files in: filehostOverride applies only without a conflicting ISUPPORT", async () => {
  const absent = await ship({
    isupport: () => [],
    server: (host) => ({ filehostOverride: host.uploadURL }),
  });
  const url = absent.host.put("/files/a.txt", {
    name: "a.txt",
    type: "text/plain",
    body: new TextEncoder().encode("override"),
  });
  absent.fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    `galactica: ${url}`,
  );
  await until(() => absent.prompts.length === 1, 5000, "prompt");
  expect(absent.prompts[0]?.files.map((f) => f.text)).toEqual(["override"]);

  // The server advertises another origin than the override: files are off.
  const conflict = await ship({
    isupport: () => ["soju.im/FILEHOST=https://other.example/upload"],
    server: (host) => ({ filehostOverride: host.uploadURL }),
  });
  const other = conflict.host.put("/files/b.txt", {
    name: "b.txt",
    type: "text/plain",
    body: new TextEncoder().encode("never"),
  });
  conflict.fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    `galactica: ${other}`,
  );
  await until(() => conflict.prompts.length === 1, 5000, "prompt");
  expect(conflict.prompts[0]?.files).toEqual([]);
  expect(conflict.host.requests).toHaveLength(0);
  expect(lineOf(conflict.fake.received("galactica"), "PRIVMSG")).toHaveLength(
    0,
  );
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...shipConfig(6667),
        server: {
          host: "127.0.0.1",
          port: 6667,
          tls: false,
          filehostOverride: "http://files.example/upload",
        },
      }),
    ),
  ).toBe(false);
});

const openssl =
  spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

test.skipIf(!openssl)(
  "irc files in: HTTPS FILEHOST verified with the configured CA",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-filehost-tls-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const run = (...args: string[]) => {
      if (
        spawnSync("openssl", args, { cwd: directory, stdio: "ignore" }).status
      )
        throw new Error("openssl failed");
    };
    run(
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "1",
      "-subj",
      "/CN=Stargate Test CA",
    );
    run(
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-subj",
      "/CN=127.0.0.1",
    );
    await writeFile(
      join(directory, "ext.cnf"),
      "subjectAltName=IP:127.0.0.1\n",
    );
    run(
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "server.pem",
      "-days",
      "1",
      "-extfile",
      "ext.cnf",
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        cert: Bun.file(join(directory, "server.pem")),
        key: Bun.file(join(directory, "server.key")),
      },
      fetch: () =>
        new Response("secure", { headers: { "content-type": "text/plain" } }),
    });
    cleanup.push(() => server.stop(true));
    const url = `https://127.0.0.1:${server.port}/files/s.txt`;
    const upload = new URL(`https://127.0.0.1:${server.port}/upload`);
    const ca = await Bun.file(join(directory, "ca.pem")).text();
    const trusted = new Filehost(() => upload, {
      account: "galactica",
      password: "captain-pass",
      ca,
    });
    const [file] = await trusted.download([url], AbortSignal.timeout(5000));
    expect(new TextDecoder().decode(file?.data)).toBe("secure");
    const untrusted = new Filehost(() => upload, {
      account: "galactica",
      password: "captain-pass",
    });
    await expect(
      untrusted.download([url], AbortSignal.timeout(5000)),
    ).rejects.toThrow();
  },
);

async function published(directory: string) {
  const path = join(directory, "report.md");
  await writeFile(path, "# Fuel\n\nAll tanks at 40%.\n");
  return `Done.\n\n![Fuel report](file://${path})`;
}

test("irc files out: a Location with credentials or on another origin is refused", async () => {
  const host = filehostServer();
  const filehost = new Filehost(() => new URL(host.uploadURL), {
    account: "galactica",
    password: "captain-pass",
  });
  const file = {
    name: "report.md",
    mime: "text/markdown",
    data: new TextEncoder().encode("# Fuel"),
  };
  const signal = AbortSignal.timeout(5000);
  const port = new URL(host.origin).port;
  for (const location of [
    `http://user:secret@127.0.0.1:${port}/files/1`,
    `http://user@127.0.0.1:${port}/files/1`,
    "https://elsewhere.example/files/1",
    `http://127.0.0.1:${Number(port) + 1}/files/1`,
    `http://localhost:${port}/files/1`,
  ]) {
    host.uploadLocation = location;
    const result = await filehost.upload(file, signal).then(
      (url) => url,
      (error: unknown) => (error instanceof Error ? error : new Error("?")),
    );
    expect(result).toBeInstanceOf(Error);
    // The error never carries the URL or its credentials.
    expect(String(result)).not.toContain("secret");
  }
  host.uploadLocation = undefined;
  expect(await filehost.upload(file, signal)).toStartWith(
    `${host.origin}/files/`,
  );
});

test("irc files out: upload to FILEHOST, then one link line per file", async () => {
  let answer = "";
  const { host, fake, store, captain, directory } = await ship({
    answer: () => answer,
  });
  answer = await published(directory);
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: report",
  );
  await until(
    () => store.queueCounts(captain.key).done === 1,
    5000,
    "delivered",
  );
  const lines = lineOf(fake.received("galactica"), "PRIVMSG").map(
    (m) => m.params[1],
  );
  const [upload] = host.requests.filter((r) => r.method === "POST");
  expect(upload).toMatchObject({
    path: "/upload",
    user: "galactica",
    disposition: 'attachment; filename="report.md"',
  });
  expect(upload?.type).toStartWith("text/markdown");
  const [path] = [...host.files.keys()];
  // The caption stays in the reply text, as on Slack; the link follows.
  expect(lines).toEqual([
    "Done.",
    "Fuel report",
    `Fuel report: ${host.origin}${path}`,
  ]);
  expect(new TextDecoder().decode(host.files.get(path ?? "")?.body)).toContain(
    "All tanks at 40%.",
  );
});

test("irc files out: a recorded upload is never repeated on a delivery retry", async () => {
  let answer = "";
  const { host, fake, store, captain, directory } = await ship({
    answer: () => answer,
  });
  answer = await published(directory);
  // The upload succeeds; posting its link fails once.
  host.onUpload = () => {
    fake.refuse.add("galactica #galactica");
  };
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: report",
  );
  await until(
    () => host.requests.some((r) => r.method === "POST"),
    5000,
    "upload",
  );
  await until(
    () => store.queueCounts(captain.key).responding === 1,
    5000,
    "retry pending",
  );
  host.onUpload = undefined;
  fake.refuse.clear();
  await until(() => store.queueCounts(captain.key).done === 1, 8000, "retried");
  expect(host.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  const links = lineOf(fake.received("galactica"), "PRIVMSG").filter((m) =>
    m.params[1]?.startsWith("Fuel report: "),
  );
  expect(links.length).toBeGreaterThanOrEqual(1);
}, 15_000);

test("irc files out: an upload cut off by a crash is never repeated", async () => {
  let answer = "";
  const { host, fake, store, captain, directory, crash } = await ship({
    answer: () => answer,
  });
  answer = await published(directory);
  // The FILEHOST stores the file, but Stargate stops before the answer.
  const stored = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  host.onUpload = () => {
    stored.resolve();
    return hold.promise;
  };
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: report",
  );
  await stored.promise;
  await crash();
  hold.resolve();
  host.onUpload = undefined;
  await until(() => store.queueCounts(captain.key).done === 1, 8000, "done");
  // Stargate cannot know whether the upload exists: no second upload, a notice.
  expect(host.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  expect(
    lineOf(fake.received("galactica"), "PRIVMSG").map((m) => m.params[1]),
  ).toEqual([
    "Done.",
    "Fuel report",
    "An attachment is unavailable or its upload is unconfirmed. The agent work was not rerun.",
  ]);
}, 15_000);

/** One published file whose first upload is answered with `status`. */
async function firstUploadAnswered(status: number) {
  let answer = "";
  const run = await ship({ answer: () => answer });
  answer = await published(run.directory);
  run.host.failUploads = 1;
  run.host.failStatus = status;
  run.fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: report",
  );
  await until(
    () => run.store.queueCounts(run.captain.key).done === 1,
    8000,
    `done after ${status}`,
  );
  return {
    posts: run.host.requests.filter((r) => r.method === "POST").length,
    stored: run.host.files.size,
    lines: lineOf(run.fake.received("galactica"), "PRIVMSG").map(
      (m) => m.params[1],
    ),
    link: `Fuel report: ${run.host.origin}${[...run.host.files.keys()].at(-1)}`,
  };
}

test("irc files out: an upload the FILEHOST refused is tried again", async () => {
  for (const result of await Promise.all(
    [400, 401, 403, 413, 415].map(firstUploadAnswered),
  )) {
    expect(result.posts).toBe(2);
    expect(result.stored).toBe(1);
    expect(result.lines).toContain(result.link);
  }
}, 20_000);

test("irc files out: a 5xx answer is uncertain; the upload is never repeated", async () => {
  for (const result of await Promise.all(
    [500, 502, 504].map(firstUploadAnswered),
  )) {
    // The FILEHOST stored the file before failing: one POST, one copy.
    expect(result.posts).toBe(1);
    expect(result.stored).toBe(1);
    expect(result.lines).toEqual([
      "Done.",
      "Fuel report",
      "An attachment is unavailable or its upload is unconfirmed. The agent work was not rerun.",
    ]);
  }
}, 20_000);

test("irc files out: only proven refusals are UploadRefused", async () => {
  const host = filehostServer();
  const filehost = new Filehost(() => new URL(host.uploadURL), {
    account: "galactica",
    password: "captain-pass",
  });
  const file = {
    name: "report.md",
    mime: "text/markdown",
    data: new TextEncoder().encode("# Fuel"),
  };
  const outcome = async (setup: () => void) => {
    setup();
    try {
      await filehost.upload(file, AbortSignal.timeout(5000));
      return "stored";
    } catch (error) {
      return error instanceof UploadRefused ? "refused" : "uncertain";
    } finally {
      host.uploadLocation = undefined;
    }
  };
  const status = (code: number) => () => {
    host.failUploads = 1;
    host.failStatus = code;
  };
  for (const code of [400, 401, 403, 413, 415])
    expect(await outcome(status(code))).toBe("refused");
  // Rate limits, server errors and unexpected answers may follow a store.
  for (const code of [200, 202, 302, 409, 429, 500, 502, 503, 504])
    expect(await outcome(status(code))).toBe("uncertain");
  // A 201 without a usable Location is malformed: uncertain too.
  expect(
    await outcome(() => {
      host.uploadLocation = "";
    }),
  ).toBe("uncertain");
  expect(await outcome(() => {})).toBe("stored");
});

test("irc files out: without FILEHOST, or with filesOut off, files are unavailable", async () => {
  for (const options of [
    { isupport: () => [] },
    { features: { filesOut: false } },
  ]) {
    let answer = "";
    const run = await ship({ ...options, answer: () => answer });
    answer = await published(run.directory);
    run.fake.say(
      { nick: "jack", account: "jack" },
      "#galactica",
      "galactica: report",
    );
    await until(
      () => run.store.queueCounts(run.captain.key).done === 1,
      5000,
      "done",
    );
    expect(
      lineOf(run.fake.received("galactica"), "PRIVMSG").map((m) => m.params[1]),
    ).toEqual([
      "Done.",
      "Fuel report",
      "An attachment is unavailable or its upload is unconfirmed. The agent work was not rerun.",
    ]);
    expect(run.host.requests.filter((r) => r.method === "POST")).toHaveLength(
      0,
    );
  }
});
