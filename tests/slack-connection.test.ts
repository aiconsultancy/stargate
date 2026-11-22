import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import pino from "pino";
import { SlackConnection } from "../src/slack/slack";
import { SlackSocket } from "../src/slack/slack-connection";

const log = pino({ enabled: false });
const timing = { retryMs: 1, maxRetryMs: 2, outageMs: 100, attemptMs: 10 };

function fixture(failures: number, silent = false) {
  let attempts = 0;
  let failUntil = failures;
  const sockets: EventEmitter[] = [];

  const socket = new SlackSocket(
    () => {
      const events = new EventEmitter();
      sockets.push(events);

      return Object.assign(events, {
        async start() {
          attempts++;

          if (attempts <= failUntil)
            throw Object.assign(
              new Error("private request must not be logged"),
              { code: "EAI_AGAIN" },
            );

          if (!silent) events.emit("connected");
        },
        async disconnect() {
          events.emit("disconnected");
        },
      });
    },
    log,
    timing,
  );

  return {
    socket,
    sockets,
    attempts: () => attempts,
    fail: () => {
      failUntil = Infinity;
    },
  };
}

test("DNS failures retry before readiness and recovery requires connected event", async () => {
  const f = fixture(3);
  const starting = f.socket.start();
  expect(f.socket.state).not.toBe("connected");
  await starting;
  expect(f.attempts()).toBe(4);
  expect(f.socket.state).toBe("connected");
  await f.socket.close();
});

test("a later disconnect reconnects, and close cancels further attempts", async () => {
  const f = fixture(0);
  await f.socket.start();
  f.sockets[0]?.emit("disconnected");
  expect(f.socket.state).not.toBe("connected");

  for (let i = 0; i < 100 && f.attempts() < 2; i++) await Bun.sleep(1);
  expect(f.attempts()).toBe(2);
  expect(f.socket.state).toBe("connected");
  await f.socket.close();
  const count = f.attempts();
  await Bun.sleep(5);
  expect(f.attempts()).toBe(count);
  expect(f.socket.state).toBe("closed");
});

test("exhausted DNS retries and silent start both fail instead of reporting connected", async () => {
  for (const f of [fixture(Infinity), fixture(0, true)]) {
    await expect(f.socket.start()).rejects.toThrow(
      "Slack connection unavailable",
    );
    await expect(f.socket.watch()).rejects.toThrow();
    expect(f.socket.state).toBe("failed");
    await f.socket.close();
  }
});

test("shutdown aborts startup backoff without waiting for its deadline", async () => {
  const f = fixture(Infinity);
  const controller = new AbortController();
  const starting = f.socket.start(controller.signal);
  controller.abort();
  await expect(starting).rejects.toThrow();
  await f.socket.close();
  expect(f.socket.state).toBe("closed");
});

test("an exhausted later outage rejects supervision for the service manager", async () => {
  const f = fixture(0);
  await f.socket.start();
  const result = f.socket.watch().catch((error: unknown) => error);
  f.fail();
  f.sockets[0]?.emit("disconnected");
  expect(await result).toBeInstanceOf(Error);
  expect(f.socket.state).toBe("failed");
  await f.socket.close();
});

test("auth.test also retries wrapped boot-time DNS failures", async () => {
  let attempts = 0;

  const slack = new SlackConnection("fixture-app", "fixture-bot", log, {
    fetch: async () => {
      attempts++;

      if (attempts <= 2)
        throw Object.assign(new Error("fixture DNS"), { code: "EAI_AGAIN" });

      return Response.json({
        ok: true,
        team_id: "T1",
        user_id: "U1",
        bot_id: "B1",
      });
    },
  });

  try {
    expect(await slack.identity()).toEqual({ team: "T1", user: "U1" });
    expect(attempts).toBe(3);
  } finally {
    await slack.close();
  }
});
