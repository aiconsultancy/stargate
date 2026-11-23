/** Disposable OpenCode process and loopback inference provider. Run with Bun. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { SessionMessage } from "@opencode/schema";
import { Schema } from "effect";
import pino from "pino";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { IrcShip } from "../src/irc/ship";
import { openStore } from "../src/app/open-store";
import { FakeIrcServer } from "../tests/irc-fixture";

const binary = process.argv[2];
const loseBeforeWrite = process.argv.includes("--drop-answer");

if (!binary) throw new Error("Pass the OpenCode 2.2.7 binary path");

const home = await mkdtemp(join(tmpdir(), "stargate-question-"));
let modelCalls = 0;

const isModelRequest = Schema.is(
  Schema.Struct({
    messages: Schema.Array(Schema.Struct({ role: Schema.String })),
  }),
);

const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body: unknown = await req.json();

    if (!isModelRequest(body)) throw new Error("Unexpected model request body");

    const answered = body.messages.some(
      (m: { role: string }) => m.role === "tool",
    );

    modelCalls++;

    const question = {
      questions: [
        {
          header: "Colour",
          question: "Choose the fixture colour.",
          options: [
            { label: "Blue", description: "Blue fixture" },
            { label: "Red", description: "Red fixture" },
          ],
        },
      ],
    };

    const delta = answered
      ? { content: "Recorded." }
      : {
          tool_calls: [
            {
              index: 0,
              id: "call_fixture",
              type: "function",
              function: {
                name: "question",
                arguments: JSON.stringify(question),
              },
            },
          ],
        };

    const chunk = (value: object, reason: string | null) =>
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: value, finish_reason: reason }],
      }) +
      "\n\n";

    return new Response(
      chunk({ role: "assistant" }, null) +
        chunk(delta, null) +
        chunk({}, answered ? "stop" : "tool_calls") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

const socket = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {} },
});

const port = socket.port;

socket.stop(true);

const config = join(home, "config/opencode");

await mkdir(config, { recursive: true });

await writeFile(
  join(config, "opencode.json"),
  JSON.stringify({
    model: "fixture/fixture",
    default_agent: "build",
    update: "disable",
    providers: {
      fixture: {
        package: "@opencode/ai/providers/openai-compatible",
        name: "Fixture",
        settings: { baseURL: model.url.href + "v1", apiKey: "fixture" },
        models: { fixture: { name: "fixture" } },
      },
    },
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "allow" },
    ],
  }),
);

process.env["IRC_SMOKE_AUTH"] =
  "Basic " + Buffer.from("opencode:fixture").toString("base64");

const engine = Bun.spawn(
  [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: home,
    env: {
      HOME: home,
      PATH: process.env["PATH"],
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      OPENCODE_PASSWORD: "fixture",
    },
    stdout: "ignore",
    stderr: "inherit",
  },
);

const client = OpenCode.make({
  baseUrl: "http://127.0.0.1:" + port,
  headers: {
    Authorization:
      "Basic " + Buffer.from("opencode:fixture").toString("base64"),
  },
});

async function wait<T>(get: () => Promise<T | undefined>, label: string) {
  for (let i = 0; i < 160; i++) {
    const value = await get();

    if (value) return value;
    await Bun.sleep(150);
  }

  throw new Error(
    "Timed out waiting for " + label + "; provider calls " + modelCalls,
  );
}

try {
  await wait(() => client.session.active().catch(() => {}), "engine");

  const session = await client.session.create({
    location: { directory: home },
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
  });

  const sessionID = session.id;
  const input = SessionMessage.ID.create();
  await client.session.synthetic({
    sessionID,
    id: input,
    text: "Select the fixture colour.",
    description: "Fixture",
    delivery: "queue",
    resume: true,
  });

  const form = await wait(
    async () => (await client.session.form.list({ sessionID }))[0],
    "native form",
  );

  const exact = await client.session.form.get({ sessionID, formID: form.id });
  console.log(
    "Pre-start native form",
    exact.state.status,
    exact.metadata,
    "fields",
    exact.fields.map((f) => f.key),
  );
  const { OpenCodeBackend } = await import("../src/backends/opencode/opencode");
  let promptPosts = 0;
  let answerPosts = 0;
  let discardPrompt = false;

  const traced = OpenCode.make({
    baseUrl: "http://127.0.0.1:" + port,
    headers: {
      Authorization:
        "Basic " + Buffer.from("opencode:fixture").toString("base64"),
    },
    fetch: Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(url instanceof Request ? url.url : url).pathname;

        if (path.endsWith("/prompt")) {
          promptPosts++;

          if (discardPrompt) throw new Error("fixture submission disconnected");
        }

        if (path.endsWith("/reply")) {
          answerPosts++;

          if (loseBeforeWrite)
            throw new Error("Fixture disconnected before native delivery");
          const response = await fetch(url, init);

          if (process.argv.includes("--lose-answer-ack") && response.ok)
            throw new Error("Fixture lost the native answer ACK");

          return response;
        }

        return fetch(url, init);
      },
      { preconnect: fetch.preconnect },
    ),
  });

  const backend = new OpenCodeBackend(
    {
      type: "opencode",
      directory: home,
      url: "http://127.0.0.1:" + port,
      headersEnv: { Authorization: "IRC_SMOKE_AUTH" },
      sessionID,
      permissions: [],
    },
    traced,
  );

  const queued = new AbortController();
  const stages: string[] = [];
  let queuedID = "";

  const run = backend
    .prompt(
      sessionID,
      "Queued fixture",
      queued.signal,
      undefined,
      (id) => {
        queuedID = id;
      },
      [],
      undefined,
      (v) => stages.push(v.stage),
    )
    .catch(() => {});

  try {
    await wait(async () => stages.includes("queued"), "same-ID queued event");
    assert.ok(
      (await client.session.inbox.list({ sessionID })).some(
        (v) => v.id === queuedID,
      ),
    );
  } finally {
    queued.abort();
    await run;
  }

  assert.ok(
    !(await client.session.inbox.list({ sessionID })).some(
      (v) => v.id === queuedID,
    ),
  );
  discardPrompt = true;
  const unconfirmed: string[] = [];
  await assert.rejects(
    backend.prompt(
      sessionID,
      "Unacknowledged fixture",
      AbortSignal.timeout(5000),
      undefined,
      undefined,
      [],
      undefined,
      (v) => unconfirmed.push(v.stage),
    ),
  );
  discardPrompt = false;
  assert.deepEqual(unconfirmed, ["submitting"]);
  assert.equal(promptPosts, 2);
  console.log(
    "PASS: queued input observed and withdrawn by ID; unacknowledged input stayed submitting.",
  );
  const irc = new FakeIrcServer({ accounts: { captain: "fixture" } });
  irc.start();

  const opts = Schema.decodeUnknownSync(ircSchema)({
    id: "captain",
    account: "captain",
    server: { host: "127.0.0.1", port: irc.port, tls: false },
    passwordEnv: "IRC_FIXTURE",
    channels: ["#ship"],
    features: { questions: true, liveProgress: true },
    turnTimeoutMs: 4000,
    questionOperator: "operator",
    access: {
      allowedAccounts: ["operator", "other"],
      channelRequests: "nick-mention",
    },
    fleetPolicy: {
      role: "captain",
      humanAccounts: ["operator", "other"],
      agentAccounts: ["captain"],
      assignedCheckout: home,
      capabilities: ["read_code"],
    },
    backend: {
      type: "opencode",
      url: "http://127.0.0.1:" + port,
      directory: home,
      sessionID,
    },
  });

  const log = pino({ level: "silent" });

  async function startGateway() {
    const store = openStore(join(home, "stargate.sqlite"));

    const ship = await IrcShip.create(opts, store, log, {
      env: { IRC_FIXTURE: "fixture" },
      timing: {
        reconnectMinMs: 50,
        intervalMs: 1,
        burst: 100,
        turnStatusMs: 200,
      },
    });

    const reg = ship.registrations[0];
    assert.ok(reg);

    const gw = new Gateway(
      reg.settings,
      reg.identity,
      store,
      backend,
      reg.delivery,
      log,
      undefined,
      undefined,
      reg.transport,
    );

    reg.operatorQuestion = gw.operatorQuestion.bind(gw);
    const lifetime = new AbortController();
    const work = gw.work(lifetime.signal);
    ship.start(() => true);

    return {
      reg,
      close: async () => {
        lifetime.abort();
        await work;
        await ship.close();
        store.close();
      },
    };
  }

  let gateway = await startGateway();

  const say = (account: string, text: string) =>
    irc.say({ nick: account, account }, "captain", text);

  const lines = () => irc.received("captain");

  const seen = (needle: string) =>
    wait(async () => lines().find((l) => l.includes(needle)), needle);

  try {
    irc.setUser("operator", "operator");
    await wait(async () => gateway.reg.client.inChannel("#ship"), "IRC ready");
    const alert = await seen("Send show Q");
    const ref = alert.match(/show (Q[0-9a-f]{10})/)?.[1];
    assert.ok(ref);
    assert.ok(!alert.includes("colour"));
    const who = { nick: "operator", account: "operator" };
    irc.say(who, "#ship", "@captain roll call");
    const blocked = await seen("Stargate did not submit this request.");
    assert.ok(
      blocked.includes("#ship") &&
        !blocked.includes("colour") &&
        !blocked.includes(ref),
    );
    assert.equal(promptPosts, 2);
    assert.equal(modelCalls, 1);
    assert.equal((await client.session.inbox.list({ sessionID })).length, 0);
    assert.equal(
      (await client.session.form.get({ sessionID, formID: form.id })).state
        .status,
      "pending",
    );
    console.log(
      "PASS: later IRC roll call reported the earlier wait without starting another input or disclosing the question.",
    );
    const connections = irc.clients.length;
    irc.drop("captain");
    await wait(
      async () =>
        irc.clients.length > connections &&
        gateway.reg.client.inChannel("#ship"),
      "IRC reconnected with form pending",
    );
    say("other", "show " + ref);
    say("operator", "show " + ref);
    await seen("Choose the fixture colour.");
    const instruction = await seen("Send answer Q");
    const token = instruction.match(/Send answer (Q[0-9a-f]{10})/)?.[1];
    assert.ok(token && token !== ref);
    await gateway.close();
    gateway = await startGateway();
    await wait(
      async () => gateway.reg.client.inChannel("#ship"),
      "gateway restarted and IRC rejoined",
    );
    assert.equal(answerPosts, 0);
    assert.equal(modelCalls, 1);
    say("other", "answer " + token + " 2");
    say("operator", "answer " + token + " 1");
    say("operator", "answer " + token + " 2");

    if (loseBeforeWrite) {
      await seen("Answer delivery is unconfirmed.");
      await gateway.close();
      gateway = await startGateway();
      await wait(
        async () => gateway.reg.client.inChannel("#ship"),
        "reconnected after uncertain submission",
      );
      say("operator", "answer " + token + " 1");
      await seen("This question is no longer available for an IRC answer.");
      assert.equal(
        (await client.session.form.get({ sessionID, formID: form.id })).state
          .status,
        "pending",
      );
      assert.equal(answerPosts, 1);
      assert.equal(modelCalls, 1);
      console.log(
        "PASS: ambiguous attempt before native delivery stayed pending after restart, with zero native answers and no resubmission.",
      );
    } else {
      await seen(
        process.argv.includes("--lose-answer-ack")
          ? "OpenCode reports the question was answered."
          : "OpenCode accepted your answer.",
      );

      const final = await client.session.form.get({
        sessionID,
        formID: form.id,
      });

      assert.equal(promptPosts, 2);
      assert.equal(answerPosts, 1);
      assert.deepEqual(final.state, {
        status: "answered",
        answer: { q0: "Blue" },
      });
      await wait(async () => modelCalls === 2, "same turn continued");
      assert.equal(
        (await client.message.list({ sessionID, limit: 20 })).data.filter(
          (m) => m.type === "user" || m.type === "synthetic",
        ).length,
        1,
      );
      console.log(
        "PASS: pre-start native question answered from IRC on the original synthetic input.",
      );
    }

    assert.ok(
      !lines().some(
        (l) =>
          l.includes("PRIVMSG other :") || l.includes("PRIVMSG #ship :Choose"),
      ),
    );
  } finally {
    await gateway.close();
    irc.stop();
  }
} finally {
  engine.kill();
  await engine.exited;
  await model.stop(true);
  await rm(home, { recursive: true, force: true });
}
