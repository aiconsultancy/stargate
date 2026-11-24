import { expect, test } from "bun:test";
import pino from "pino";
import type { ActivityView } from "../src/chat/activity/activity";
import { activityContent } from "../src/chat/activity/activity-slack";
import { SlackConnection } from "../src/transports/slack/slack";

function view(overrides: Partial<ActivityView> = {}): ActivityView {
  return {
    id: "private-report-id",
    revision: 1,
    status: "collecting",
    reporter: "Twiki",
    summary: "Apollo is checking the implementation.",
    summaryCurrent: true,
    entries: [
      {
        id: 1,
        taskID: "private-task-id",
        member: "Apollo",
        kind: "assignment",
        text: "Check implementation",
      },
    ],
    truncated: false,
    detail: "summary",
    ...overrides,
  };
}

test("activity summary is collapsed, accessible, and excludes raw entries and IDs", () => {
  const content = activityContent(view());
  expect(content.blocks[0]).toMatchObject({
    type: "container",
    title: { type: "plain_text", text: "Crew activity" },
    subtitle: { type: "plain_text", text: "Twiki — Collecting activity" },
    is_collapsible: true,
    default_collapsed: true,
  });
  expect(content.text).toContain("Crew activity — Twiki — Collecting activity");
  expect(content.text).toContain("Apollo is checking the implementation.");
  expect(JSON.stringify(content)).not.toContain("Check implementation");
  expect(JSON.stringify(content)).not.toContain("private-");
});

test("summary mode shows the latest five journal facts without a model summary", () => {
  for (const summary of [
    "",
    "Summary skipped: no reporter configured.",
    "Summary predates later journal facts.",
    "Reporter execution unavailable or unconfirmed; no work was replayed.",
  ]) {
    const content = activityContent(
      view({
        summary,
        summaryCurrent: false,
        entries: Array.from({ length: 8 }, (_, id) => ({
          id,
          member: "Chief",
          kind: "note" as const,
          text: `Milestone ${id} ${"x".repeat(1400)}`,
        })),
      }),
    );

    expect(content.text).not.toContain("Milestone 2");
    expect(content.text).toContain("Milestone 3");
    expect(content.text).toContain("Milestone 7");
    expect(content.blocks[0]?.child_blocks[0]?.type).toBe("section");
  }
});

test("detailed activity attributes each kind and remains literal", () => {
  const unsafe = "<!here> <@U123> <!subteam^S123> @everyone *bold* & <url>";

  const content = activityContent(
    view({
      detail: "detailed",
      reporter: unsafe,
      summary: unsafe,
      entries: ["assignment", "update", "message", "result"].map(
        (kind, id) => ({
          id,
          taskID: "private-task-id",
          member: unsafe,
          kind: kind as ActivityView["entries"][number]["kind"],
          text: unsafe,
        }),
      ),
    }),
  );

  for (const kind of ["assignment", "update", "message", "result"]) {
    expect(content.text).toContain(`— ${kind}`);
  }

  expect(content.text).not.toContain("<");
  expect(content.text).toContain("&lt;!here&gt;");
  expect(content.text).toContain("*bold* &amp;");

  for (const child of content.blocks[0]?.child_blocks ?? []) {
    if (child.type === "section") {
      expect(child.text.type).toBe("plain_text");
      expect(child.text.emoji).toBe(false);
      expect(child.text.text).toContain(unsafe);
    }
  }
});

test("maximum activity has ten bounded children including truncation context", () => {
  const content = activityContent(
    view({
      detail: "detailed",
      reporter: "r".repeat(100),
      summary: "&".repeat(3000),
      entries: Array.from({ length: 8 }, (_, id) => ({
        id,
        taskID: `task-${id}`,
        member: "m".repeat(100),
        kind: "update",
        text: "&".repeat(1500),
      })),
      truncated: true,
    }),
  );

  const container = content.blocks[0];
  expect(container?.child_blocks).toHaveLength(10);
  expect(container?.subtitle.text.length).toBeLessThanOrEqual(150);

  for (const child of container?.child_blocks ?? []) {
    const texts = child.type === "section" ? [child.text] : child.elements;

    for (const text of texts) {
      expect(text.text.length).toBeGreaterThan(0);
      expect(text.text.length).toBeLessThanOrEqual(3000);
    }
  }

  expect(JSON.stringify(container?.child_blocks.at(-1))).toContain(
    "some details are omitted",
  );
  expect(content.text.length).toBeLessThan(40_000);
});

test("empty and terminal reports state their actual status", () => {
  for (const [status, label] of [
    ["collecting", "Collecting activity"],
    ["summarizing", "Preparing report"],
    ["complete", "Report complete"],
    ["unavailable", "Report unavailable"],
    ["cancelled", "Report cancelled"],
  ] as const) {
    const content = activityContent(view({ status, summary: "", entries: [] }));
    expect(content.text).toContain(label);
    expect(content.blocks[0]?.child_blocks[0]).toMatchObject({
      text: { type: "plain_text", text: `${label}.` },
    });
  }
});

test("activity posts in its thread, edits the same message, and never reposts a missing edit", async () => {
  const calls: { path: string; fields: URLSearchParams }[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const fields = new URLSearchParams(await request.text());
      calls.push({ path, fields });

      if (fields.get("ts") === "missing")
        return Response.json({ ok: false, error: "message_not_found" });

      if (fields.get("channel") === "empty") return Response.json({ ok: true });

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
    expect(await slack.activity("C123", "1.000", view())).toBe("2.000");
    expect(await slack.activity("C123", "1.000", view(), "2.000")).toBe(
      "2.000",
    );
    await expect(
      slack.activity("C123", "1.000", view(), "missing"),
    ).rejects.toThrow();
    expect(calls.map((call) => call.path)).toEqual([
      "/chat.postMessage",
      "/chat.update",
      "/chat.update",
    ]);
    expect(calls[0]?.fields.get("thread_ts")).toBe("1.000");
    expect(calls[1]?.fields.get("ts")).toBe("2.000");

    for (const { fields } of calls) {
      expect(fields.get("channel")).toBe("C123");
      expect(fields.get("parse")).toBe("none");
      expect(fields.get("mrkdwn")).toBe("false");
      expect(fields.get("unfurl_links")).toBe("false");
      expect(fields.get("unfurl_media")).toBe("false");
      expect(JSON.parse(fields.get("blocks") ?? "null")).toEqual(
        activityContent(view()).blocks,
      );
      expect(fields.get("text")).toBe(activityContent(view()).text);
    }

    await expect(
      slack.activity("C123", "1.000", view(), undefined, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(calls).toHaveLength(3);
    await expect(slack.activity("empty", "1.000", view())).rejects.toThrow(
      "Slack did not return a message timestamp",
    );
  } finally {
    await server.stop(true);
  }
});

test("activity cancellation aborts its request without affecting another request", async () => {
  const controller = new AbortController();
  let aborted = false;
  let received: (() => void) | undefined;

  const started = new Promise<void>((resolve) => {
    received = resolve;
  });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.text();

      return Response.json({ ok: true, ts: "2.000" });
    },
  });

  const slack = new SlackConnection(
    "local-app-token",
    "local-bot-token",
    pino({ enabled: false }),
    {
      slackApiUrl: server.url.href,
      fetch: (url, init) => {
        if (String(url).endsWith("/chat.postMessage")) return fetch(url, init);

        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("Cancelled"));
            },
            { once: true },
          );
          received?.();
        });
      },
    },
  );

  try {
    const pending = slack.activity(
      "C123",
      "1.000",
      view(),
      "2.000",
      controller.signal,
    );

    await started;
    controller.abort(new Error("Cancelled"));
    await expect(pending).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(await slack.activity("C123", "1.000", view())).toBe("2.000");
  } finally {
    await server.stop(true);
  }
});
