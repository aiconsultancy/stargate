import { expect, test } from "bun:test";
import { Schema } from "effect";
import pino from "pino";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema } from "../src/config";
import { CrewUI, quotaStatusView } from "../src/transports/slack/crew-ui";
import type { CronView } from "../src/cron/ui";
import type { QuotaSnapshot } from "../src/quota/quota";
import { bot, identity } from "./fixtures";

const snapshot: QuotaSnapshot = {
  status: "ok",
  observedAt: 1000,
  cached: true,
  accounts: [
    {
      provider: "claude",
      account: "claude-1",
      status: "ok",
      observedAt: 1000,
      windows: [
        {
          window: "weekly",
          scope: "fable",
          usedPercent: 3,
          remainingPercent: 97,
          resetAt: 2000,
          active: false,
        },
      ],
    },
  ],
};

const command = {
  command: "/stargate",
  text: "usage",
  api_app_id: "A123",
  team_id: "T123",
  user_id: "U123",
  channel_id: "C123",
  trigger_id: "trigger",
};

test("usage command ACKs and opens before the read; displays private bounded plain text", async () => {
  const order: string[] = [];
  const views: CronView[] = [];

  const ui = new CrewUI(
    bot(),
    identity,
    {
      async quota() {
        order.push("read");

        return snapshot;
      },
    },
    {
      async open(_trigger, view) {
        order.push("open");
        views.push(view);

        return "V123";
      },
      async update(_view, view) {
        order.push("update");
        views.push(view);
      },
    },
    pino({ enabled: false }),
    new AbortController().signal,
  );

  await ui.command(command, async () => {
    order.push("ack");
  });
  expect(order).toEqual(["ack", "open", "read", "update"]);
  expect(views.at(-1)?.title.text).toBe("Provider usage");
  expect(JSON.stringify(views.at(-1))).toContain("97% remaining");
  expect(JSON.stringify(views.at(-1))).toContain("INACTIVE scope");
  expect(JSON.stringify(views.at(-1))).toContain("Reset passed");
  expect(JSON.stringify(views.at(-1))).toContain("not token counts");

  for (const block of views.at(-1)?.blocks ?? [])
    expect(block).toMatchObject({
      type: "section",
      text: { type: "plain_text", emoji: false },
    });
  const max = structuredClone(snapshot);
  const account = snapshot.accounts[0];
  const window = account?.windows[0];

  if (!account || !window) throw new Error("Missing quota fixture");
  max.accounts = Array.from({ length: 10 }, (_, i) => ({
    ...account,
    account: `claude-${i + 1}`,
    windows: Array.from({ length: 16 }, () => window),
  }));
  const view = quotaStatusView(max, 3000);
  expect(view.blocks.length).toBeLessThan(100);
  expect(JSON.stringify(view)).toContain("claude-10");

  for (const block of view.blocks) {
    expect(block.type).toBe("section");

    if (
      "text" in block &&
      typeof block.text === "object" &&
      block.text &&
      "text" in block.text
    )
      expect(String(block.text.text).length).toBeLessThanOrEqual(3000);
  }
});

test("usage command preserves app/workspace/access/bot boundaries and rechecks before delivery", async () => {
  const config = bot();
  let reads = 0;
  let opens = 0;
  let updates = 0;

  const ui = new CrewUI(
    config,
    identity,
    {
      async quota() {
        reads++;
        config.access.deniedUsers.push("U123");

        return snapshot;
      },
    },
    {
      async open() {
        opens++;

        return "V123";
      },
      async update() {
        updates++;
      },
    },
    pino({ enabled: false }),
    new AbortController().signal,
  );

  for (const changes of [
    { api_app_id: "AOTHER" },
    { team_id: "TOTHER" },
    { user_id: "UOTHER" },
    { channel_id: "COTHER" },
    { user_id: "UBOT" },
    { bot_id: "B123" },
    { is_bot: true },
    { user_name: "slackbot" },
    { text: "usage extra" },
  ])
    await ui.command({ ...command, ...changes }, async (payload) => {
      expect(payload).toMatchObject({ response_type: "ephemeral" });
    });
  expect(reads).toBe(0);
  expect(opens).toBe(0);
  await ui.command(command, async () => {});
  expect(reads).toBe(1);
  expect(opens).toBe(1);
  expect(updates).toBe(0);
});

test("usage failure and unsupported backends never reveal raw errors", async () => {
  const views: CronView[] = [];

  const ui = new CrewUI(
    bot(),
    identity,
    {
      async quota() {
        throw new Error("Bearer secret");
      },
    },
    {
      async open() {
        return "V123";
      },
      async update(_id, view) {
        views.push(view);
      },
    },
    pino({ enabled: false }),
    new AbortController().signal,
  );

  await ui.command(command, async () => {});
  expect(JSON.stringify(views)).toContain("Quota unavailable");
  expect(JSON.stringify(views)).not.toContain("Bearer secret");

  const unsupported = new CrewUI(
    bot(),
    identity,
    {},
    {
      async open() {
        throw new Error("Must not open");
      },
      async update() {},
    },
    pino({ enabled: false }),
    new AbortController().signal,
  );

  await unsupported.command(command, async (payload) => {
    expect(payload).toMatchObject({ response_type: "ephemeral" });
  });
});

test("quota adapter uses only location-scoped authenticated RPC, no session or inference", async () => {
  const requests: string[] = [];
  let invalid = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(new URL(request.url).pathname);
      expect(new URL(request.url).searchParams.get("location[directory]")).toBe(
        "/captain",
      );
      expect(request.headers.get("authorization")).toBe("Bearer fixture-only");
      expect(await request.json()).toEqual({ input: {} });

      return Response.json({
        output: invalid ? { secret: "private" } : snapshot,
      });
    },
  });

  process.env["STARGATE_QUOTA_TEST_AUTH"] = "Bearer fixture-only";

  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/captain",
      headersEnv: { Authorization: "STARGATE_QUOTA_TEST_AUTH" },
    });

    if (config.type !== "opencode") throw new Error("Invalid fixture");
    const backend = new OpenCodeBackend(config);
    expect(await backend.quota(new AbortController().signal)).toEqual(snapshot);
    invalid = true;
    await expect(backend.quota(new AbortController().signal)).rejects.toThrow(
      "Quota unavailable",
    );
    expect(requests).toEqual([
      "/api/rpc/stargate.crew.reporting/quota",
      "/api/rpc/stargate.crew.reporting/quota",
    ]);
    await backend.close();
  } finally {
    delete process.env["STARGATE_QUOTA_TEST_AUTH"];
    await server.stop(true);
  }
});
