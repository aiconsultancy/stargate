import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Schema } from "effect";
import pino from "pino";
import { type Config, configSchema } from "../src/config";
import {
  type RuntimeDependencies,
  type SlackApp,
  serve,
  start,
} from "../src/runtime";
import { SlackConnection } from "../src/slack";
import { bot } from "./fixtures";

export const producerToken = "fixture-notification-producer-credential-0001";
export function notificationConfig(enabled = false) {
  return {
    adapters: {
      local: {
        type: "http",
        enabled,
        path: "/v1/notifications/local",
        sources: [
          {
            id: "ci",
            tokenEnv: "NOTIFY_CI",
            topics: ["release.*"],
            audience: "internal",
          },
        ],
      },
    },
    destinations: {
      log: { slack: { bot: "helper", channel: "C123" }, audience: "internal" },
    },
    subscriptions: [{ topic: "release.*", to: ["log"] }],
  };
}
export const envelope = (title = "Released") => ({
  schema: 1,
  topic: "release.desktop",
  occurredAt: "2026-11-19T02:00:00Z",
  payload: { title },
});
export function runtimeConfig(dataDirectory: string, enabled = true): Config {
  return Schema.decodeUnknownSync(configSchema)({
    dataDirectory,
    api: { listen: "unix" },
    bots: [bot()],
    notify: notificationConfig(enabled),
  });
}
export async function temporary() {
  return mkdtemp(join(tmpdir(), "notify-integration-"));
}
export function unixRequest(
  socketPath: string,
  path = "/v1/notifications/local",
  options: {
    token?: string;
    body?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {},
) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: options.method ?? "POST",
        headers: {
          Authorization: `Bearer ${options.token ?? producerToken}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body ?? JSON.stringify(envelope()));
  });
}
export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() >= deadline)
      throw new Error("Notification fixture deadline");
    await delay(5);
  }
}
export function runtimeDependencies(
  slackUrl: string,
  options: { fail?: boolean; never?: boolean; grace?: number } = {},
) {
  const calls: string[] = [];
  const dependencies: RuntimeDependencies = {
    slack: (bot) => {
      const real = new SlackConnection(
        "fixture-app",
        "fixture-bot",
        pino({ enabled: false }),
        { slackApiUrl: slackUrl },
      );
      return {
        identity: async () => ({
          team: "T123",
          user: `U${bot.id.toUpperCase()}`,
        }),
        start: async () => {
          if (options.fail) throw new Error("Fixture connection failed");
        },
        close: async () => {},
        post: async () => {
          calls.push("post");
          return "1.000";
        },
        announce: async () => {
          calls.push("announce");
          return "1.000";
        },
        notification: options.never
          ? async () => {
              console.log("attempt-started");
              return new Promise<never>(() => {});
            }
          : real.notification.bind(real),
        cronUI: {
          open: async () => {},
          push: async () => {},
          update: async () => {},
        },
        crewUI: { open: async () => "V1", update: async () => {} },
      } satisfies SlackApp;
    },
    backend: async () => ({
      createSession: async () => {
        calls.push("createSession");
        return "session";
      },
      prompt: async () => {
        calls.push("prompt");
        return "Answer";
      },
      close: async () => {},
    }),
    notification: {
      environment: { NOTIFY_CI: producerToken },
      ...(options.grace ? { shutdownGraceMs: options.grace } : {}),
    },
  };
  return { dependencies, calls };
}

if (
  import.meta.main &&
  (process.argv[3] === "start-credentials" ||
    process.argv[3] === "start-shared-credentials")
) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Missing fixture directory");
  const originalFetch = globalThis.fetch;
  let authCalls = 0;
  let correctAuthorization = false;
  let unexpectedRequest = false;
  const shared = process.argv[3] === "start-shared-credentials";
  const expectedApp = shared
    ? `xapp-${"b".repeat(40)}`
    : "xapp-companion-fixture";
  const expectedBot = shared
    ? `xoxb-${"a".repeat(40)}`
    : "xoxb-companion-fixture";
  const initiallyAbsent = [
    "APP_TOKEN",
    "BOT_TOKEN",
    "NOTIFY_CI",
    ...(shared ? ["DECLARED_HEADER"] : []),
  ].every((name) => process.env[name] === undefined);
  // Exercise start and its real Slack factory. Refuse auth locally, before
  // Socket Mode or backend creation, without making any network request.
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://slack.com/api/auth.test") {
        authCalls++;
        correctAuthorization =
          new Headers(init?.headers).get("Authorization") ===
          `Bearer ${expectedBot}`;
      } else unexpectedRequest = true;
      return Response.json({ ok: false, error: "invalid_auth" });
    },
    { preconnect: originalFetch.preconnect },
  );
  let refused = false;
  try {
    await start(join(directory, "stargate.json"));
  } catch {
    refused = true;
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(
    JSON.stringify({
      initiallyAbsent,
      appProjected: process.env["APP_TOKEN"] === expectedApp,
      botProjected: process.env["BOT_TOKEN"] === expectedBot,
      ...(shared
        ? {
            declaredHeaderProjected:
              process.env["DECLARED_HEADER"] ===
              "fixture-declared-backend-header-credential",
          }
        : {}),
      producerOnlyAbsent: process.env["NOTIFY_CI"] === undefined,
      authCalls,
      correctAuthorization,
      unexpectedRequest,
      refused,
    }),
  );
} else if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Missing fixture directory");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const config = runtimeConfig(directory);
  const controller = new AbortController();
  const f = runtimeDependencies("http://127.0.0.1:1/", {
    never: true,
    grace: 700,
  });
  process.on("SIGTERM", () => {
    console.log("shutdown-requested");
    controller.abort();
  });
  const running = Effect.runPromise(
    serve(config, pino({ enabled: false }), controller.signal, f.dependencies),
  );
  await until(async () =>
    readFile(join(directory, "ready.json")).then(
      () => true,
      () => false,
    ),
  );
  console.log("ready");
  await running;
}
