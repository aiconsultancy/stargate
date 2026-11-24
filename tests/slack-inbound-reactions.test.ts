import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  type AgentBackend,
  type SteerInput,
  sourceLine,
} from "../src/backends/backend";
import { SlackGateway as Gateway } from "./slack-gateway-fixture";
import type { TransportDelivery } from "../src/gateway/ports";
import { NotificationStore } from "../src/notifications/preferences/notification-store";
import type { NotificationReader } from "../src/notifications/preferences/notifications";
import { botKey } from "../src/gateway/routing";
import {
  handleSlackRequest,
  SlackConnection,
} from "../src/transports/slack/slack";
import { openStore } from "../src/app/open-store";
import { type Store } from "../src/gateway/store";
import { bot, event, identity } from "./fixtures";

function reaction(name = "eyes", type = "reaction_added", id = "EvAdded") {
  return {
    api_app_id: "A123",
    team_id: "T123",
    event_id: id,
    event: {
      type,
      user: "U123",
      reaction: name,
      item: { type: "message", channel: "C123", ts: "2.000" },
      item_user: "UBOT",
      event_ts: "3.000",
    },
  };
}

const log = pino({ enabled: false });
const signal = new AbortController().signal;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function fixture(
  options: {
    enabled?: boolean;
    steer?: boolean;
    pinned?: boolean;
    store?: Store;
    notifications?: NotificationReader;
  } = {},
) {
  const store = options.store ?? openStore(":memory:");

  if (!options.store) {
    cleanups.push(() => store.close());
  }

  const config = bot();

  if (options.enabled !== undefined) {
    config.slack.inboundReactions = options.enabled;
  }

  config.slack.steerThreadFollowUps = options.steer ?? false;
  config.slackReadReceipts = true;
  config.waiting.delayMs = null;
  const prompts: string[] = [];
  const steers: SteerInput[] = [];

  const backend: AgentBackend = {
    ...(options.pinned || options.steer ? { sessionID: "ses_captain" } : {}),
    async createSession() {
      return "ses_captain";
    },
    async prompt(_session, text, _signal, _onText, _onInput, _files, context) {
      prompts.push(context ? `${sourceLine(context)}\n\n${text}` : text);

      return "[[stargate:react:thumbsup]]\nAnswer";
    },
    async steer(input) {
      if (!input.allowed()) {
        return { status: "refused" };
      }

      steers.push(input);

      return { status: "accepted" };
    },
    async close() {},
  };

  const userInfo = mock(async (user: string): Promise<unknown> => ({
    ok: true,
    user: { id: user, team_id: "T123", is_bot: false, deleted: false },
  }));

  const post = mock(async (_channel: string, _thread: string, _text: string) =>
    prompts.length === 1 ? "2.000" : "4.000",
  );

  const react = mock(async (_channel: string, _ts: string) => {});
  const readReceipt = mock(async (_channel: string, _ts: string) => {});
  const slack = { post, react, readReceipt, userInfo };

  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    log,
    undefined,
    undefined,
    undefined,
    options.notifications,
  );

  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1, true)[0];

    if (!job) {
      throw new Error("Expected a queued request");
    }

    return job;
  };

  return { config, store, gateway, backend, slack, next, prompts, steers };
}

test("confirmed final replies route after restart and Socket Mode retries do not duplicate either action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stargate-reaction-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.sqlite");
  const writer = openStore(path);

  try {
    const f = fixture({ store: writer });
    expect(await f.gateway.receive(event())).toBe(true);
    await f.gateway.process(f.next(), signal);
    expect(f.slack.post.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["C123", "1.000", "Answer"],
    ]);
  } finally {
    writer.close();
  }

  const first = openStore(path);

  try {
    const f = fixture({ enabled: true, store: first });

    const ack = mock(async () => {
      expect(f.store.queueCounts(f.gateway.key).queued).toBe(1);
    });

    await handleSlackRequest(
      { type: "events_api", body: reaction("+1"), ack },
      (body) => f.gateway.receive(body),
      log,
    );
    expect(ack).toHaveBeenCalledTimes(1);
    await f.gateway.process(f.next(), signal);
    expect(f.prompts[0]).toStartWith(
      "s=slack;c=C123;t=1.000;m=2.000;u=U123;reaction=%2B1;action=added\n",
    );
    expect(f.slack.react).not.toHaveBeenCalled();
    expect(f.slack.readReceipt).not.toHaveBeenCalled();
  } finally {
    first.close();
  }

  const reader = openStore(path);
  cleanups.push(() => reader.close());
  const f = fixture({ enabled: true, store: reader });
  expect(await f.gateway.receive(reaction("+1"))).toBe(false);
  const removed = reaction("+1", "reaction_removed", "EvRemoved");
  expect(await f.gateway.receive(removed)).toBe(true);
  expect(await f.gateway.receive(removed)).toBe(false);
  await f.gateway.process(f.next(), signal);
  expect(f.prompts[0]).toContain("u=U123;reaction=%2B1;action=removed");
});

test("only the specified Slack reaction names can wake a new turn", async () => {
  const f = fixture({ enabled: true });
  expect(await f.gateway.receive(event())).toBe(true);
  f.store.savePreview(f.next().id, 0, "2.000");

  const allowed = [
    "+1",
    "thumbsup",
    "-1",
    "thumbsdown",
    "white_check_mark",
    "heavy_check_mark",
    "x",
    "eyes",
  ];

  for (const [i, name] of allowed.entries()) {
    expect(
      await f.gateway.receive(reaction(name, "reaction_added", `Ev${i}`)),
    ).toBe(true);
  }

  for (const name of ["heart", "thumbsup::skin-tone-2", "check", "EYES"]) {
    expect(await f.gateway.receive(reaction(name))).toBe(false);
  }
});

test("parallel Slack verification preserves arrival order across reaction and text follow-ups", async () => {
  const f = fixture({ enabled: true });
  expect(await f.gateway.receive(event())).toBe(true);
  await f.gateway.process(f.next(), signal);

  const human = {
    ok: true,
    user: { id: "U123", team_id: "T123", is_bot: false, deleted: false },
  };

  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const slow = Promise.withResolvers<unknown>();
  f.slack.userInfo
    .mockImplementationOnce(() => {
      firstStarted.resolve();

      return slow.promise;
    })
    .mockImplementationOnce(async () => {
      secondStarted.resolve();

      return human;
    });
  const ack = mock(async () => {});

  const receive = (body: unknown) =>
    handleSlackRequest(
      { type: "events_api", body, ack },
      (raw) => f.gateway.receive(raw),
      log,
    );

  const added = receive(reaction());
  await firstStarted.promise;
  const follow = event("more context", "4.000");

  const text = receive({
    ...follow,
    event: { ...follow.event, thread_ts: "1.000" },
  });

  const removed = receive(reaction("eyes", "reaction_removed", "EvRemoved"));
  const retry = receive(reaction());
  await secondStarted.promise;
  slow.resolve(human);
  await Promise.all([added, text, removed, retry]);
  expect(ack).toHaveBeenCalledTimes(4);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(3);

  for (let i = 0; i < 3; i++) {
    await f.gateway.process(f.next(), signal);
  }

  expect(f.prompts.slice(1).map((prompt) => prompt.split("\n").at(-1))).toEqual(
    [
      "Slack reaction :eyes: added.",
      "more context",
      "Slack reaction :eyes: removed.",
    ],
  );
});

test("directory verification admits an explicitly allowed Slack Connect human", async () => {
  const f = fixture({ enabled: true });
  expect(await f.gateway.receive(event())).toBe(true);
  f.store.savePreview(f.next().id, 0, "2.000");
  f.config.access.users = ["U456"];
  const request = reaction();
  const external = { ...request, event: { ...request.event, user: "U456" } };
  const sharedUser = { id: "U456", team_id: "T456", deleted: false };
  f.slack.userInfo.mockResolvedValueOnce({
    ok: true,
    user: { ...sharedUser, is_bot: true },
  });
  expect(await f.gateway.receive(external)).toBe(false);
  f.slack.userInfo.mockResolvedValueOnce({
    ok: true,
    user: { ...sharedUser, is_bot: false },
  });
  expect(await f.gateway.receive(external)).toBe(true);
});

test("a confirmed activity post supplies local ownership and its exact running thread", async () => {
  const f = fixture({ enabled: true, steer: true });
  expect(await f.gateway.receive(event())).toBe(true);
  const owner = f.next();
  expect(f.store.running(owner.id, owner.text)).toBe(true);
  f.store.saveInput(f.gateway.key, owner.id, "msg_original", "ses_captain");
  const progress = { capture: "capture", revision: 1, done: false };
  f.store.activityRecords.saveActivity(owner.id, progress);
  expect(await f.gateway.receive(reaction())).toBe(false);
  f.store.activityRecords.saveActivity(owner.id, { ...progress, ts: "2.000" });
  expect(await f.gateway.receive(reaction())).toBe(true);
  await f.gateway.pollFollowUps(signal);
  expect(f.steers.map(({ context }) => sourceLine(context))).toEqual([
    "s=slack;c=C123;t=1.000;m=2.000;u=U123;reaction=eyes;action=added",
  ]);
});

test("flag off and untrusted reaction sources never reach the queue", async () => {
  const f = fixture();
  expect(f.config.slack.inboundReactions).toBe(false);
  expect(await f.gateway.receive(event())).toBe(true);
  f.store.savePreview(f.next().id, 0, "2.000");
  expect(await f.gateway.receive(reaction())).toBe(false);
  f.config.slack.inboundReactions = true;
  const valid = reaction();

  for (const body of [
    { ...valid, api_app_id: "A999" },
    { ...valid, team_id: "T999" },
    { ...valid, event: { ...valid.event, user: "UBOT" } },
    { ...valid, event: { ...valid.event, item_user: "U123" } },
    {
      ...valid,
      event: { ...valid.event, item: { ...valid.event.item, type: "file" } },
    },
    {
      ...valid,
      event: { ...valid.event, item: { ...valid.event.item, ts: "1.000" } },
    },
  ]) {
    expect(await f.gateway.receive(body)).toBe(false);
  }

  f.config.access.users = ["*"];
  f.config.access.channels = ["*"];
  f.config.access.deniedUsers = ["U123"];
  expect(await f.gateway.receive(valid)).toBe(false);
  f.config.access.deniedUsers = [];
  f.config.access.deniedChannels = ["C123"];
  expect(await f.gateway.receive(valid)).toBe(false);
  f.config.access.deniedChannels = [];
  f.config.access.mentionOnly = true;
  expect(await f.gateway.receive(valid)).toBe(false);
  f.config.access.mentionOnly = false;
  f.config.access.peerCaptains = true;
  f.slack.userInfo.mockResolvedValueOnce({
    ok: true,
    user: { id: "U123", team_id: "T123", is_bot: true, deleted: false },
  });
  expect(await f.gateway.receive(valid)).toBe(false);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(1);
  expect(await f.gateway.receive(valid)).toBe(true);
});

test("legacy preview targets steer only their running captain thread, not the reaction timestamp", async () => {
  const f = fixture({ enabled: true, steer: true });
  expect(await f.gateway.receive(event())).toBe(true);
  const owner = f.next();
  expect(f.store.running(owner.id, owner.text)).toBe(true);
  f.store.saveInput(f.gateway.key, owner.id, "msg_original", "ses_captain");
  f.store.savePreview(owner.id, 0, "2.000");
  expect(await f.gateway.receive(reaction())).toBe(true);
  expect(await f.gateway.receive(reaction())).toBe(false);
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(0);
  await f.gateway.pollFollowUps(signal);
  await f.gateway.pollFollowUps(signal);
  expect(f.steers).toHaveLength(1);
  const steer = f.steers[0];

  if (!steer) {
    throw new Error("Expected steer");
  }

  expect(steer.inputID).toBe("msg_original");
  expect(sourceLine(steer.context)).toBe(
    "s=slack;c=C123;t=1.000;m=2.000;u=U123;reaction=eyes;action=added",
  );
  expect(f.store.threadFollowUps.followUpLinks(owner.id)).toContain(
    "/archives/C123/p2000",
  );
  expect(f.slack.react).not.toHaveBeenCalled();
});

test("thread mutes block reaction admission and a mute after admission blocks steering", async () => {
  const preferences = new NotificationStore(":memory:");
  cleanups.push(() => preferences.close());
  const registration = "reg";

  const f = fixture({
    enabled: true,
    steer: true,
    notifications: (channel, thread) =>
      preferences.status(registration, channel, thread),
  });

  expect(await f.gateway.receive(event())).toBe(true);
  const owner = f.next();
  expect(f.store.running(owner.id, owner.text)).toBe(true);
  f.store.saveInput(f.gateway.key, owner.id, "msg_original", "ses_captain");
  f.store.savePreview(owner.id, 0, "2.000");
  expect(await f.gateway.receive(reaction())).toBe(true);
  preferences.operate(
    registration,
    { op: "mute", scope: "thread", channel: "C123", thread_ts: "1.000" },
    { id: "mute", caller: "U123", now: Date.now() },
  );
  expect(
    await f.gateway.receive(reaction("x", "reaction_added", "EvMuted")),
  ).toBe(false);
  await f.gateway.pollFollowUps(signal);
  expect(f.steers).toEqual([]);
  expect(f.slack.post).not.toHaveBeenCalled();
  expect(f.store.queueCounts(f.gateway.key).queued).toBe(0);
});

test.each([false, true])(
  "a busy reaction queues when steering is off or its target is in another thread (%s)",
  async (steer) => {
    const f = fixture({ enabled: true, pinned: true, steer });
    expect(await f.gateway.receive(event())).toBe(true);
    const owner = f.next();
    expect(f.store.running(owner.id, owner.text)).toBe(true);
    f.store.saveInput(f.gateway.key, owner.id, "msg_original", "ses_captain");

    if (steer) {
      expect(
        await f.gateway.receive(event("<@UBOT> another thread", "1.500")),
      ).toBe(true);
      const target = f.store.jobByEvent(f.gateway.key, "C123:1.500");

      if (!target) {
        throw new Error("Missing other thread");
      }

      f.store.savePreview(target.id, 0, "2.000");
    } else {
      f.store.savePreview(owner.id, 0, "2.000");
    }

    expect(await f.gateway.receive(reaction())).toBe(true);
    await f.gateway.pollFollowUps(signal);
    expect(f.steers).toEqual([]);
    const queued = f.store.jobByEvent(f.gateway.key, "reaction:EvAdded");
    expect(queued).toMatchObject({
      status: "queued",
      thread: steer ? "1.500" : "1.000",
    });
  },
);

test("an ordinary steer during a reaction turn retains its own Slack message identity", async () => {
  const f = fixture({ enabled: true, steer: true });
  expect(await f.gateway.receive(event())).toBe(true);
  await f.gateway.process(f.next(), signal);
  expect(await f.gateway.receive(reaction())).toBe(true);
  const owner = f.next();
  expect(f.store.running(owner.id, owner.text)).toBe(true);
  f.store.saveInput(f.gateway.key, owner.id, "msg_reaction", "ses_captain");
  const follow = event("<@UBOT> more context", "6.000");
  expect(
    await f.gateway.receive({
      ...follow,
      event: { ...follow.event, thread_ts: "1.000" },
    }),
  ).toBe(true);
  await f.gateway.pollFollowUps(signal);
  const steer = f.steers[0];

  if (!steer) {
    throw new Error("Expected steer");
  }

  expect(sourceLine(steer.context)).toBe(
    "s=slack;c=C123;t=1.000;m=6.000;u=U123",
  );
});

test("Slack fallback uses an exact message returned by the API, never claimed item ownership", async () => {
  const config = bot();
  config.slack.inboundReactions = true;
  const store = openStore(":memory:");
  cleanups.push(() => store.close());

  const message = {
    type: "message",
    user: "UBOT",
    ts: "2.000",
    thread_ts: "1.000",
  };

  let result: unknown = {
    ok: true,
    type: "message",
    channel: "C123",
    message,
  };

  const calls: string[] = [];

  const slack = new SlackConnection("fixture-app", "fixture-bot", log, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);

      if (url.pathname === "/api/users.info") {
        return Response.json({
          ok: true,
          user: { id: "U123", team_id: "T123", is_bot: false, deleted: false },
        });
      }

      expect(url.pathname).toBe("/api/reactions.get");
      const args = new URLSearchParams(String(init?.body));
      expect(args.get("channel")).toBe("C123");
      expect(args.get("timestamp")).toBe("2.000");

      return Response.json(result);
    },
  });

  const gateway = new Gateway(
    config,
    identity,
    store,
    {
      async createSession() {
        throw new Error("Intake does not create sessions");
      },
      async prompt() {
        throw new Error("Intake does not prompt");
      },
      async close() {},
    },
    slack satisfies TransportDelivery,
    log,
  );

  const valid = result;

  for (const candidate of [
    { ok: true, type: "message", channel: "C999", message },
    {
      ok: true,
      type: "message",
      channel: "C123",
      message: { ...message, user: "U456" },
    },
    {
      ok: true,
      type: "message",
      channel: "C123",
      message: { ...message, ts: "1.000" },
    },
    {
      ok: true,
      type: "message",
      channel: "C123",
      message: { ...message, app_id: "A999" },
    },
    {
      ok: true,
      type: "message",
      channel: "C123",
      message: { ...message, thread_ts: "garbled" },
    },
    {
      ok: true,
      type: "message",
      channel: "C123",
      message: { ...message, thread_ts: undefined, parent_user_id: "U123" },
    },
  ]) {
    result = candidate;
    expect(await gateway.receive(reaction())).toBe(false);
  }

  result = valid;
  expect(await gateway.receive(reaction())).toBe(true);
  expect(
    store.ready(botKey(config, identity), Number.MAX_SAFE_INTEGER, 1)[0]
      ?.thread,
  ).toBe("1.000");
  expect(calls).toContain("/api/reactions.get");
});
