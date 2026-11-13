import { expect, test } from "bun:test";
import pino from "pino";
import { stopBlock } from "../src/cancellation";
import { crewStatusView } from "../src/crew-ui";
import { handleSlackRequest, SlackConnection } from "../src/slack";
import { replyText } from "../src/slack-format";

test("crew UI consumes trigger for loading modal and updates that private view without posting messages", async () => {
  const calls: { path: string; fields: URLSearchParams }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({
        path: new URL(request.url).pathname,
        fields: new URLSearchParams(await request.text()),
      });
      return Response.json({ ok: true, view: { id: "V_CREW" } });
    },
  });
  const slack = new SlackConnection(
    "fixture-app",
    "fixture-bot",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
  );
  try {
    const view = crewStatusView(
      { members: [], total: 0, truncated: false },
      false,
    );
    const viewID = await slack.crewUI.open("fixture-trigger", view);
    expect(viewID).toBe("V_CREW");
    await slack.crewUI.update(viewID, view);
    expect(calls.map(({ path }) => path)).toEqual([
      "/views.open",
      "/views.update",
    ]);
    expect(calls[0]?.fields.get("trigger_id")).toBe("fixture-trigger");
    expect(calls[1]?.fields.get("view_id")).toBe("V_CREW");
    for (const call of calls)
      expect(JSON.parse(call.fields.get("view") ?? "null")).toEqual(view);
  } finally {
    await server.stop(true);
  }
});

test("Slack posts and edits preserve mixed Markdown with safe fallback; reactions use the fixed target", async () => {
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
  const slack = new SlackConnection(
    "local-app-token",
    "local-bot-token",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
  );
  try {
    const text = "<@UOTHER> **bold** & <https://example.test|Docs> <!here>";
    const prepared = slack.prepareReply(text)[0];
    if (!prepared || typeof prepared === "string")
      throw new Error("Expected classified content");
    expect(
      await slack.post(
        "C123",
        "1.000",
        prepared.text,
        undefined,
        undefined,
        prepared.content,
      ),
    ).toBe("2.000");
    await slack.update(
      "C123",
      "2.000",
      prepared.text,
      undefined,
      prepared.content,
    );
    await slack.react("C123", "1.000", "eyes");
    await slack.remove("C123", "2.000");
    expect(calls.map((call) => call.path)).toEqual([
      "/chat.postMessage",
      "/chat.update",
      "/reactions.add",
      "/chat.delete",
    ]);
    for (const call of calls.slice(0, 2)) {
      expect(JSON.parse(call.fields.get("blocks") ?? "null")).toEqual(
        prepared.content.blocks,
      );
      expect(call.fields.get("blocks")).toContain(
        '"type":"user","user_id":"UOTHER"',
      );
      if (call.path === "/chat.postMessage")
        expect(call.fields.get("mrkdwn")).toBe("false");
      expect(call.fields.get("text")).toBe(prepared.content.text);
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
    { slackApiUrl: server.url.href },
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
      {
        type: "section",
        text: { type: "plain_text", text: "Final", emoji: false },
      },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("Slack posts and streamed edits preserve classified Markdown", async () => {
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
    { slackApiUrl: server.url.href },
  );
  const text =
    "# Result\n\n**Bold**, _italic_, [docs](https://example.test).\n\n> Quote\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = a < b && c > d;\n```";
  try {
    const prepared = slack.prepareReply(text)[0];
    if (!prepared || typeof prepared === "string")
      throw new Error("Expected classified content");
    await slack.post(
      "C123",
      "1.000",
      prepared.text,
      undefined,
      undefined,
      prepared.content,
    );
    await slack.update(
      "C123",
      "2.000",
      prepared.text,
      undefined,
      prepared.content,
    );
    for (const payload of payloads) {
      expect(JSON.parse(payload.get("blocks") ?? "null")).toEqual(
        prepared.content.blocks,
      );
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
  const slack = new SlackConnection(
    "local-app-token",
    "local-bot-token",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
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

test("long mixed replies retain bounded element text and at most two outgoing blocks", async () => {
  const payloads: URLSearchParams[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      payloads.push(new URLSearchParams(await request.text()));
      return Response.json({ ok: true, ts: "2.000" });
    },
  });
  const slack = new SlackConnection(
    "fixture-app",
    "fixture-bot",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
  );
  try {
    const text = `${"🦘".repeat(2798)}<@U123>\n\n${"**bold** <#C123>\n\n".repeat(500)}\n\`\`\`\n${"<@U123> ".repeat(1000)}\n\`\`\``;
    const parts = slack.prepareReply(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.some((part) => replyText(part).includes("<@U123>"))).toBe(
      true,
    );
    for (const part of parts) {
      expect(Array.from(replyText(part)).length).toBeLessThanOrEqual(2800);
      await slack.post(
        "C123",
        "1.000",
        replyText(part),
        42,
        undefined,
        typeof part === "string" ? undefined : part.content,
      );
    }
    for (const payload of payloads) {
      const blocks: unknown = JSON.parse(payload.get("blocks") ?? "null");
      expect(Array.isArray(blocks)).toBe(true);
      if (!Array.isArray(blocks)) throw new Error("Missing blocks");
      expect(blocks.length).toBe(2); // One content block + Stop, below Slack's 50.
      const lengths: number[] = [];
      const inspect = (value: unknown) => {
        if (Array.isArray(value)) {
          for (const child of value) inspect(child);
        } else if (value && typeof value === "object")
          for (const [key, child] of Object.entries(value)) {
            if (key === "text" && typeof child === "string")
              lengths.push(Array.from(child).length);
            else inspect(child);
          }
      };
      inspect(blocks[0]);
      expect(Math.max(0, ...lengths)).toBeLessThanOrEqual(3000);
      expect(
        lengths.reduce((sum, length) => sum + length, 0),
      ).toBeLessThanOrEqual(12000);
      expect(Array.from(payload.get("text") ?? "").length).toBeLessThan(40000);
    }
  } finally {
    await server.stop(true);
  }
});

test("prepared quoted-code chunks reach Slack without reclassification", async () => {
  const payloads: URLSearchParams[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      payloads.push(new URLSearchParams(await request.text()));
      return Response.json({ ok: true, ts: "2.000" });
    },
  });
  const slack = new SlackConnection(
    "fixture-app",
    "fixture-bot",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
  );
  const quote =
    "> ```\n" +
    ("> " + "x".repeat(70) + "\n").repeat(60) +
    "> <@U123> ping\n" +
    ("> " + "y".repeat(70) + "\n").repeat(10) +
    "> ```\n\nActual mention <@U9>";
  try {
    const parts = slack.prepareReply(quote);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      if (typeof part === "string")
        throw new Error("Expected classified chunk");
      await slack.post(
        "C123",
        "1.000",
        part.text,
        undefined,
        undefined,
        part.content,
      );
      await slack.update("C123", "2.000", part.text, undefined, part.content);
    }
    const blocks = payloads.map((payload) => payload.get("blocks")).join("");
    expect(blocks).not.toContain('"user_id":"U123"');
    expect(blocks).toContain('"user_id":"U9"');
    expect(blocks).toContain('"code":true');
  } finally {
    await server.stop(true);
  }
});

test("legacy or unclassified chunks fail closed to literal Slack content", async () => {
  const payloads: URLSearchParams[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      payloads.push(new URLSearchParams(await request.text()));
      return Response.json({ ok: true, ts: "2.000" });
    },
  });
  const slack = new SlackConnection(
    "fixture-app",
    "fixture-bot",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
  );
  try {
    const text = "<@U123> code continuation **literal**";
    await slack.post("C123", "1.000", text);
    await slack.update("C123", "2.000", text);
    for (const payload of payloads) {
      expect(payload.get("blocks")).toContain('"type":"plain_text"');
      expect(payload.get("blocks")).not.toContain('"type":"user"');
    }
  } finally {
    await server.stop(true);
  }
});
