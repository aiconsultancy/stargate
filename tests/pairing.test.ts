import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { botSchema } from "../src/config";
import type { CronView } from "../src/automation/cron/ui";
import { PairingUI } from "../src/transports/slack/pairing";
import { bot, identity } from "./fixtures";

function fixture(deadline?: () => AbortSignal) {
  const config = Schema.decodeUnknownSync(botSchema)({
    ...bot(),
    pairing: {
      operators: ["U123"],
      urls: ["https://code.example.test", "http://host.tail123.ts.net:4096"],
    },
  });

  const calls: { kind: string; view: CronView }[] = [];
  const order: string[] = [];
  const logs: string[] = [];
  const signals: AbortSignal[] = [];

  const backend = {
    async pair(signal: AbortSignal) {
      order.push("pair");
      signals.push(signal);

      return { code: "fixture-secret", expiresIn: 123 };
    },
  };

  const api = {
    async open(_trigger: string, view: CronView) {
      order.push("open");
      calls.push({ kind: "open", view });
    },
    async update(_id: string, _hash: string, view: CronView) {
      order.push("update");
      calls.push({ kind: "update", view });
    },
  };

  const log = pino({ level: "error" }, { write: (text) => logs.push(text) });
  const controller = new AbortController();
  let now = 1_000_000;
  let wall = 1_000_000;

  const ui = new PairingUI(
    config,
    identity,
    backend,
    api,
    log,
    controller.signal,
    () => now,
    deadline,
    () => wall,
  );

  const acks: (Record<string, unknown> | undefined)[] = [];

  const ack = async (value?: Record<string, unknown>) => {
    order.push("ack");
    acks.push(value);
  };

  const opened = () => {
    const view = calls[0]?.view;

    if (!view) {
      throw new Error("Missing confirmation");
    }

    return view;
  };

  return {
    config,
    calls,
    order,
    logs,
    backend,
    signals,
    api,
    controller,
    ui,
    ack,
    acks,
    opened,
    advance: (ms: number) => {
      now += ms;
      wall += ms;
    },
    jumpWall: (ms: number) => {
      wall += ms;
    },
    wallTime: () => wall,
  };
}

function command() {
  return {
    command: "/stargate",
    text: "pair",
    api_app_id: "A123",
    team_id: "T123",
    user_id: "U123",
    channel_id: "C123",
    trigger_id: "trigger",
  };
}

function action(view: CronView) {
  return {
    type: "block_actions",
    api_app_id: "A123",
    team: { id: "T123" },
    user: { id: "U123" },
    container: { type: "view", view_id: "V123" },
    view: { ...view, id: "V123", hash: "hash-1" },
    actions: [
      {
        type: "button",
        action_id: "stargate_pair_generate",
        value: "generate",
      },
    ],
  };
}

test("pairing config is off by default; operators are exact and URLs are origins", () => {
  expect(bot().pairing).toBeUndefined();
  const config = fixture().config;

  for (const pairing of [
    { ...config.pairing, operators: [] },
    { ...config.pairing, operators: ["*"] },
    { ...config.pairing, operators: ["C123"] },
    { ...config.pairing, urls: [] },
    { ...config.pairing, urls: Array(6).fill("https://example.test") },
  ]) {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(botSchema)({ ...config, pairing }),
      ),
    ).toBe(false);
  }

  for (const url of [
    "ftp://example.test",
    "https://u:p@example.test",
    "https://example.test/path",
    "https://example.test?x=1",
    "https://example.test#fragment",
    "https://example.test?",
    "http://public.example.test",
    "http://100.64.attacker.test",
    "https://@example.test",
    "https://example.test\\evil",
    "//example.test",
  ]) {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(botSchema)({
          ...config,
          pairing: { operators: ["U123"], urls: [url] },
        }),
      ),
    ).toBe(false);
  }

  expect(config.pairing?.urls).toEqual([
    "https://code.example.test",
    "http://host.tail123.ts.net:4096",
  ]);
});

test("only confirmation mints; URLs are literal private modal text and aliases share code", async () => {
  const f = fixture();
  await f.ui.command(command(), f.ack);
  expect(f.order).toEqual(["ack", "open"]);
  expect(JSON.stringify(f.opened())).toContain(
    "full server access for 30 days",
  );
  expect(JSON.stringify(f.opened())).not.toContain("fixture-secret");
  await f.ui.interactive(action(f.opened()), f.ack);
  expect(f.order).toEqual(["ack", "open", "ack", "pair", "update"]);
  const result = f.calls.at(-1)?.view;
  const serialized = JSON.stringify(result);
  expect(serialized).toContain(
    "https://code.example.test/auth/connect/fixture-secret",
  );
  expect(serialized).toContain(
    "http://host.tail123.ts.net:4096/auth/connect/fixture-secret",
  );
  expect(serialized).toContain("123 seconds");
  expect(serialized).toContain("helper (slack C123)");
  expect(serialized).not.toContain("<thread timestamp>");
  expect(serialized).not.toContain("mrkdwn");
  expect(serialized).not.toContain('"url":');
  expect(result?.private_metadata).toBeUndefined();
  expect(
    f.acks.every((ack) => !JSON.stringify(ack)?.includes("fixture-secret")),
  ).toBe(true);
  expect(f.logs).toEqual([]);
});

test("pairing guidance uses the friendly bot name and invoking conversation", async () => {
  const f = fixture();
  f.config.displayName = "Galactica Captain";
  await f.ui.command({ ...command(), channel_id: "D123" }, f.ack);
  await f.ui.interactive(action(f.opened()), f.ack);
  const displayed = JSON.stringify(f.calls.at(-1)?.view);
  expect(displayed).toContain("Galactica Captain (slack D123)");
  expect(displayed).toContain("Separate threads can share this title");
  expect(displayed).toContain("existing titles stay unchanged");
  expect(displayed).toContain("Pairing does not create a session");
});

test("invalid, denied, bot, disabled, unsupported commands never mint", async () => {
  const variants = [
    { text: "pair https://attacker.test" },
    { command: "/stargate-other" },
    { api_app_id: "AOTHER" },
    { team_id: "TOTHER" },
    { user_id: "UOTHER" },
    { user_id: "UBOT" },
    { channel_id: "COTHER" },
    { channel_id: "bad" },
    { bot_id: "B123" },
    { is_bot: true },
    { user_name: "slackbot" },
    { trigger_id: "" },
  ];

  for (const delta of variants) {
    const f = fixture();
    await f.ui.command({ ...command(), ...delta }, f.ack);
    expect(f.calls).toEqual([]);
    expect(f.order).toEqual(["ack"]);
    expect(f.acks[0]).toMatchObject({ response_type: "ephemeral" });
  }

  for (const change of [
    "disabled",
    "user",
    "channel",
    "unsupported",
    "no-capability",
  ]) {
    const f = fixture();

    if (change === "disabled") {
      delete f.config.pairing;
    }

    if (change === "user") {
      f.config.access.deniedUsers = ["U123"];
    }

    if (change === "channel") {
      f.config.access.deniedChannels = ["C123"];
    }

    if (change === "unsupported") {
      f.config.backend = { type: "module", module: "/x", options: {} };
    }

    if (change === "no-capability") {
      delete (f.backend as Pick<AgentBackend, "pair">).pair;
    }

    await f.ui.command(command(), f.ack);
    expect(f.calls).toEqual([]);
    expect(f.order).toEqual(["ack"]);
  }
});

test("button reauthorizes operator and normal denies, app, team, human and channel", async () => {
  for (const change of [
    "operator",
    "user",
    "channel",
    "disabled",
    "app",
    "team",
    "human",
    "owner",
    "container",
    "callback",
    "nonce",
    "action",
    "multi",
    "expired",
  ]) {
    const f = fixture();
    await f.ui.command(command(), f.ack);
    const body = action(f.opened());

    if (change === "operator" && f.config.pairing) {
      f.config.pairing.operators = ["UOTHER"];
    }

    if (change === "user") {
      f.config.access.deniedUsers = ["U123"];
    }

    if (change === "channel") {
      f.config.access.deniedChannels = ["C123"];
    }

    if (change === "disabled") {
      delete f.config.pairing;
    }

    if (change === "app") {
      body.api_app_id = "AOTHER";
    }

    if (change === "team") {
      body.team.id = "TOTHER";
    }

    if (change === "human") {
      Object.assign(body.user, { is_bot: true });
    }

    if (change === "owner") {
      body.user.id = "UOTHER";
    }

    if (change === "container") {
      body.container.view_id = "VOTHER";
    }

    if (change === "callback") {
      body.view.callback_id = "cron_list";
    }

    if (change === "nonce") {
      body.view.private_metadata = "forged";
    }

    if (change === "action") {
      body.actions[0] = {
        type: "button",
        action_id: "stargate_pair_other",
        value: "generate",
      };
    }

    if (change === "multi") {
      body.actions.push({
        type: "button",
        action_id: "stargate_pair_generate",
        value: "generate",
      });
    }

    if (change === "expired") {
      f.advance(300_001);
    }

    await f.ui.interactive(body, f.ack);
    expect(f.order).not.toContain("pair");
    expect(f.order.filter((s) => s === "ack")).toHaveLength(2);
  }
});

test("retries and concurrent clicks do not issue or deliver a second code", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<{ code: string; expiresIn: number }>();
  f.backend.pair = async (signal) => {
    f.order.push("pair");
    f.signals.push(signal);

    return pending.promise;
  };

  await f.ui.command(command(), f.ack);
  const body = action(f.opened());
  const first = f.ui.interactive(body, f.ack);
  await f.ui.interactive(body, f.ack);
  pending.resolve({ code: "fixture-secret", expiresIn: 123 });
  await first;
  await f.ui.interactive(body, f.ack);
  expect(f.order.filter((s) => s === "pair")).toHaveLength(1);
  expect(f.calls.filter((c) => c.kind === "update")).toHaveLength(1);
});

test("failed mint or modal delivery is sanitized and never retried", async () => {
  for (const target of ["pair", "update", "ack"]) {
    const f = fixture();
    await f.ui.command(command(), f.ack);
    const body = action(f.opened());

    const fail = async () => {
      throw new Error("fixture-secret https://secret.test");
    };

    if (target === "pair") {
      f.backend.pair = fail;
    }

    if (target === "update") {
      f.api.update = fail;
    }

    await f.ui.interactive(body, target === "ack" ? fail : f.ack);
    await f.ui.interactive(body, f.ack);
    expect(f.logs.join(" ")).not.toContain("fixture-secret");
    expect(f.logs.join(" ")).not.toContain("secret.test");
    expect(f.order.filter((s) => s === "pair").length).toBeLessThanOrEqual(1);
    expect(
      f.calls.some((c) => JSON.stringify(c.view).includes("fixture-secret")),
    ).toBe(false);
  }
});

test("pending confirmation count is bounded and stale records expire", async () => {
  const f = fixture();

  for (let n = 0; n < 130; n++) {
    await f.ui.command(command(), f.ack);
  }

  expect(f.calls).toHaveLength(128);
  const old = action(f.opened());
  f.advance(300_001);
  await f.ui.command(command(), f.ack);
  expect(f.calls).toHaveLength(129);
  await f.ui.interactive(old, f.ack);
  expect(f.order).not.toContain("pair");
});

test("shutdown cancels mint and prevents delivery", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  f.backend.pair = async (signal) => {
    f.signals.push(signal);
    started.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      }),
    );

    return { code: "unused", expiresIn: 123 };
  };

  await f.ui.command(command(), f.ack);
  const run = f.ui.interactive(action(f.opened()), f.ack);
  await started.promise;
  f.controller.abort();
  await run;
  expect(f.signals[0]?.aborted).toBe(true);
  expect(f.calls).toHaveLength(1);
});

test("deadline cancels mint without replay and shows only a private failure notice", async () => {
  const timeout = new AbortController();
  const f = fixture(() => timeout.signal);
  const started = Promise.withResolvers<void>();
  f.backend.pair = async (signal) => {
    f.order.push("pair");
    f.signals.push(signal);
    started.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new Error("PRIVATE timeout")),
        { once: true },
      ),
    );

    return { code: "unused", expiresIn: 123 };
  };

  await f.ui.command(command(), f.ack);
  const body = action(f.opened());
  const run = f.ui.interactive(body, f.ack);
  await started.promise;
  timeout.abort();
  await run;
  await f.ui.interactive(body, f.ack);
  expect(f.order.filter((kind) => kind === "pair")).toHaveLength(1);
  expect(f.signals[0]?.aborted).toBe(true);
  expect(JSON.stringify(f.calls.at(-1)?.view)).toContain("No retry was made");
  expect(f.logs.join(" ")).not.toContain("PRIVATE");
});

test("access changes during ACK or issuance prevent mint or secret delivery", async () => {
  for (const stage of ["ack", "pair"]) {
    const f = fixture();
    await f.ui.command(command(), f.ack);
    const original = f.backend.pair;
    f.backend.pair = async (signal) => {
      const code = await original(signal);
      f.config.access.deniedChannels = ["C123"];

      return code;
    };

    await f.ui.interactive(action(f.opened()), async () => {
      await f.ack();

      if (stage === "ack") {
        f.config.access.deniedChannels = ["C123"];
      }
    });

    if (stage === "ack") {
      expect(f.order).not.toContain("pair");
    }

    expect(f.calls).toHaveLength(1);
  }
});

test("wildcard normal access still requires an exact pairing operator", async () => {
  const f = fixture();
  f.config.access.users = ["*"];
  f.config.access.channels = ["*"];
  await f.ui.command({ ...command(), user_id: "UOTHER" }, f.ack);
  expect(f.calls).toHaveLength(0);
  await f.ui.command(command(), f.ack);
  await f.ui.interactive(action(f.opened()), f.ack);
  expect(f.order.filter((kind) => kind === "pair")).toHaveLength(1);
});

test("wall-clock jumps cannot extend or shorten five-minute confirmations", async () => {
  for (const jump of [-3_600_000, 3_600_000]) {
    for (const elapsed of [299_999, 300_000]) {
      const f = fixture();
      await f.ui.command(command(), f.ack);
      f.advance(elapsed);
      f.jumpWall(jump);
      await f.ui.interactive(action(f.opened()), f.ack);
      expect(f.order.includes("pair")).toBe(elapsed < 300_000);
    }
  }
});

test("confirmation expiry is rechecked after a delayed ACK", async () => {
  const f = fixture();
  await f.ui.command(command(), f.ack);
  await f.ui.interactive(action(f.opened()), async () => {
    f.advance(300_000);
    f.jumpWall(-3_600_000);
    await f.ack();
  });
  expect(f.order).not.toContain("pair");
  expect(JSON.stringify(f.calls.at(-1)?.view)).toContain(
    "confirmation expired",
  );
});

test("code display adds elapsed-adjusted lifetime to current wall time after clock jumps", async () => {
  for (const jump of [-3_600_000, 3_600_000]) {
    const f = fixture();
    const original = f.backend.pair;
    f.backend.pair = async (signal) => {
      const result = await original(signal);
      f.advance(2000);
      f.jumpWall(jump);

      return result;
    };

    await f.ui.command(command(), f.ack);
    await f.ui.interactive(action(f.opened()), f.ack);
    const displayed = JSON.stringify(f.calls.at(-1)?.view);
    expect(displayed).toContain("fixture-secret");
    expect(displayed).toContain(new Date(f.wallTime() + 121_000).toISOString());
    expect(displayed).toContain("server expiry is authoritative");
  }
});

test("elapsed code expiry prevents secret display despite wall-clock rollback or advance", async () => {
  for (const jump of [-3_600_000, 3_600_000]) {
    const f = fixture();
    const original = f.backend.pair;
    f.backend.pair = async (signal) => {
      const result = await original(signal);
      f.advance(result.expiresIn * 1000);
      f.jumpWall(jump);

      return result;
    };

    await f.ui.command(command(), f.ack);
    const body = action(f.opened());
    await f.ui.interactive(body, f.ack);
    await f.ui.interactive(body, f.ack);
    expect(f.order.filter((kind) => kind === "pair")).toHaveLength(1);
    expect(JSON.stringify(f.calls)).not.toContain("fixture-secret");
    expect(JSON.stringify(f.calls.at(-1)?.view)).toContain("No retry was made");
  }
});
