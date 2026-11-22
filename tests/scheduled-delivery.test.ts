import { expect, test } from "bun:test";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { CronScheduler } from "../src/cron/index";
import { CronStore } from "../src/cron/store";
import { Gateway } from "../src/gateway/gateway";
import { Store } from "../src/gateway/store";
import { bot, identity } from "./fixtures";

test("a due cron prompt runs through the existing gateway and replies in its scheduled thread", async () => {
  const store = new Store(":memory:");
  const schedules = new CronStore(":memory:");
  const config = bot();
  const log = pino({ enabled: false });
  const posts: { channel: string; thread: string; text: string }[] = [];
  const announcements: string[] = [];
  const prompts: string[] = [];
  const slack = {
    async announce(_channel: string, text: string) {
      announcements.push(text);
      return "20.000";
    },
    async post(channel: string, thread: string, text: string) {
      posts.push({ channel, thread, text });
    },
  };
  const backend: AgentBackend = {
    async createSession() {
      return "scheduled-session";
    },
    async prompt(_session, text) {
      prompts.push(text);
      return "Review complete.";
    },
    async close() {},
  };
  const gateway = new Gateway(config, identity, store, backend, slack, log);
  const scheduler = new CronScheduler(
    config,
    identity,
    schedules,
    gateway,
    slack,
    log,
  );
  const now = Date.parse("2026-11-06T10:00:00Z");
  const signal = new AbortController().signal;
  try {
    schedules.add(
      { botKey: gateway.key, channel: "C123", user: "U123" },
      {
        name: "Daily review",
        expression: "* * * * *",
        timezone: "UTC",
        prompt: "Review changes",
      },
      now,
    );
    await scheduler.tick(now + 60_000, signal);
    const job = store.ready(gateway.key, now + 60_000, 1)[0];
    if (!job) throw new Error("Scheduled prompt was not queued");
    expect(job.thread).toBe("20.000");
    await gateway.process(job, signal);
    await scheduler.tick(now + 60_000, signal);
    expect(announcements).toHaveLength(1);
    expect(prompts).toEqual(["Review changes"]);
    expect(posts).toEqual([
      { channel: "C123", thread: "20.000", text: "Review complete." },
    ]);
    expect(store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)).toEqual([]);
  } finally {
    schedules.close();
    store.close();
  }
});
