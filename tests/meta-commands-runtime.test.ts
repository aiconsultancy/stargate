import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import pino from "pino";
import { NotificationStore } from "../src/notification-store";
import { notificationKey } from "../src/notifications";
import { type RuntimeDependencies, type SlackApp, serve } from "../src/runtime";
import { bot, event, identity } from "./fixtures";

test("runtime binds /config mutes to this registration's existing preferences store", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-meta-runtime-"));
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const config = bot();
    const preferences = new NotificationStore(
      join(dataDirectory, "notifications.sqlite"),
    );
    try {
      preferences.operate(
        notificationKey(config, identity),
        {
          op: "mute",
          scope: "thread",
          channel: "C123",
          thread_ts: "1.000",
        },
        { id: "seed-current", caller: "captain", now: Date.now },
      );
      preferences.operate(
        "other-registration",
        {
          op: "mute",
          scope: "channel",
          channel: "CSECRET",
        },
        { id: "seed-other", caller: "other", now: Date.now },
      );
    } finally {
      preferences.close();
    }
    const started =
      Promise.withResolvers<(body: unknown) => boolean | Promise<boolean>>();
    const posts: string[] = [];
    const backendCalls: string[] = [];
    const dependencies: RuntimeDependencies = {
      slack: () =>
        ({
          async identity() {
            return identity;
          },
          async start(accept) {
            started.resolve(accept);
          },
          async close() {},
          async post(_channel, _thread, text) {
            posts.push(text);
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
      backend: async () => ({
        async createSession() {
          backendCalls.push("create");
          throw new Error("Backend down");
        },
        async prompt() {
          backendCalls.push("prompt");
          throw new Error("Backend down");
        },
        async close() {},
      }),
    };
    running = Effect.runPromise(
      serve(
        { dataDirectory, bots: [config] },
        pino({ enabled: false }),
        controller.signal,
        dependencies,
      ),
    );
    const accept = await started.promise;
    await accept(event("<@UBOT> /config mutes"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("C123 thread 1.000: active");
    expect(posts[0]).not.toContain("CSECRET");
    expect(backendCalls).toEqual([]);
  } finally {
    controller.abort();
    await running;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
