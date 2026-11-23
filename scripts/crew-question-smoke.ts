/** Offline crew round trip with the installed plugin. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { Schema } from "effect";
import { Service } from "@opencode/client/service";
import { crewFingerprint } from "../src/crew/execution/identity";
import { CrewState } from "../src/crew/execution/state";
import { CrewQuestionGateway } from "../src/irc/crew-question-gateway";
import {
  questionSettingsPath,
  saveQuestionSettings,
} from "../src/questions/question-settings";

const standalone = process.argv.includes("--standalone");
const loseAck = process.argv.includes("--lose-ack");

const [binary, mesij, brokerPath] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--lose-ack" && arg !== "--standalone");

if (!binary || !mesij)
  throw new Error(
    "Pass the OpenCode binary and pinned mesij paths; optionally the read-only history broker script",
  );

if (standalone && (brokerPath || loseAck))
  throw new Error(
    "--standalone uses native service discovery without a gateway or broker",
  );

const home = await realpath(
  await mkdtemp(join(tmpdir(), "crew-clarification-")),
);

const captainDirectory = join(home, "captain");
const worktree = join(home, "worker");
const captainID = "ses_fixtureCaptain";

await Promise.all([captainDirectory, worktree].map((p) => mkdir(p)));

const auth = "Basic " + Buffer.from("opencode:fixture").toString("base64");
let captainAnswers = 0;
let modelCalls = 0;

const isModelRequest = Schema.is(
  Schema.Struct({
    messages: Schema.Array(Schema.Struct({ role: Schema.String })),
  }),
);

const isFormList = Schema.is(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
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

    const token = /op=answer, token=([a-f0-9]{32})/.exec(
      JSON.stringify(body.messages),
    )?.[1];

    if (token && !answered) captainAnswers++;

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
                name: token ? "stargate_question" : "question",
                arguments: JSON.stringify(
                  token ? { op: "answer", token, answer: "1" } : question,
                ),
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

// Optional loopback broker fixture exposing Server(bindPort, upstreamPort, password).
const broker = brokerPath
  ? Bun.spawn(
      [
        "python3",
        "-IB",
        "-u",
        "-c",
        "import sys,runpy; s=runpy.run_path(sys.argv[1])['Server'](0,int(sys.argv[2]),'fixture'); print(s.server_port,flush=True); s.serve_forever()",
        brokerPath,
        String(port),
      ],
      { stdout: "pipe", stderr: "inherit" },
    )
  : undefined;

let brokerPort: number | undefined;

if (broker) {
  const reader = broker.stdout.getReader();
  const first = await reader.read();
  brokerPort = Number(new TextDecoder().decode(first.value).trim());
  reader.releaseLock();
  assert.ok(Number.isInteger(brokerPort) && brokerPort > 0);
}

const plan = {
  namespace: "smoke",
  stateDirectory: join(home, "state-crew"),
  projectDirectory: captainDirectory,
  captainDirectory,
  captainSessionID: captainID,
  worktrees: { worker: worktree },
  mesijCommand: mesij,
  team: {
    captain: { id: "captain", agent: "build" },
    crew: [
      {
        id: "worker",
        agent: "worker",
        role: "Fixture worker",
        permissionProfile: "research" as const,
      },
    ],
    ...(standalone
      ? {}
      : {
          historyAPI: {
            url: `http://127.0.0.1:${brokerPort ?? 9}`,
            headersEnv: { Authorization: "FIXTURE_BROKER_AUTH" },
          },
        }),
  },
};

const state = await CrewState.open(
  plan.stateDirectory,
  plan.namespace,
  crewFingerprint(plan),
  undefined,
  false,
  captainID,
);

const peer = state.reservePeer("worker");

state.readyPeer("worker");

const task = state.reserveTask(peer, captainID);

assert.ok(task);

state.running(task.id);

if (standalone)
  await saveQuestionSettings(
    captainDirectory,
    "build",
    { enabled: true, timeoutMs: 300_000, answer: "requester" },
    new AbortController().signal,
  );

const config = join(home, "config/opencode");

await mkdir(config, { recursive: true });

await writeFile(
  join(config, "opencode.json"),
  JSON.stringify({
    plugins: [{ package: resolve(import.meta.dir, ".."), options: plan }],
    agents: {
      worker: {
        mode: "primary",
        model: "fixture/fixture",
        system: "Synthetic fixture worker.",
      },
    },
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
      { action: "stargate_crew", resource: "question", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
    ],
  }),
);

const engine = Bun.spawn(
  [
    binary,
    "serve",
    "--hostname",
    "127.0.0.1",
    ...(standalone ? ["--service"] : ["--port", String(port)]),
  ],
  {
    cwd: captainDirectory,
    env: {
      HOME: home,
      PATH: process.env["PATH"],
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      OPENCODE_PASSWORD: "fixture",
      FIXTURE_BROKER_AUTH: auth,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
    },
    stdout: "ignore",
    stderr: "inherit",
  },
);

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

let stop = new AbortController();
let gateway: Promise<void> | undefined;

try {
  const endpoint = standalone
    ? await wait(
        () =>
          Service.discover({ file: join(home, "state/opencode/service.json") }),
        "native service discovery",
      )
    : {
        url: `http://127.0.0.1:${port}`,
        auth: {
          type: "basic" as const,
          username: "opencode",
          password: "fixture",
        },
      };

  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers:
      Service.headers(
        endpoint.auth
          ? { url: endpoint.url, auth: endpoint.auth }
          : { url: endpoint.url },
      ) ?? {},
  });

  await wait(() => client.session.active().catch(() => {}), "native engine");
  await client.session.create({
    id: captainID,
    agent: "build",
    location: { directory: captainDirectory },
    model: { providerID: "fixture", id: "fixture" },
  });
  await client.session.create({
    id: peer.sessionID,
    agent: "worker",
    location: { directory: worktree },
    metadata: { stargateCrew: { namespace: plan.namespace, crewID: "worker" } },
    model: { providerID: "fixture", id: "fixture" },
  });
  await client.session.synthetic({
    id: task.inputID,
    sessionID: peer.sessionID,
    text: "Select the fixture colour.",
    description: "Fixture assignment",
    delivery: "queue",
    resume: true,
  });

  const form = await wait(
    async () =>
      (await client.session.form.list({ sessionID: peer.sessionID }))[0],
    "native crew form",
  );

  if (brokerPort) {
    const url =
      "http://127.0.0.1:" +
      brokerPort +
      "/api/session/" +
      peer.sessionID +
      "/form";

    const headers = { Authorization: auth };
    const list = await fetch(url, { headers });
    assert.equal(list.status, 200);
    const listed: unknown = await list.json();
    assert.ok(isFormList(listed) && listed.data.some((q) => q.id === form.id));
    assert.equal((await fetch(url + "/" + form.id, { headers })).status, 404);
    assert.equal(
      (await fetch(url + "/" + form.id + "/reply", { method: "POST", headers }))
        .status,
      405,
    );
    // Allow an ordinary plugin poll before starting the matching gateway.
    // The task should stay attached without publishing a question offer.
    await Bun.sleep(3500);
    assert.deepEqual(state.crewQuestionOffers(task.id), []);
  }

  let writes = 0;

  const traced = OpenCode.make({
    baseUrl: "http://127.0.0.1:" + port,
    headers: { Authorization: auth },
    fetch: Object.assign(
      async (req: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(req, init);

        const isWrite =
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/form/" + form.id + "/reply");

        if (isWrite) writes++;
        const result = await fetch(request);

        if (isWrite && loseAck) {
          stop.abort();
          throw new Error("Disconnected after native delivery");
        }

        return result;
      },
      { preconnect: fetch.preconnect },
    ),
  });

  const config = {
    type: "opencode" as const,
    sessionID: captainID,
    url: "http://127.0.0.1:" + port,
    directory: captainDirectory,
    headersEnv: {},
    permissions: [],
  };

  if (!standalone)
    gateway = new CrewQuestionGateway(config, {}, traced).run(stop.signal);

  if (loseAck) {
    await wait(
      async () => (writes === 1 && stop.signal.aborted) || undefined,
      "lost native acknowledgement",
    );
    await gateway;
    stop = new AbortController();
    gateway = new CrewQuestionGateway(config, {}, traced).run(stop.signal);
  }

  const offer = await wait(
    async () =>
      state.crewQuestionOffers(task.id).find((o) => o.outcome === "answered"),
    "retained captain answer",
  );

  const current = await client.session.form.get({
    sessionID: peer.sessionID,
    formID: form.id,
  });

  assert.equal(current.state.status, "answered");
  assert.deepEqual(
    current.state.status === "answered" && current.state.answer,
    { q0: "Blue" },
  );
  assert.equal(offer.originCaptainID, captainID);
  assert.equal(offer.inputID, task.inputID);
  assert.equal(state.activeTask("worker")?.id, task.id);
  assert.equal(writes, standalone ? 0 : 1);
  assert.equal(captainAnswers, 1);
  assert.equal(
    await Bun.file(questionSettingsPath(captainDirectory, "build")).exists(),
    standalone,
  );

  const history = await client.message.list({
    sessionID: peer.sessionID,
    limit: 100,
  });

  assert.deepEqual(
    history.data
      .filter((m) => m.type === "synthetic" || m.type === "user")
      .map((m) => m.id),
    [task.inputID],
  );
  console.log(
    "PASS: installed crew plugin sent the original worker question to the owning captain. One native answer, one worker input, same task.",
    {
      standalone,
      gatewayWrites: writes,
      captainAnswers,
      modelCalls,
      realHistoryBroker: !!brokerPort,
    },
  );
} finally {
  stop.abort();
  await gateway;
  engine.kill();
  await engine.exited;
  broker?.kill();
  await broker?.exited;
  void model.stop(true);
  state.close();
  await rm(home, { recursive: true, force: true });
}
