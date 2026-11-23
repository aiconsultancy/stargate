import { afterEach, expect, test } from "bun:test";
import { IrcStatus, type StatusResult } from "../src/irc/status";
import { waitingPhrase } from "../src/gateway/waiting";

type Attempt = {
  value: string | undefined;
  guard: () => boolean;
  at: number;
  resolve: (result: StatusResult) => void;
};

const statuses: IrcStatus[] = [];

afterEach(async () => {
  await Promise.all(statuses.splice(0).map((status) => status.shutdown()));
});

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean) {
  const deadline = Date.now() + 1500;

  while (!check()) {
    if (Date.now() >= deadline) throw new Error("status condition timed out");
    await pause(1);
  }
}

function setup(
  timing: ConstructorParameters<typeof IrcStatus>[2] = {},
  name = "Adama",
) {
  const attempts: Attempt[] = [];

  const status = new IrcStatus(
    name,
    (value, guard) => {
      const reply = Promise.withResolvers<StatusResult>();
      attempts.push({ value, guard, at: Date.now(), resolve: reply.resolve });

      return reply.promise;
    },
    {
      intervalMs: 30,
      windowMs: 300,
      retryMs: 5,
      shutdownMs: 15,
      ...timing,
    },
  );

  statuses.push(status);

  const next = async (count: number) => {
    await until(() => attempts.length >= count);
    const attempt = attempts[count - 1];

    if (!attempt) throw new Error("missing attempt");

    return attempt;
  };

  const ack = async (count: number) => {
    const attempt = await next(count);
    expect(attempt.guard()).toBe(true);
    attempt.resolve({ kind: "ok" });
    await pause(0);

    return attempt;
  };

  return { status, attempts, next, ack };
}

test("irc status: reconnect clears before aggregate busy; old finishes do not clear", async () => {
  const { status, next, ack, attempts } = setup();
  const older = status.begin();
  const newer = status.begin();
  await pause(10);
  expect(attempts).toHaveLength(0);
  status.connected();
  expect((await next(1)).value).toBeUndefined();
  await pause(10);
  expect(attempts).toHaveLength(1);
  await ack(1);
  expect((await next(2)).value).toBe(waitingPhrase("Adama", 0));
  await ack(2);
  older();
  older();
  expect((await next(3)).value).toBe(waitingPhrase("Adama", 1));
  await ack(3);
  newer();
  expect((await next(4)).value).toBeUndefined();
  await ack(4);
  await pause(40);
  expect(attempts).toHaveLength(4);
});

test("irc status: synchronous short turns cancel starts and leave known clear alone", async () => {
  const { status, ack, attempts } = setup();
  status.connected();
  await ack(1);

  for (let i = 0; i < 100; i++) status.begin()();
  await pause(40);
  expect(attempts).toHaveLength(1);
});

test("irc status: queued busy guard expires at last finish; cleanup survives a new turn", async () => {
  const { status, ack, next, attempts } = setup();
  status.connected();
  await ack(1);
  const finish = status.begin();
  const busy = await next(2);
  finish();
  const newer = status.begin();
  expect(busy.guard()).toBe(false);
  await pause(10);
  expect(attempts).toHaveLength(2);
  // Even an obsolete success may have written before the guard expired.
  busy.resolve({ kind: "ok" });
  expect((await next(3)).value).toBeUndefined();
  await ack(3);
  expect((await next(4)).value).toBe(waitingPhrase("Adama", 1));
  await ack(4);
  newer();
  await ack(5);
});

test("irc status: interval spans quick turns, while terminal clear bypasses it", async () => {
  const { status, ack, next } = setup({ intervalMs: 60 });
  status.connected();
  await ack(1);
  const first = status.begin();
  const busy = await ack(2);
  first();
  const clear = await ack(3);
  expect(clear.value).toBeUndefined();
  expect(clear.at - busy.at).toBeLessThan(50);
  const second = status.begin();
  const later = await next(4);
  expect(later.at - busy.at).toBeGreaterThanOrEqual(60);
  await ack(4);
  second();
  await ack(5);
});

test("irc status: delayed transport writes cannot compress the nonclear interval", async () => {
  const { status, ack, next, attempts } = setup({ intervalMs: 40 });
  status.connected();
  await ack(1);
  const finish = status.begin();
  const busy = await next(2);
  await pause(60);
  expect(busy.guard()).toBe(true);
  const writtenAt = Date.now();
  busy.resolve({ kind: "ok" });
  await pause(20);
  expect(attempts).toHaveLength(2);
  expect((await next(3)).at - writtenAt).toBeGreaterThanOrEqual(40);
  await ack(3);
  finish();
  await ack(4);
});

test("irc status: ten-attempt rolling quota reserves a clear slot across reconnects", async () => {
  const { status, ack, next, attempts } = setup({
    intervalMs: 4,
    windowMs: 140,
    limit: 10,
  });

  status.connected();
  const startup = await ack(1);
  const finish = status.begin();

  for (let count = 2; count <= 9; count++) await ack(count);
  await pause(12);
  expect(attempts).toHaveLength(9);
  finish();
  expect((await next(10)).value).toBeUndefined();
  await ack(10);
  status.disconnected();
  status.connected();
  await pause(10);
  expect(attempts).toHaveLength(10);
  const reconnect = await next(11);
  expect(reconnect.value).toBeUndefined();
  expect(reconnect.at - startup.at).toBeGreaterThanOrEqual(140);
  await ack(11);

  for (const attempt of attempts) {
    expect(
      attempts.filter(
        (item) => item.at <= attempt.at && item.at > attempt.at - 140,
      ).length,
    ).toBeLessThanOrEqual(10);
  }
});

test("irc status: failed terminal clear retries and honours server backoff", async () => {
  const { status, ack, next, attempts } = setup();
  status.connected();
  await ack(1);
  const finish = status.begin();
  await ack(2);
  finish();
  (await next(3)).resolve({ kind: "rejected" });
  const retry = await next(4);
  expect(retry.value).toBeUndefined();
  retry.resolve({ kind: "rate-limited", retryAfterMs: 60 });
  const newer = status.begin();
  await pause(30);
  expect(attempts).toHaveLength(4);
  const clear = await next(5);
  expect(clear.value).toBeUndefined();
  expect(clear.at - retry.at).toBeGreaterThanOrEqual(60);
  await ack(5);
  expect((await next(6)).value).toBeDefined();
  await ack(6);
  newer();
  await ack(7);
});

test("irc status: terminal cleanup survives local quota exhaustion and new starts", async () => {
  const { status, ack, next, attempts } = setup({
    intervalMs: 4,
    windowMs: 150,
    retryMs: 2,
  });

  status.connected();
  await ack(1);
  const finish = status.begin();
  await ack(2);
  finish();

  for (let count = 3; count <= 10; count++) {
    const clear = await next(count);
    expect(clear.value).toBeUndefined();
    clear.resolve({ kind: "rejected" });
  }

  const newer = status.begin();
  await pause(20);
  expect(attempts).toHaveLength(10);
  expect((await next(11)).value).toBeUndefined();
  await ack(11);
  expect((await next(12)).value).toBeDefined();
  await ack(12);
  newer();
  await ack(13);
});

test("irc status: thrown publisher failures retain clear without unhandled rejection", async () => {
  let calls = 0;
  const values: (string | undefined)[] = [];

  const status = new IrcStatus(
    "Adama",
    async (value) => {
      values.push(value);

      if (++calls === 1) throw new Error("synthetic transport failure");

      return { kind: "ok" };
    },
    { retryMs: 5, shutdownMs: 50 },
  );

  statuses.push(status);
  status.connected();
  await until(() => calls === 2);
  await status.shutdown();
  expect(values).toEqual([undefined, undefined]);
});

test("irc status: stale connection ACK cannot clear reconnect barrier", async () => {
  const { status, next, ack, attempts } = setup();
  status.connected();
  const oldClear = await next(1);
  const finish = status.begin();
  status.disconnected();
  status.connected();
  expect(oldClear.guard()).toBe(false);
  await pause(10);
  expect(attempts).toHaveLength(1);
  oldClear.resolve({ kind: "ok" });
  expect((await next(2)).value).toBeUndefined();
  await ack(2);
  await ack(3);
  status.disconnected();
  finish();
  status.connected();
  expect((await next(4)).value).toBeUndefined();
  await ack(4);
  await pause(40);
  expect(attempts).toHaveLength(4);
});

test("irc status: disconnect invalidates queued busy and retains active handles", async () => {
  const { status, next, ack } = setup();
  status.connected();
  await ack(1);
  const finish = status.begin();
  const busy = await next(2);
  status.disconnected();
  expect(busy.guard()).toBe(false);
  status.connected();
  busy.resolve({ kind: "ok" });
  expect((await next(3)).value).toBeUndefined();
  await ack(3);
  expect((await next(4)).value).toBeDefined();
  await ack(4);
  finish();
  await ack(5);
});

test("irc status: shutdown waits for clear ACK, closes guards and is idempotent", async () => {
  const { status, ack, next, attempts } = setup({ shutdownMs: 150 });
  status.connected();
  await ack(1);
  status.begin();
  const busy = await ack(2);
  let done = false;

  const closing = status.shutdown().then(() => {
    done = true;
  });

  status.begin()();
  const clear = await next(3);
  expect(clear.value).toBeUndefined();
  expect(busy.guard()).toBe(false);
  await pause(10);
  expect(done).toBe(false);
  await ack(3);
  await closing;
  expect(clear.guard()).toBe(false);
  await status.shutdown();
  status.connected();
  await pause(40);
  expect(attempts).toHaveLength(3);
});

test("irc status: shutdown deadline bounds a hung publish, including late replies", async () => {
  const { status, next, attempts } = setup({ shutdownMs: 25 });
  status.connected();
  const pending = await next(1);
  const start = Date.now();
  await status.shutdown();
  expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  expect(Date.now() - start).toBeLessThan(200);
  expect(pending.guard()).toBe(false);
  pending.resolve({ kind: "ok" });
  await pause(20);
  expect(attempts).toHaveLength(1);
});

test("irc status: connection loss during shutdown releases its deadline timer", async () => {
  const { status, ack, next, attempts } = setup({ shutdownMs: 1000 });
  status.connected();
  await ack(1);
  status.begin();
  await ack(2);
  const closing = status.shutdown();
  const clear = await next(3);
  status.disconnected();
  expect(
    await Promise.race([
      closing.then(() => "closed"),
      pause(30).then(() => "waiting"),
    ]),
  ).toBe("closed");
  expect(clear.guard()).toBe(false);
  clear.resolve({ kind: "unavailable" });
  await pause(10);
  expect(attempts).toHaveLength(3);
});

test("irc status: never-connected unsupported transport emits nothing", async () => {
  const { status, attempts } = setup();
  const finish = status.begin();
  status.begin()();
  await pause(40);
  finish();
  await status.shutdown();
  expect(attempts).toHaveLength(0);
});

test("irc status: names are control-free; UTF-8 caps preserve complete fixed phrases", async () => {
  const { status, ack, next } = setup(
    {},
    `Adama\r\n\0\u0001\u007f${"🚀".repeat(100)}`,
  );

  status.connected(55);
  await ack(1);
  const finish = status.begin();
  const busy = await next(2);
  expect(busy.value).toBeDefined();
  expect(busy.value).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
  expect(busy.value).not.toContain("�");
  expect(Buffer.byteLength(busy.value ?? "")).toBeLessThanOrEqual(55);
  expect(busy.value?.endsWith(" is thinking…")).toBe(true);
  await ack(2);
  finish();
  await ack(3);
});

test("irc status: hard value cap applies; tiny advertised caps still permit clear", async () => {
  for (const cap of [undefined, 1000, 1]) {
    const { status, ack, attempts } = setup({}, "🚀".repeat(1000));
    status.connected(cap);
    await ack(1);
    const finish = status.begin();

    if (cap === 1) {
      await pause(40);
      expect(attempts).toHaveLength(1);
      finish();
    } else {
      const busy = await ack(2);
      expect(Buffer.byteLength(busy.value ?? "")).toBeLessThanOrEqual(344);
      expect(busy.value?.endsWith(" is thinking…")).toBe(true);
      finish();
      await ack(3);
    }

    await status.shutdown();
  }
});
