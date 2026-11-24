import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import type { AgentBackend } from "../src/backends/backend";
import { type BackendConfig, type BotConfig, botSchema } from "../src/config";
import {
  type RuntimeDependencies,
  type SlackApp,
  serve,
} from "../src/app/runtime";
import { subspaceAgentsSection } from "../src/config/composition";
import { parseBundle } from "../src/subspace/certificate";
import { identity } from "./fixtures";
import { until } from "./irc-fixture";
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

  return { outcome, dataDirectory: directory, backends, fetches, lines, stop };
}

async function officerSocket() {
  const sockets = await privateDirectory("sg-");

  return join(await childDirectory(sockets, "captain-a", 0o700), "a.sock");
}

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
    expect(gateway.lines.join("\n")).not.toMatch(/[Ss]ubspace/);
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
  await gateway.stop();
  expect(existsSync(socketPath)).toBe(false);
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
