import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildConfigPanel, readConfigSnapshot } from "../src/config-panel";
import { CrewWaiting } from "../src/crew/waiting";
import type { SlackDelivery } from "../src/gateway";
import {
  configPanelRows,
  MetaCommands,
  type MetaOptions,
} from "../src/meta-commands";
import { notificationKey } from "../src/notifications";
import {
  resolveQuestionSettings,
  saveQuestionSettings,
} from "../src/question-settings";
import { Store } from "../src/store";
import { resolveWaiting, waitingSettingsPath } from "../src/waiting";
import { bot, event, identity } from "./fixtures";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const now = Date.parse("2026-11-18T12:00:00Z");

test("question buttons persist, repaint and do not replay after restart", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press("stargate_config_questions_on");
  await f.click(raw);
  expect((await resolveQuestionSettings(f.config)).enabled).toBe(true);
  expect(f.panel().text).toContain("questions: on");
  f.reopen();
  await f.click(raw);
  expect(f.replies).toEqual([]);
  await f.click(
    f.press(
      "stargate_config_questions_timeout_1h",
      f.panel(),
      "1795003200.002",
    ),
  );
  await f.click(
    f.press(
      "stargate_config_questions_answer_allowed",
      f.panel(),
      "1795003200.003",
    ),
  );
  expect(await resolveQuestionSettings(f.config)).toEqual({
    enabled: true,
    timeoutMs: 3_600_000,
    answer: "allowed",
  });
});

test("same-value question replacement invalidates panels including waiting actions", async () => {
  const f = await fixture();
  if (f.config.backend.type !== "opencode")
    throw new Error("Expected OpenCode");
  const settings = await resolveQuestionSettings(f.config);
  await saveQuestionSettings(
    f.config.backend.directory,
    "adama",
    settings,
    AbortSignal.timeout(5000),
  );
  await f.publish();
  await saveQuestionSettings(
    f.config.backend.directory,
    "adama",
    settings,
    AbortSignal.timeout(5000),
  );
  await f.click();
  expect(await f.delay()).toBe(5000);
  expect(f.replies.at(-1)).toContain("stale");
});

test("typed question commands preserve other settings and reject invalid values", async () => {
  const f = await fixture();
  let sequence = 10;
  for (const command of [
    "on",
    "timeout 5m",
    "timeout 15m",
    "timeout 1h",
    "answer allowed",
    "off",
    "answer requester",
  ]) {
    await f.meta.receive(
      event(`<@UBOT> /config questions ${command}`, `${sequence++}.000`),
      f.config,
      identity,
      () => true,
    );
  }
  const expected = {
    enabled: false,
    timeoutMs: 3_600_000,
    answer: "requester",
  } as const;
  expect(await resolveQuestionSettings(f.config)).toEqual(expected);
  for (const command of ["yes", "timeout 0", "timeout 2h", "answer everyone"]) {
    await f.meta.receive(
      event(`<@UBOT> /config questions ${command}`, `${sequence++}.000`),
      f.config,
      identity,
      () => true,
    );
    expect(await resolveQuestionSettings(f.config)).toEqual(expected);
    expect(f.posts.at(-1)?.text).toContain("Valid commands");
  }
});

test("question update failure resumes persisted receipt without a second write", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press("stargate_config_questions_on");
  const update = f.slack.update;
  if (!update) throw new Error("Expected update");
  f.slack.update = async () => {
    throw new Error("private failure");
  };
  await expect(f.click(raw)).rejects.toThrow();
  expect((await resolveQuestionSettings(f.config)).enabled).toBe(true);
  const snapshot = await readConfigSnapshot(f.config, undefined);
  f.reopen();
  f.slack.update = update;
  await f.click(raw);
  expect(f.panel().text).toContain("questions: on");
  expect(
    (await readConfigSnapshot(f.config, undefined)).questionsFingerprint,
  ).toBe(snapshot.questionsFingerprint);
});

test("panel snapshot refuses symbolic or oversized waiting files without following arbitrary content", async () => {
  const f = await fixture();
  if (f.config.backend.type !== "opencode") throw new Error("Invalid fixture");
  const path = waitingSettingsPath(f.config.backend.directory, "adama");
  await f.tool(5);
  await rm(path);
  const target = join(f.config.backend.directory, "foreign.json");
  await writeFile(target, JSON.stringify({ delayMs: 5000 }), { mode: 0o600 });
  await symlink(target, path);
  await expect(readConfigSnapshot(f.config, undefined)).rejects.toThrow();
  await rm(path);
  await writeFile(
    path,
    JSON.stringify({ delayMs: 5000, padding: "x".repeat(8192) }),
    { mode: 0o600 },
  );
  await expect(readConfigSnapshot(f.config, undefined)).rejects.toThrow();
});
const plain = (max: number) =>
  z.strictObject({
    type: z.literal("plain_text"),
    text: z.string().min(1).max(max),
    emoji: z.boolean().optional(),
  });
const buttonSchema = z.strictObject({
  type: z.literal("button"),
  action_id: z.string().min(1).max(255),
  text: plain(75),
  value: z.string().min(1).max(2000),
  accessibility_label: z.string().max(75).optional(),
});
const panelSchema = z.strictObject({
  text: z.string().min(1),
  blocks: z
    .array(
      z.union([
        z.strictObject({
          type: z.literal("section"),
          block_id: z.string().min(1).max(255),
          text: plain(3000),
        }),
        z.strictObject({
          type: z.literal("actions"),
          block_id: z.string().min(1).max(255),
          elements: z.array(buttonSchema).min(1).max(25),
        }),
      ]),
    )
    .min(1)
    .max(50),
});

async function fixture(options: MetaOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "config-panel-"));
  const config = Object.assign(bot(), { configPanelEnabled: true });
  if (config.backend.type !== "opencode") throw new Error("Expected OpenCode");
  config.backend.directory = directory;
  config.backend.agent = "adama";
  let store = new Store(join(directory, "gateway.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const posts: {
    channel: string;
    thread: string;
    text: string;
    content: unknown;
  }[] = [];
  const updates: {
    channel: string;
    ts: string;
    text: string;
    content: unknown;
  }[] = [];
  const acks: (Record<string, unknown> | undefined)[] = [];
  const replies: string[] = [];
  const order: string[] = [];
  const slack: SlackDelivery = {
    async post(channel, thread, text, _stop, _unit, content) {
      order.push("post");
      posts.push({ channel, thread, text, content });
      return "100.001";
    },
    async update(channel, ts, text, _stop, content) {
      order.push("update");
      updates.push({ channel, ts, text, content });
      return true;
    },
    async ephemeral(_channel, _user, _thread, text) {
      replies.push(text);
    },
  };
  let clock = now;
  const metaOptions: MetaOptions = {
    now: () => clock,
    listMutes: () => ({
      settings: [],
      counts: { channel: 0, thread: 0 },
      cursor: null,
    }),
    isHuman: async () => true,
    ...options,
  };
  let meta = new MetaCommands(store, slack, metaOptions);
  const waiting = new CrewWaiting({
    options: {
      captainDirectory: directory,
      team: { captain: { id: "adama" } },
    },
    async captain(caller: { agent: string }) {
      if (caller.agent !== "adama") throw new Error("Not captain");
    },
  });
  const caller = {
    agent: "adama",
    sessionID: "ses_existing",
    signal: new AbortController().signal,
  };
  const ack = async (payload?: Record<string, unknown>) => {
    order.push("ack");
    acks.push(payload);
  };
  const panel = () => {
    const result = updates.at(-1)?.content ?? posts.at(-1)?.content;
    expect(result).toBeDefined();
    return panelSchema.parse(result);
  };
  const press = (
    actionId = "stargate_config_waiting_3",
    source = panel(),
    actionTs = "1795003200.001",
  ) => {
    const button = source.blocks
      .flatMap((block) => (block.type === "actions" ? block.elements : []))
      .find((item) => item.action_id === actionId);
    if (!button) throw new Error(`Missing ${actionId}`);
    return {
      type: "block_actions",
      api_app_id: config.slack.appId,
      team: { id: identity.team },
      user: { id: "U123" },
      channel: { id: "C123" },
      container: { type: "message", channel_id: "C123", message_ts: "100.001" },
      message: { user: identity.user, ts: "100.001", thread_ts: "1.000" },
      actions: [
        {
          type: "button",
          action_id: button.action_id,
          value: button.value,
          action_ts: actionTs,
        },
      ],
    };
  };
  return {
    config,
    slack,
    posts,
    updates,
    acks,
    replies,
    order,
    panel,
    press,
    ack,
    options: metaOptions,
    get store() {
      return store;
    },
    get meta() {
      return meta;
    },
    clock(value: number) {
      clock = value;
    },
    async publish() {
      await meta.receive(
        event("<@UBOT> /config"),
        config,
        identity,
        () => true,
      );
      return panel();
    },
    async tool(seconds: number | "off") {
      await waiting.run({ seconds }, caller);
    },
    async delay() {
      return (await resolveWaiting(config)).delayMs;
    },
    async click(raw: unknown = press(), open = () => true) {
      return meta.interactive(raw, config, identity, open, ack);
    },
    reopen() {
      store.close();
      store = new Store(join(directory, "gateway.sqlite"));
      meta = new MetaCommands(store, slack, metaOptions);
    },
  };
}

test("panel flag off lists question settings and typed commands", async () => {
  const f = await fixture();
  f.config.configPanelEnabled = false;
  await f.meta.receive(
    event("<@UBOT> /config"),
    f.config,
    identity,
    () => true,
  );
  expect(f.posts[0]?.text).toBe(
    "waiting: 5 seconds\nquestions: off; timeout: 15m; answer: requester\nmutes (read-only): 0 channels, 0 threads\nValid commands:\n/help\n/health [host|agents|stargate|opencode|proxy|services|starfleet]\n/config\n/config waiting <0..3600|off>\n/config questions <on|off>\n/config questions timeout <5m|15m|1h>\n/config questions answer <requester|allowed>\n/config mutes\n/config system1 <on|off>",
  );
  expect(f.posts[0]?.content).toBeUndefined();
  expect(f.updates).toEqual([]);
  expect(bot().configPanelEnabled).toBe(false);
});

test("enabled panel has six table-derived rows and bounded plain controls", async () => {
  const f = await fixture();
  const panel = await f.publish();
  const sections = panel.blocks.filter((block) => block.type === "section");
  expect(sections).toHaveLength(6);
  expect(sections.map((block) => block.text.text).join("\n")).toContain(
    "System One",
  );
  expect(panel.text).toContain("waiting: 5 seconds");
  expect(panel.text).toContain("mutes (read-only): 0 channels, 0 threads");
  expect(panel.text).toContain("U123");
  expect(panel.text).toContain(new Date(now).toISOString());
  expect(panel.text).not.toMatch(/<[@!#]|mrkdwn/);
  expect(new Set(panel.blocks.map((block) => block.block_id)).size).toBe(
    panel.blocks.length,
  );
  const buttons = panel.blocks.flatMap((block) =>
    block.type === "actions" ? block.elements : [],
  );
  expect(buttons.map((button) => button.text.text)).toEqual([
    "Off",
    "3s",
    "10s",
    "On",
    "Off",
    "5m",
    "15m",
    "1h",
    "Requester",
    "Allowed",
    "On",
    "Off",
  ]);
  for (const block of panel.blocks) {
    if (block.type === "actions")
      expect(
        new Set(block.elements.map((button) => button.action_id)).size,
      ).toBe(block.elements.length);
  }
  expect(f.posts[0]).toMatchObject({ channel: "C123", thread: "1.000" });
  expect(configPanelRows().map((row) => row.title)).toEqual([
    "waiting",
    "questions",
    "questions timeout",
    "questions answer",
    "mutes (read-only)",
    "System One",
  ]);
});

test("pure builder accepts only table-derived controls and produces a valid synthetic fixture", () => {
  const panel = panelSchema.parse(
    buildConfigPanel(configPanelRows(), {
      nonce: "00000000-0000-4000-8000-000000000000",
      revision: 1,
      user: "U123",
      at: now,
      snapshot: {
        delayMs: null,
        waitingFingerprint: "synthetic",
        questions: { enabled: false, timeoutMs: 900_000, answer: "requester" },
        questionsFingerprint: "synthetic",
        mutes: "0 channels, 0 threads",
        mutesFingerprint: "synthetic",
      },
    }),
  );
  expect(panel.text).toContain("waiting: off");
  expect(panel.blocks.filter((block) => block.type === "section")).toHaveLength(
    6,
  );
});

test("waiting button shares CrewWaiting, updates the bound message, ACKs before update", async () => {
  const f = await fixture();
  const old = await f.publish();
  f.order.length = 0;
  expect(await f.click()).toBe(true);
  expect(await f.delay()).toBe(3000);
  expect(f.order).toEqual(["ack", "update"]);
  expect(f.posts).toHaveLength(1);
  expect(f.updates.at(-1)).toMatchObject({ channel: "C123", ts: "100.001" });
  const panel = f.panel();
  expect(panel.text).toContain("waiting: 3 seconds");
  expect(panel.text).toContain("U123");
  expect(panel.text).toContain(new Date(now).toISOString());
  expect(
    panel.blocks.every(
      (block) =>
        !old.blocks.some((previous) => previous.block_id === block.block_id),
    ),
  ).toBe(true);
  await f.tool(8);
  expect(await f.delay()).toBe(8000);
});

for (const id of [
  "stargate_config_waiting_off",
  "stargate_config_waiting_10",
]) {
  test(`${id} maps only to its table command`, async () => {
    const f = await fixture();
    await f.publish();
    await f.click(f.press(id));
    expect(await f.delay()).toBe(id.endsWith("off") ? null : 10000);
  });
}

for (const id of [
  "stargate_config_system1_on",
  "stargate_config_system1_off",
]) {
  test(`${id} remains exactly reserved`, async () => {
    const f = await fixture();
    await f.publish();
    const updates = f.updates.length;
    await f.click(f.press(id));
    expect(f.acks).toEqual([undefined]);
    expect(f.replies).toEqual(["not available yet (NET-1709)"]);
    expect(await f.delay()).toBe(5000);
    expect(f.updates).toHaveLength(updates);
  });
}

type Press = ReturnType<Awaited<ReturnType<typeof fixture>>["press"]>;
function firstAction(raw: Press) {
  const action = raw.actions[0];
  if (!action) throw new Error("Expected config action");
  return action;
}
const invalidPresses: [string, (raw: Press) => unknown][] = [
  ["wrong app", (raw) => ({ ...raw, api_app_id: "AOTHER" })],
  ["wrong team", (raw) => ({ ...raw, team: { id: "TOTHER" } })],
  ["wrong user", (raw) => ({ ...raw, user: { id: "UOTHER" } })],
  ["wrong channel", (raw) => ({ ...raw, channel: { id: "COTHER" } })],
  [
    "container channel",
    (raw) => ({
      ...raw,
      container: { ...raw.container, channel_id: "COTHER" },
    }),
  ],
  [
    "container type",
    (raw) => ({ ...raw, container: { ...raw.container, type: "view" } }),
  ],
  [
    "message captain",
    (raw) => ({ ...raw, message: { ...raw.message, user: "UOTHER" } }),
  ],
  [
    "message ts",
    (raw) => ({ ...raw, message: { ...raw.message, ts: "100.002" } }),
  ],
  [
    "stored message ts",
    (raw) => ({
      ...raw,
      container: { ...raw.container, message_ts: "100.002" },
      message: { ...raw.message, ts: "100.002" },
    }),
  ],
  [
    "thread",
    (raw) => ({ ...raw, message: { ...raw.message, thread_ts: "2.000" } }),
  ],
  ["self", (raw) => ({ ...raw, user: { id: "UBOT" } })],
  ["Slackbot", (raw) => ({ ...raw, user: { id: "USLACKBOT" } })],
  ["is_bot", (raw) => ({ ...raw, user: { id: "U123", is_bot: true } })],
  [
    "user bot_id",
    (raw) => ({ ...raw, user: { id: "U123", bot_id: "BOTHER" } }),
  ],
  ["body bot_id", (raw) => ({ ...raw, bot_id: "BOTHER" })],
  [
    "duplicate actions",
    (raw) => ({ ...raw, actions: [...raw.actions, ...raw.actions] }),
  ],
  [
    "invalid action timestamp",
    (raw) => ({
      ...raw,
      actions: raw.actions.map((action) => ({ ...action, action_ts: "NaN" })),
    }),
  ],
  [
    "tampered value",
    (raw) => ({
      ...raw,
      actions: raw.actions.map((action) => ({
        ...action,
        value: `${action.value}:waiting=9000`,
      })),
    }),
  ],
  [
    "forged nonce",
    (raw) => ({
      ...raw,
      actions: raw.actions.map((action) => ({
        ...action,
        value: "00000000-0000-4000-8000-000000000000:0",
      })),
    }),
  ],
];
for (const [name, alter] of invalidPresses) {
  test(`${name} is refused locally without a write`, async () => {
    const f = await fixture();
    await f.publish();
    const count = f.updates.length;
    await f.click(alter(f.press()));
    expect(await f.delay()).toBe(5000);
    expect(f.acks).toHaveLength(1);
    expect(f.acks).toEqual([undefined]);
    expect(f.updates).toHaveLength(count);
    expect(f.posts).toHaveLength(1);
  });
}

for (const lookup of [
  undefined,
  async () => false,
  async () => {
    throw new Error("private lookup");
  },
]) {
  test(`verified human lookup fails closed: ${String(lookup)}`, async () => {
    const f = await fixture();
    f.config.access.users = ["*"];
    f.config.access.peerCaptains = true;
    if (lookup) f.options.isHuman = lookup;
    else delete f.options.isHuman;
    await f.publish();
    await f.click();
    expect(await f.delay()).toBe(5000);
    expect(f.replies[0]).not.toContain("private lookup");
    expect(f.replies).toHaveLength(1);
  });
}

for (const deny of ["deniedUsers", "deniedChannels"] as const) {
  test(`${deny} overrides wildcard panel access`, async () => {
    const f = await fixture();
    await f.publish();
    f.config.access.users = ["*"];
    f.config.access.channels = ["*"];
    f.config.access[deny] = [deny === "deniedUsers" ? "U123" : "C123"];
    await f.click();
    expect(await f.delay()).toBe(5000);
    expect(f.replies).toHaveLength(deny === "deniedChannels" ? 0 : 1);
  });
}

for (const delta of [-1, 86_400_001]) {
  test(`panel clock bound ${delta} rejects stale/future panels`, async () => {
    const f = await fixture();
    await f.publish();
    f.clock(now + delta);
    await f.click();
    expect(await f.delay()).toBe(5000);
    expect(f.replies[0]).toContain("/config");
  });
}

test("typed and tool writes, including ABA, invalidate the posted snapshot", async () => {
  for (const kind of ["tool", "typed", "ABA"]) {
    const f = await fixture();
    if (kind === "ABA") await f.tool(5);
    await f.publish();
    if (kind === "typed")
      await f.meta.receive(
        event("<@UBOT> /config waiting 8", "2.000"),
        f.config,
        identity,
        () => true,
      );
    else {
      await f.tool(3);
      if (kind === "ABA") await f.tool(5);
    }
    const before = await f.delay();
    await f.click();
    expect(await f.delay()).toBe(before);
    expect(f.replies[0]).toContain("stale");
  }
});

test("changed mute snapshot invalidates a panel without exposing reasons", async () => {
  const f = await fixture();
  await f.publish();
  f.options.listMutes = () => ({
    settings: [],
    cursor: null,
    counts: { channel: 1, thread: 0 },
  });
  await f.click();
  expect(await f.delay()).toBe(5000);
  expect(f.replies[0]).toContain("stale");
});

test("old revision and simultaneous distinct clicks cannot both apply", async () => {
  const f = await fixture();
  const panel = await f.publish();
  const first = f.press("stargate_config_waiting_3", panel);
  const second = f.press("stargate_config_waiting_10", panel, "1795003200.002");
  await Promise.all([f.click(first), f.click(second)]);
  expect(await f.delay()).toBe(3000);
  expect(f.replies.some((reply) => reply.includes("stale"))).toBe(true);
  await f.click(f.press("stargate_config_waiting_10", panel, "1795003200.003"));
  expect(await f.delay()).toBe(3000);
});

test("unknown own action is consumed; Stop, cron and pairing are not", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press();
  raw.actions[0] = {
    ...firstAction(raw),
    action_id: "stargate_config_unknown",
  };
  expect(await f.click(raw)).toBe(true);
  expect(f.replies[0]).toContain("/config");
  for (const id of ["stargate_stop", "stargate_cron_save", "stargate_pair"]) {
    raw.actions[0] = { ...firstAction(raw), action_id: id };
    expect(await f.click(raw)).toBe(false);
  }
  expect(f.acks).toHaveLength(1);
  expect(await f.delay()).toBe(5000);
});

test("duplicate message, app mention and restart reuse the persisted publication", async () => {
  const f = await fixture();
  const panel = await f.publish();
  f.reopen();
  await f.meta.receive(
    event("<@UBOT> /config"),
    f.config,
    identity,
    () => true,
  );
  const raw = event("<@UBOT> /config");
  await f.meta.receive(
    { ...raw, event: { ...raw.event, type: "message" } },
    f.config,
    identity,
    () => true,
  );
  expect(f.posts).toHaveLength(1);
  await f.click(f.press("stargate_config_waiting_3", panel));
  expect(await f.delay()).toBe(3000);
});

test("duplicate applied button after restart never overwrites an intervening tool write", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press();
  await f.click(raw);
  const appliedUpdates = f.updates.length;
  await f.click(raw);
  expect(f.updates).toHaveLength(appliedUpdates);
  f.reopen();
  await f.tool(8);
  const updates = f.updates.length;
  await f.click(raw);
  expect(await f.delay()).toBe(8000);
  expect(f.updates).toHaveLength(updates);
  expect(f.replies.at(-1)).toContain("stale");
});

for (const external of [false, true]) {
  test(`failed update retries only the stored outcome, external write=${external}`, async () => {
    const f = await fixture();
    await f.publish();
    const raw = f.press();
    const update = f.slack.update;
    if (!update) throw new Error("Expected update");
    f.slack.update = async () => {
      throw new Error("private Slack error");
    };
    await expect(f.click(raw)).rejects.toThrow();
    expect(f.acks).toHaveLength(1);
    expect(await f.delay()).toBe(3000);
    f.reopen();
    if (external) await f.tool(8);
    f.slack.update = update;
    const before = f.updates.length;
    await f.click(raw);
    expect(await f.delay()).toBe(external ? 8000 : 3000);
    if (external) {
      expect(f.updates).toHaveLength(before);
      expect(f.replies.at(-1)).toContain("stale");
    } else expect(f.panel().text).toContain("waiting: 3 seconds");
    expect(f.acks).toHaveLength(2);
  });
}

test("a pending button claim survives restart without applying or replaying", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press();
  const [nonce, revision] = firstAction(raw).value.split(":");
  f.store.claimMeta({
    registration: notificationKey(f.config, identity),
    message: `panel:${nonce}:${revision}:${firstAction(raw).action_ts}`,
    channel: "C123",
    thread: "1.000",
    user: "U123",
    at: now,
    command: "/config waiting <0..3600|off>",
  });
  f.reopen();
  await f.click(raw);
  expect(await f.delay()).toBe(5000);
  expect(f.replies[0]).toContain("unconfirmed");
});

test("closed intake withholds ACK; later binding changes prevent writes and replies", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({
    isHuman: async () => {
      entered.resolve();
      await release.promise;
      return true;
    },
  });
  await f.publish();
  const count = f.updates.length;
  await expect(f.click(f.press(), () => false)).rejects.toThrow();
  let open = true;
  const pending = f.click(f.press(), () => open);
  await entered.promise;
  open = false;
  release.resolve();
  await expect(pending).rejects.toThrow();
  expect(await f.delay()).toBe(5000);
  expect(f.acks).toEqual([undefined]);
  expect(f.replies).toEqual([]);
  expect(f.updates).toHaveLength(count);
});

test("disabled flag and independent registration refuse retained panels", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press();
  f.config.configPanelEnabled = false;
  await f.click(raw);
  f.config.configPanelEnabled = true;
  const other = { ...f.config, id: "other" };
  await f.meta.interactive(raw, other, identity, () => true, f.ack);
  expect(await f.delay()).toBe(5000);
  expect(f.acks).toHaveLength(2);
  expect(f.acks).toEqual([undefined, undefined]);
  expect(f.replies).toHaveLength(2);
});

test("transports without update or returned ts never advertise mutable controls", async () => {
  for (const missing of ["update", "ts"]) {
    const f = await fixture();
    if (missing === "update") delete f.slack.update;
    else {
      const post = f.slack.post;
      f.slack.post = async (...args) => {
        await post(...args);
      };
    }
    await f.meta.receive(
      event("<@UBOT> /config"),
      f.config,
      identity,
      () => true,
    );
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.content).toBeUndefined();
    expect(f.updates).toEqual([]);
    expect(await f.delay()).toBe(5000);
  }
});

test("ambiguous initial post cannot publish a new nonce on event retry", async () => {
  const f = await fixture();
  let posts = 0;
  f.slack.post = async () => {
    posts++;
    throw new Error("post uncertain");
  };
  await expect(
    f.meta.receive(event("<@UBOT> /config"), f.config, identity, () => true),
  ).rejects.toThrow();
  f.reopen();
  await f.meta.receive(
    event("<@UBOT> /config"),
    f.config,
    identity,
    () => true,
  );
  expect(posts).toBe(1);
  expect(f.updates).toEqual([]);
});

test("panel audit retains actor, time and old/new waiting values only", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press();
  await f.click(raw);
  const [nonce, revision] = firstAction(raw).value.split(":");
  expect(
    f.store.metaReceipt(
      notificationKey(f.config, identity),
      `panel:${nonce}:${revision}:${firstAction(raw).action_ts}`,
    ),
  ).toMatchObject({
    user: "U123",
    at: now,
    channel: "C123",
    thread: "1.000",
    oldDelayMs: 5000,
    newDelayMs: 3000,
    state: "applied",
    delivered: 1,
  });
});

test("ACK precedes both an existing shared-tail health read and human lookup", async () => {
  const healthEntered = Promise.withResolvers<void>();
  const healthRelease = Promise.withResolvers<void>();
  const humanEntered = Promise.withResolvers<void>();
  const humanRelease = Promise.withResolvers<void>();
  const f = await fixture({
    health: async () => {
      healthEntered.resolve();
      await healthRelease.promise;
      return "local health";
    },
    isHuman: async () => {
      humanEntered.resolve();
      await humanRelease.promise;
      return true;
    },
  });
  await f.publish();
  const health = f.meta.receive(
    event("<@UBOT> /health", "2.000"),
    f.config,
    identity,
    () => true,
  );
  await healthEntered.promise;
  const press = f.click();
  expect(f.acks).toEqual([undefined]);
  expect(await f.delay()).toBe(5000);
  healthRelease.resolve();
  await humanEntered.promise;
  expect(f.acks).toEqual([undefined]);
  humanRelease.resolve();
  await Promise.all([health, press]);
  expect(await f.delay()).toBe(3000);
});

test("waiting publication TTL remains the original time after a panel update", async () => {
  const f = await fixture();
  await f.publish();
  f.clock(now + 86_399_000);
  await f.click();
  const panel = f.panel();
  expect(panel.text).toContain(new Date(now + 86_399_000).toISOString());
  f.clock(now + 86_400_001);
  await f.click(f.press("stargate_config_waiting_10", panel, "1795089600.002"));
  expect(await f.delay()).toBe(3000);
  expect(f.replies.at(-1)).toContain("stale");
});

test("binding invalidation after durable apply retains the outcome without updating Slack", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press();
  let open = true;
  const apply = f.store.applyConfigPanel.bind(f.store);
  f.store.applyConfigPanel = (...args) => {
    apply(...args);
    open = false;
  };
  const count = f.updates.length;
  await expect(f.click(raw, () => open)).rejects.toThrow();
  expect(await f.delay()).toBe(3000);
  expect(f.acks).toEqual([undefined]);
  expect(f.updates).toHaveLength(count);
  f.reopen();
  await f.click(raw);
  expect(await f.delay()).toBe(3000);
  expect(f.panel().text).toContain("waiting: 3 seconds");
});

test("a tool write between apply and snapshot cannot be painted as the button's setting", async () => {
  const f = await fixture();
  await f.publish();
  const raw = f.press();
  let reads = 0;
  f.options.listMutes = async () => {
    if (++reads === 3) await f.tool(8);
    return { settings: [], cursor: null, counts: { channel: 0, thread: 0 } };
  };
  const count = f.updates.length;
  await f.click(raw);
  expect(await f.delay()).toBe(8000);
  expect(f.updates).toHaveLength(count);
  expect(f.replies.at(-1)).toContain("stale");
  await f.click(raw);
  expect(await f.delay()).toBe(8000);
  expect(f.updates).toHaveLength(count);
});
