import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import pino from "pino";
import { NotificationStore } from "../src/notifications/preferences/notification-store";
import { notificationKey } from "../src/notifications/preferences/notifications";
import {
  type RuntimeDependencies,
  type SlackApp,
  serve,
} from "../src/app/runtime";
import type { SlackInteractions } from "../src/slack/slack";
import { resolveWaiting } from "../src/gateway/waiting";
import { bot, event, identity } from "./fixtures";

test("runtime binds registration-scoped reads and authenticated panel actions without captain work", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-meta-runtime-"));
  const controller = new AbortController();
  let running: Promise<void> | undefined;

  try {
    const config = bot();
    config.configPanelEnabled = true;

    if (config.backend.type !== "opencode") throw new Error("Invalid fixture");
    config.backend.directory = dataDirectory;
    config.backend.agent = "captain";

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
    const updates: { ts: string; text: string; content: unknown }[] = [];
    let interactions: SlackInteractions | undefined;
    const backendCalls: string[] = [];

    const dependencies: RuntimeDependencies = {
      slack: () =>
        ({
          async identity() {
            return identity;
          },
          async start(accept, _log, controls) {
            interactions = controls;
            started.resolve(accept);
          },
          async close() {},
          async post(_channel, _thread, text) {
            posts.push(text);

            return "9.000";
          },
          async update(_channel, ts, text, _stop, content) {
            updates.push({ ts, text, content });

            return true;
          },
          async userInfo(user) {
            return {
              ok: true,
              user: {
                id: user,
                team_id: identity.team,
                is_bot: false,
                deleted: false,
              },
            };
          },
          async ephemeral() {
            throw new Error("Unexpected panel refusal");
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
        async quota() {
          backendCalls.push("quota");

          return {
            status: "not-configured",
            observedAt: 1,
            cached: false,
            accounts: [],
          };
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
    await accept(event("<@UBOT> /health proxy", "2.000"));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatch(/proxy/i);
    expect(posts[1]).toContain("unknown");
    expect(backendCalls).toEqual(["quota"]);
    await accept(event("<@UBOT> /config", "3.000"));

    const content = Schema.decodeUnknownSync(
      Schema.Struct({
        blocks: Schema.Array(
          Schema.Struct({
            type: Schema.String,
            elements: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  action_id: Schema.String,
                  value: Schema.String,
                  text: Schema.Struct({ text: Schema.String }),
                }),
              ),
            ),
          }),
        ),
      }),
    )(updates.at(-1)?.content);

    const button = content.blocks
      .flatMap((block) => block.elements ?? [])
      .find((item) => item.text.text === "3s");

    if (!button || !interactions) throw new Error("Panel binding unavailable");
    let acks = 0;
    await interactions.interactive(
      {
        type: "block_actions",
        api_app_id: config.slack.appId,
        team: { id: identity.team },
        user: { id: "U123" },
        channel: { id: "C123" },
        container: { type: "message", channel_id: "C123", message_ts: "9.000" },
        message: { user: identity.user, ts: "9.000", thread_ts: "3.000" },
        actions: [
          {
            type: "button",
            action_id: button.action_id,
            value: button.value,
            action_ts: "1795003200.001",
          },
        ],
      },
      async () => {
        acks++;
      },
    );
    expect(acks).toBe(1);
    expect((await resolveWaiting(config)).delayMs).toBe(3000);
    expect(updates.at(-1)?.ts).toBe("9.000");
    expect(updates.at(-1)?.text).toContain("U123");
    expect(backendCalls).toEqual(["quota"]);
  } finally {
    controller.abort();
    await running;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
