import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, chown, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import type { AgentBackend } from "../src/backends/backend";
import type { Attachment } from "../src/chat/attachments/attachments";
import {
  type BackendConfig,
  type BotConfig,
  botSchema,
  ircSchema,
} from "../src/config";
import {
  type RuntimeDependencies,
  type SlackApp,
  serve,
} from "../src/app/runtime";
import { subspaceAgentsSection } from "../src/config/composition";
import {
  flockCommand,
  setDefaultLockCommandForTests,
} from "../src/lib/unix-socket";
import { parseBundle } from "../src/subspace/certificate";
import { IrcShip } from "../src/transports/irc/ship";
import { identity } from "./fixtures";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";
import {
  ENROLMENT_TOKEN,
  StubApi,
  bearer,
  captain,
  capturedLog,
  childDirectory,
  enrolled,
  overSocket,
  ownership,
  privateDirectory,
  removeDirectories,
  section,
  verifyAgentToken,
} from "./subspace-fixture";

const cleanup: (() => unknown)[] = [];

// Officers' Fleet API sockets use the default start-up lock command; util-linux
// Flock is absent on some development hosts.
beforeAll(() => {
  if (ownership.lockCommand) {
    setDefaultLockCommandForTests(ownership.lockCommand);
  }
});

afterAll(() => {
  setDefaultLockCommandForTests(flockCommand);
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }

  await removeDirectories();
});

const env = { SUBSPACE_ENROLMENT: ENROLMENT_TOKEN };
const enrol = "/api/v1/agents/enrol";

function stubApi() {
  const stub = new StubApi();
  cleanup.push(() => stub.stop());
  stub.handler = (request) =>
    request.path === enrol ? enrolled(request) : Response.json({ ok: true });

  return stub;
}

/** A Slack bot registration for runtime tests; its backend is never started. */
function slackBot(backend: Record<string, unknown>): BotConfig {
  return Schema.decodeUnknownSync(botSchema)({
    id: "captain-a",
    slack: {
      appId: "A123",
      appTokenEnv: "APP_TOKEN",
      botTokenEnv: "BOT_TOKEN",
    },
    access: { users: ["U123"], channels: ["C123"] },
    backend,
  });
}

const claude = {
  type: "claude",
  directory: "/workspace",
  model: "claude-example",
  provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv: "PROXY_KEY" },
};

/** The gateway, served for real with fake Slack and backends; returns how it went. */
async function runGateway(
  subspaceAgents: ReturnType<typeof section> | undefined,
  dataDirectory?: string,
  more: Partial<Parameters<typeof serve>[0]> = {},
) {
  const directory = dataDirectory ?? (await privateDirectory());
  const backends: BackendConfig[] = [];
  const fetches = { calls: 0 };
  const started = Promise.withResolvers<void>();
  const { log, lines } = capturedLog();

  const dependencies: RuntimeDependencies = {
    slack: () =>
      ({
        async identity() {
          return identity;
        },
        async start() {
          started.resolve();
        },
        async close() {},
        async post() {
          return "9.000";
        },
        async announce() {
          return "9.000";
        },
        cronUI: { async open() {}, async push() {}, async update() {} },
        crewUI: {
          async open() {
            return "V1";
          },
          async update() {},
        },
      }) satisfies SlackApp,
    backend: async (config) => {
      backends.push(config);

      return {
        async createSession() {
          return "session";
        },
        async prompt() {
          return "Answer.";
        },
        async close() {},
      } satisfies AgentBackend;
    },
    subspaceAgents: {
      env,
      ownership,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        fetches.calls++;

        return fetch(...args);
      }) as typeof fetch,
    },
  };

  const controller = new AbortController();

  const running = Effect.runPromise(
    serve(
      {
        dataDirectory: directory,
        bots: [slackBot(claude)],
        ...(subspaceAgents && { subspaceAgents }),
        ...more,
      },
      log,
      controller.signal,
      dependencies,
    ),
  );

  const outcome = await Promise.race([
    started.promise.then(() => "started" as const),
    running.then(
      () => "stopped" as const,
      () => "failed" as const,
    ),
  ]);

  const stop = async () => {
    controller.abort();
    await running.catch(() => {});
  };

  cleanup.push(stop);

  return {
    outcome,
    running,
    dataDirectory: directory,
    backends,
    fetches,
    lines,
    stop,
  };
}

async function officerSocket() {
  const sockets = await privateDirectory("sg-");

  return join(await childDirectory(sockets, "captain-a", 0o700), "a.sock");
}

test("an addressed IRC upload reaches the officer's turn through that officer's API key", async () => {
  const stub = stubApi();
  const socketPath = await officerSocket();
  const dataDirectory = await privateDirectory();
  const reference = "UPL-AQEBAQEBAQEBAQEBAQEBAQ";
  const missing = "UPL-AgICAgICAgICAgICAgICAg";
  const path = `/api/v1/chat/uploads/${reference}`;
  const bytes = Buffer.from("Review the shared plan.");

  stub.handler = (request) => {
    switch (request.path) {
      case enrol:
        return enrolled(request);
      case path:
        return Response.json({
          reference,
          fileName: "plan.txt",
          contentType: "text/plain",
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      case `${path}/content`:
        return new Response(new Uint8Array(bytes));
      default:
        return new Response(null, { status: 410 });
    }
  };

  const fake = new FakeIrcServer({
    accounts: { "captain-a": "test-password" },
    caps: [
      "sasl=PLAIN",
      "account-tag",
      "message-tags",
      "batch",
      "echo-message",
      "labeled-response",
      "draft/multiline=max-bytes=4096,max-lines=10",
    ],
  }).start();

  cleanup.push(() => fake.stop());

  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "example-ship",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "captain-a",
    passwordEnv: "EXAMPLE_IRC_PASSWORD",
    channels: ["#example-ship"],
    access: { allowedAccounts: ["member"] },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: "ses_example",
    },
  });

  const requests: { text: string; files: Attachment[] }[] = [];
  const controller = new AbortController();
  const { log, lines } = capturedLog();

  const running = Effect.runPromise(
    serve(
      {
        dataDirectory,
        bots: [],
        irc: [config],
        subspaceAgents: section(stub.url, [
          captain("captain-a", { socketPath }),
        ]),
      },
      log,
      controller.signal,
      {
        slack: () => {
          throw new Error("Slack is not configured");
        },
        backend: async () => ({
          sessionID: "ses_example",
          supportsAttachments: true,
          async createSession() {
            return "ses_example";
          },
          async prompt(_session, text, _signal, _onText, _onInput, files) {
            requests.push({ text, files: [...(files ?? [])] });

            return "I received the plan.";
          },
          async close() {},
        }),
        irc: (config, store, log, options) =>
          IrcShip.create(config, store, log, {
            ...options,
            env: { EXAMPLE_IRC_PASSWORD: "test-password" },
          }),
        subspaceAgents: { env, ownership },
      },
    ),
  );

  cleanup.push(async () => {
    controller.abort();
    await running;
  });
  const members = () => fake.members.get("#example-ship")?.size;
  await until(() => members() === 1, 3000, "officer joined IRC", {
    state: () => lines.slice(-8),
  });

  fake.sayLines({ nick: "member", account: "member" }, "#example-ship", [
    { text: "captain-a: please review this" },
    { text: `${reference} plan.txt (${bytes.length} bytes)` },
  ]);
  await until(
    () => requests.length === 1,
    3000,
    "officer turn with attachment",
    {
      state: () => ({
        log: lines.slice(-10),
        routes: stub.requests.map((request) => request.path),
        replies: lineOf(fake.received("captain-a"), "PRIVMSG").map(
          (message) => message.params[1],
        ),
      }),
    },
  );
  expect(requests[0]?.text).toContain(`please review this\n${reference}`);
  expect(requests[0]?.files).toEqual([
    {
      name: "plan.txt",
      mime: "text/plain",
      data: bytes,
      source: { id: reference },
    },
  ]);

  const key = parseBundle(
    await readFile(
      join(dataDirectory, "subspace-agents", "captain-a.pem"),
      "utf8",
    ),
  );

  const reads = stub.requests.filter((request) => request.method === "GET");
  expect(reads.map((request) => request.path)).toEqual([
    path,
    `${path}/content`,
  ]);

  for (const request of reads) {
    const verified = await verifyAgentToken(
      bearer(request),
      key.certificate,
      stub.url,
    );

    expect(verified.payload.sub).toBe(key.fingerprint);
  }

  fake.say(
    { nick: "member", account: "member" },
    "#example-ship",
    `captain-a: review ${missing}`,
  );
  await until(
    () =>
      lineOf(fake.received("captain-a"), "PRIVMSG").some((message) =>
        message.params[1]?.includes("Stargate could not pass the shared files"),
      ),
    5000,
    "expired file notice",
  );
  expect(requests).toHaveLength(1);
});

for (const variant of ["absent", "enabled: false"] as const) {
  test(`runtime: subspaceAgents ${variant} creates, opens, logs and contacts nothing`, async () => {
    const stub = stubApi();
    const socketPath = await officerSocket();

    // Decoded as configuration is: a switched-off section is no section.
    const gateway = await runGateway(
      variant === "absent"
        ? undefined
        : Schema.decodeUnknownSync(subspaceAgentsSection)({
            enabled: false,
            api: { baseUrl: stub.url },
            officers: [
              captain("captain-a", { registration: "captain-a", socketPath }),
            ],
          }),
    );

    expect(gateway.outcome).toBe("started");
    await Bun.sleep(200);
    expect(gateway.fetches.calls).toBe(0);
    expect(stub.requests).toEqual([]);
    expect(existsSync(join(gateway.dataDirectory, "subspace-agents"))).toBe(
      false,
    );
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(join(socketPath, "..", "fleet-api.sock"))).toBe(false);
    expect(gateway.lines.join("\n")).not.toMatch(/[Ss]ubspace|Fleet API/);
    // The backend receives its configuration exactly as written.
    expect(gateway.backends).toEqual([slackBot(claude).backend]);
    await gateway.stop();
  });
}

test("runtime: enabled, keys are made, the socket signs, enrolment runs in the background and a Claude officer gets the bridge", async () => {
  const stub = stubApi();
  const socketPath = await officerSocket();

  const gateway = await runGateway(
    section(stub.url, [
      captain("captain-a", { registration: "captain-a", socketPath }),
    ]),
  );

  expect(gateway.outcome).toBe("started");
  expect(gateway.backends).toEqual([
    {
      ...slackBot(claude).backend,
      mcpServers: {
        subspace: {
          type: "stdio",
          command: process.execPath,
          args: [
            resolve("src/main.ts"),
            "subspace",
            "mcp",
            "--socket",
            socketPath,
          ],
        },
      },
    } as BackendConfig,
  ]);
  await until(
    () => stub.requests.some((request) => request.path === enrol),
    3000,
    "enrolment",
  );

  const bundle = join(
    gateway.dataDirectory,
    "subspace-agents",
    "captain-a.pem",
  );

  const key = parseBundle(await readFile(bundle, "utf8"));

  expect(((await stat(bundle)).mode & 0o777).toString(8)).toBe("600");
  expect((await overSocket(socketPath, "GET", "/api/v1/me")).status).toBe(200);

  const [forwarded] = stub.requests.filter((request) => request.path !== enrol);

  expect(
    (
      await verifyAgentToken(
        bearer(forwarded ?? ({ headers: {} } as never)),
        key.certificate,
        stub.url,
      )
    ).payload.sub,
  ).toBe(key.fingerprint);
  expect(gateway.lines.join("\n")).toContain("Subspace agent identity enabled");

  // Beside it, the officer's read-only Fleet API socket, with no api section.
  const fleetSocket = join(socketPath, "..", "fleet-api.sock");

  await until(() => existsSync(fleetSocket), 3000, "Fleet API socket");

  const fleet = await overSocket(fleetSocket, "GET", "/api/v1/fleet");

  expect(fleet.status).toBe(200);
  expect(JSON.parse(fleet.body)).toMatchObject({
    ships: [{ id: "captain-a" }],
  });
  expect((await overSocket(fleetSocket, "POST", "/api/v1/fleet")).status).toBe(
    405,
  );
  expect(existsSync(join(gateway.dataDirectory, "api-token"))).toBe(false);
  await until(
    () => gateway.lines.join("\n").includes("Fleet API listening"),
    3000,
    "the Fleet API start-up log",
  );
  await gateway.stop();
  expect(existsSync(socketPath)).toBe(false);
  expect(existsSync(fleetSocket)).toBe(false);
});

test("runtime: another socket at an officer's Fleet API socket stops start-up, naming both", async () => {
  const stub = stubApi();
  const sockets = await privateDirectory("sg-");
  const directory = await childDirectory(sockets, "captain-a", 0o750);

  // The dashboard's shared directory is exactly 2750. Setgid sticks only with
  // One of our own groups; a BSD temporary directory's group may not be.
  await chown(directory, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
  await chmod(directory, 0o2750);
  const fleetSocket = join(directory, "fleet-api.sock");

  const gateway = await runGateway(
    section(stub.url, [
      captain("captain-a", {
        registration: "captain-a",
        socketPath: join(directory, "api.sock"),
      }),
    ]),
    undefined,
    {
      dashboard: true,
      dashboardSocket: { path: fleetSocket, groupAccess: true },
    },
  );

  // The Fleet API starts after the transports: the gateway then stops.
  const refusal = `captain-a's Fleet API socket ${fleetSocket} is also the dashboard socket; give that socket another path`;

  await until(
    () => gateway.lines.join("\n").includes(refusal),
    3000,
    "the refusal",
  );
  expect(
    await gateway.running.then(
      () => "stopped",
      () => "failed",
    ),
  ).toBe("failed");
  expect(gateway.lines.join("\n")).not.toContain("Fleet API listening");
});

test("runtime: a bundle others can read stops start-up and says why", async () => {
  const stub = stubApi();
  const first = await runGateway(section(stub.url, [captain("captain-a")]));

  expect(first.outcome).toBe("started");
  await first.stop();

  const bundle = join(first.dataDirectory, "subspace-agents", "captain-a.pem");
  await chmod(bundle, 0o644);

  const second = await runGateway(
    section(stub.url, [captain("captain-a")]),
    first.dataDirectory,
  );

  expect(second.outcome).toBe("failed");
  expect(second.lines.join("\n")).toContain(
    "captain-a's Subspace bundle must be a regular file owned by the gateway user",
  );
});
