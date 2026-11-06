import { expect, test } from "bun:test";
import { WebClient } from "@slack/web-api";
import pino from "pino";
import { stopBlock } from "../src/cancellation";
import { handleSlackRequest, SlackConnection } from "../src/slack";

test("Slack previews and edits keep plain text; reactions use the fixed target", async () => {
  const calls: { path: string; fields: URLSearchParams }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, fields: new URLSearchParams(await request.text()) });
      if (
        path === "/chat.update" &&
        calls.at(-1)?.fields.get("ts") === "missing"
      )
        return Response.json({ ok: false, error: "message_not_found" });
      if (path === "/reactions.add")
        return Response.json({ ok: false, error: "already_reacted" });
      if (path === "/chat.delete")
        return Response.json({ ok: false, error: "message_not_found" });
      return Response.json({ ok: true, ts: "2.000" });
    },
  });
  const web = new WebClient("local-test-token", {
    slackApiUrl: server.url.href,
    retryConfig: { retries: 0 },
  });
  const slack = new SlackConnection(
    "local-app-token",
    "local-bot-token",
    pino({ enabled: false }),
    web,
  );
  try {
    const text = "<@UOTHER> & <https://example.test>";
    expect(await slack.post("C123", "1.000", text)).toBe("2.000");
    await slack.update("C123", "2.000", text);
    await slack.react("C123", "1.000", "eyes");
    await slack.remove("C123", "2.000");
    expect(calls.map((call) => call.path)).toEqual([
      "/chat.postMessage",
      "/chat.update",
      "/reactions.add",
      "/chat.delete",
    ]);
    for (const call of calls.slice(0, 2)) {
      expect(JSON.parse(call.fields.get("blocks") ?? "null")).toEqual([
        { type: "section", text: { type: "plain_text", text, emoji: false } },
      ]);
      expect(call.fields.get("text")).toBe(
        "&lt;@UOTHER&gt; &amp; &lt;https://example.test&gt;",
      );
      expect(call.fields.get("parse")).toBe("none");
    }
    expect(calls[2]?.fields.get("timestamp")).toBe("1.000");
    expect(calls[2]?.fields.get("name")).toBe("eyes");
    expect(await slack.update("C123", "missing", "Replacement")).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("Stop controls appear only on live posts and edits and disappear on final delivery", async () => {
  const payloads: URLSearchParams[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      payloads.push(new URLSearchParams(await request.text()));
      return Response.json({ ok: true, ts: "2.000" });
    },
  });
  const slack = new SlackConnection(
    "local-app-token",
    "local-bot-token",
    pino({ enabled: false }),
    new WebClient("local-test-token", {
      slackApiUrl: server.url.href,
      retryConfig: { retries: 0 },
    }),
  );
  try {
    await slack.post("C123", "1.000", "Working", 42);
    await slack.update("C123", "2.000", "Partial", 42);
    await slack.update("C123", "2.000", "Final");
    for (const payload of payloads.slice(0, 2)) {
      const blocks = JSON.parse(payload.get("blocks") ?? "null");
      expect(blocks.at(-1)).toEqual(stopBlock(42));
      expect(blocks.at(-1).elements[0]).toMatchObject({
        type: "button",
        action_id: "pogo_stop",
        value: "42",
        text: { type: "plain_text", text: "Stop" },
      });
    }
    expect(JSON.parse(payloads[2]?.get("blocks") ?? "null")).toEqual([
      { type: "markdown", text: "Final" },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("Slack posts and streamed edits render agent Markdown without rewriting it", async () => {
  const payloads: URLSearchParams[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      payloads.push(new URLSearchParams(await request.text()));
      return Response.json({ ok: true, ts: "2.000" });
    },
  });
  const web = new WebClient("local-test-token", {
    slackApiUrl: server.url.href,
    retryConfig: { retries: 0 },
  });
  const slack = new SlackConnection(
    "local-app-token",
    "local-bot-token",
    pino({ enabled: false }),
    web,
  );
  const text =
    "# Result\n\n**Bold**, _italic_, [docs](https://example.test).\n\n> Quote\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = a < b && c > d;\n```";
  try {
    await slack.post("C123", "1.000", text);
    await slack.update("C123", "2.000", text);
    for (const payload of payloads) {
      expect(JSON.parse(payload.get("blocks") ?? "null")).toEqual([
        { type: "markdown", text },
      ]);
      expect(payload.get("text")).toContain("a &lt; b &amp;&amp; c &gt; d");
      expect(payload.get("parse")).toBe("none");
    }
  } finally {
    await server.stop(true);
  }
});

test("Socket Mode commands and interactions are not double-ACKed as message events", async () => {
  const calls: string[] = [];
  const log = pino({ enabled: false });
  const accept = () => {
    calls.push("persist");
    return true;
  };
  const handlers = {
    async command(_body: unknown, ack: () => Promise<void>) {
      calls.push("command");
      await ack();
    },
    async interactive(_body: unknown, ack: () => Promise<void>) {
      calls.push("interactive");
      await ack();
    },
  };
  for (const type of ["events_api", "slash_commands", "interactive"]) {
    await handleSlackRequest(
      {
        type,
        body: {},
        ack: async () => {
          calls.push("ack");
        },
      },
      accept,
      log,
      handlers,
    );
  }
  expect(calls).toEqual([
    "persist",
    "ack",
    "command",
    "ack",
    "interactive",
    "ack",
  ]);
});

test("Socket Mode does not ACK an event when durable acceptance fails", async () => {
  let acknowledged = false;
  await handleSlackRequest(
    {
      type: "events_api",
      body: {},
      ack: async () => {
        acknowledged = true;
      },
    },
    () => {
      throw new Error("Database unavailable");
    },
    pino({ enabled: false }),
  );
  expect(acknowledged).toBe(false);
});

test("Slack opens, pushes, and updates cron views and posts scheduled roots", async () => {
  const calls: { path: string; fields: URLSearchParams }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      calls.push({
        path: new URL(request.url).pathname,
        fields: new URLSearchParams(await request.text()),
      });
      return Response.json({ ok: true, ts: "8.000" });
    },
  });
  const web = new WebClient("local-test-token", {
    slackApiUrl: server.url.href,
    retryConfig: { retries: 0 },
  });
  const slack = new SlackConnection(
    "local-app-token",
    "local-bot-token",
    pino({ enabled: false }),
    web,
  );
  const view = {
    type: "modal" as const,
    title: { type: "plain_text" as const, text: "Cron jobs" },
    blocks: [],
  };
  try {
    await slack.cronUI.open("trigger", view);
    await slack.cronUI.push("trigger-2", view);
    await slack.cronUI.update("view", "hash", view);
    expect(await slack.announce("C123", "Scheduled task: Review")).toBe(
      "8.000",
    );
    expect(calls.map((c) => c.path)).toEqual([
      "/views.open",
      "/views.push",
      "/views.update",
      "/chat.postMessage",
    ]);
    expect(calls[0]?.fields.get("trigger_id")).toBe("trigger");
    expect(calls[1]?.fields.get("trigger_id")).toBe("trigger-2");
    expect(calls[2]?.fields.get("view_id")).toBe("view");
    expect(calls[2]?.fields.get("hash")).toBe("hash");
    expect(calls[3]?.fields.has("thread_ts")).toBe(false);
    await expect(
      slack.announce("C123", "Canceled", AbortSignal.abort()),
    ).rejects.toThrow();
    expect(calls).toHaveLength(4);
  } finally {
    await server.stop(true);
  }
});
