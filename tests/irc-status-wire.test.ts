import { afterEach, expect, spyOn, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { IrcClient, type IrcClientOptions } from "../src/irc/client";
import { IrcDelivery } from "../src/irc/delivery";
import { FakeIrcServer, until } from "./irc-fixture";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const caps = [
  "sasl=PLAIN",
  "account-tag",
  "batch",
  "draft/metadata-2=before-connect,max-keys=100",
];

async function setup(options: Partial<IrcClientOptions> = {}, offered = caps) {
  const server = new FakeIrcServer({
    caps: offered,
    accounts: { captain: "synthetic-password" },
  }).start();

  cleanup.push(() => server.stop());

  const client = new IrcClient({
    host: "127.0.0.1",
    port: server.port,
    tls: false,
    account: "captain",
    password: "synthetic-password",
    nick: "captain",
    channels: ["#ship"],
    log: pino({ level: "silent" }),
    statusName: "Apollo",
    timing: { intervalMs: 2, burst: 20, reconnectMinMs: 5, reconnectMaxMs: 10 },
    ...options,
  });

  const controller = new AbortController();
  const running = client.run(controller.signal);
  cleanup.push(async () => {
    controller.abort();
    await running;
  });
  await client.waitReady(1000);

  return { server, client, controller, running };
}

test("metadata negotiates batch and clears only status after registration", async () => {
  const { server } = await setup();
  await until(() =>
    server.received("captain").some((line) => line === "METADATA * SET status"),
  );
  const lines = server.received("captain");
  expect(lines).toContain("CAP REQ batch");
  expect(lines).toContain("CAP REQ draft/metadata-2");
  expect(lines.indexOf("METADATA * SET status")).toBeGreaterThan(
    lines.indexOf("CAP END"),
  );
  expect(lines.some((line) => line.includes(" CLEAR"))).toBe(false);
});

test("shared connection status lasts until last turn and clears before graceful QUIT", async () => {
  const { server, client, controller, running } = await setup();
  const delivery = new IrcDelivery(client);
  const older = new AbortController();
  const newer = new AbortController();

  const first = delivery.working(
    "#ship",
    "private-request-not-for-status",
    older.signal,
  );

  const second = delivery.working("#other", "secret-file.txt", newer.signal);
  await until(() => server.metadata.get("captain") === "Apollo is thinking…");
  older.abort();
  await first;
  expect(server.metadata.get("captain")).toBe("Apollo is thinking…");
  newer.abort();
  await second;
  await until(() => !server.metadata.has("captain"));
  controller.abort();
  await running;
  await until(() =>
    server.received("captain").some((line) => line.startsWith("QUIT")),
  );
  const lines = server.received("captain");
  const updates = lines.filter((line) => line.startsWith("METADATA"));
  expect(
    updates.some(
      (line) =>
        line.includes("private-request") || line.includes("secret-file"),
    ),
  ).toBe(false);
  expect(lines.lastIndexOf("METADATA * SET status")).toBeLessThan(
    lines.findIndex((line) => line.startsWith("QUIT")),
  );
});

test("unnegotiated metadata preserves existing behaviour", async () => {
  for (const offered of [
    caps.filter((cap) => !cap.startsWith("draft/metadata")),
    caps.filter((cap) => cap !== "batch"),
  ]) {
    const { server, client } = await setup({}, offered);
    const turn = new AbortController();

    const working = new IrcDelivery(client).working(
      "#ship",
      "request",
      turn.signal,
    );

    await delay(20);
    turn.abort();
    await working;
    expect(
      server.received("captain").some((line) => line.startsWith("METADATA")),
    ).toBe(false);
  }
});

test("reconnect clears stale status before restoring current aggregate activity", async () => {
  const { server, client } = await setup({
    statusTiming: { intervalMs: 20, windowMs: 50 },
  });

  const turn = new AbortController();

  const working = new IrcDelivery(client).working(
    "#ship",
    "request",
    turn.signal,
  );

  await until(() => server.metadata.has("captain"));
  server.drop("captain");
  await until(() => server.clients.length >= 2);
  await until(
    () =>
      server.clients[1]?.lines.some((line) => line.includes("is thinking")) ===
      true,
  );
  const lines = server.clients[1]?.lines ?? [];
  expect(lines.indexOf("METADATA * SET status")).toBeGreaterThan(
    lines.indexOf("CAP END"),
  );
  expect(lines.indexOf("METADATA * SET status")).toBeLessThan(
    lines.findIndex((line) => line.includes("is thinking")),
  );
  turn.abort();
  await working;
  await until(() => !server.metadata.has("captain"));
});

test("rejected clear remains pending and no busy value overtakes its acknowledgement", async () => {
  const { server, client } = await setup({ statusTiming: { retryMs: 15 } });
  await until(() =>
    server.received("captain").includes("METADATA * SET status"),
  );
  let denied = false;
  server.onMetadata = (account, params) => {
    if (params[3] === undefined && !denied) {
      denied = true;
      server.sendTo(
        account,
        ":fake FAIL METADATA KEY_NO_PERMISSION captain status :refused",
      );

      return true;
    }

    return false;
  };

  const turn = new AbortController();

  const working = new IrcDelivery(client).working(
    "#ship",
    "request",
    turn.signal,
  );

  await until(() => server.metadata.has("captain"));
  turn.abort();
  await working;
  await until(() => denied && !server.metadata.has("captain"));
});

test("quota-delayed terminal clear blocks a newer busy value until acknowledged", async () => {
  const { server, client } = await setup({
    statusTiming: { intervalMs: 20, windowMs: 100 },
  });

  const delivery = new IrcDelivery(client);
  const first = new AbortController();
  const working = delivery.working("#ship", "request", first.signal);
  await until(() => server.metadata.has("captain"));
  let deniedAt = 0;
  server.onMetadata = (account, params) => {
    if (params[3] === undefined && !deniedAt) {
      deniedAt = Date.now();
      server.sendTo(
        account,
        ":fake FAIL METADATA RATE_LIMITED captain status 1 :slow down",
      );

      return true;
    }

    return false;
  };

  first.abort();
  await working;
  await until(() => deniedAt > 0);
  const boundary = server.received("captain").length;
  const second = new AbortController();
  const next = delivery.working("#ship", "new-request", second.signal);
  await delay(50);
  expect(
    server
      .received("captain")
      .slice(boundary)
      .filter((line) => line.startsWith("METADATA")),
  ).toEqual([]);
  await until(
    () =>
      server
        .received("captain")
        .slice(boundary)
        .includes("METADATA * SET status"),
    2500,
  );
  expect(Date.now() - deniedAt).toBeGreaterThanOrEqual(1000);
  second.abort();
  await next;
  await until(() => !server.metadata.has("captain"));
});

test("graceful disconnect clears an active aggregate before QUIT", async () => {
  const { server, client, controller, running } = await setup();
  const turn = new AbortController();

  const working = new IrcDelivery(client).working(
    "#ship",
    "request",
    turn.signal,
  );

  await until(() => server.metadata.has("captain"));
  controller.abort();
  await running;
  turn.abort();
  await working;
  await until(() =>
    server.received("captain").some((line) => line.startsWith("QUIT")),
  );
  expect(server.metadata.has("captain")).toBe(false);
  const lines = server.received("captain");
  expect(lines.lastIndexOf("METADATA * SET status")).toBeLessThan(
    lines.findIndex((line) => line.startsWith("QUIT")),
  );
});

test("a conversation typing guard ending early does not finish the connection's turn", async () => {
  const { server, client } = await setup({}, [...caps, "message-tags"]);
  const turn = new AbortController();

  const delivery = new IrcDelivery(client, 1000, undefined, undefined, {
    typing: true,
  });

  await delivery.working("#ship", "request", turn.signal, () => false);
  await until(() => server.metadata.has("captain"));
  expect(
    server.received("captain").some((line) => line.includes("+typing=active")),
  ).toBe(false);
  turn.abort();
  await until(() => !server.metadata.has("captain"));
});

test.each(["ended", "expired"])(
  "wholly unsent metadata stays cancellable through socket backpressure: %s",
  async (cause) => {
    const { server, client } = await setup({
      timing: { intervalMs: 2, burst: 20, confirmMs: 40 },
      statusTiming: { retryMs: 100 },
    });

    await until(() =>
      server.received("captain").includes("METADATA * SET status"),
    );
    await until(() => Reflect.get(client, "metadataPending") === undefined);

    // Only this test socket is backpressured; preserve all other connections.
    const socket = Reflect.get(client, "socket") as {
      write(data: Uint8Array): number;
    };

    const blocked: string[] = [];

    const write = spyOn(socket, "write").mockImplementation((data) => {
      blocked.push(Buffer.from(data).toString());

      return 0;
    });

    const turn = new AbortController();

    const working = new IrcDelivery(client).working(
      "#ship",
      "request",
      turn.signal,
    );

    try {
      await until(() => blocked.some((line) => line.includes("is thinking")));

      if (cause === "expired") await delay(60);
      turn.abort();
      await working;
    } finally {
      write.mockRestore();
    }

    (Reflect.get(client, "flush") as () => void).call(client);
    await until(
      () =>
        server
          .received("captain")
          .filter((line) => line === "METADATA * SET status").length >= 2,
    );
    expect(
      server
        .received("captain")
        .some((line) => line.startsWith("METADATA") && line.includes(" is ")),
    ).toBe(false);
  },
);

test("a partially written status finishes its IRC line before terminal deletion", async () => {
  const { server, client } = await setup();
  await until(() =>
    server.received("captain").includes("METADATA * SET status"),
  );
  await until(() => Reflect.get(client, "metadataPending") === undefined);

  const socket = Reflect.get(client, "socket") as {
    write(data: Uint8Array): number;
  };

  const original = socket.write.bind(socket);
  let partial = false;

  const write = spyOn(socket, "write").mockImplementation((data) => {
    if (!partial) {
      partial = true;

      return original(data.subarray(0, 7));
    }

    return 0;
  });

  const turn = new AbortController();

  const working = new IrcDelivery(client).working(
    "#ship",
    "request",
    turn.signal,
  );

  try {
    await until(() => partial);
    turn.abort();
    await working;
  } finally {
    write.mockRestore();
  }

  (Reflect.get(client, "flush") as () => void).call(client);
  await until(
    () =>
      server
        .received("captain")
        .filter((line) => line === "METADATA * SET status").length >= 2,
  );
  expect(server.received("captain")).toContain(
    "METADATA * SET status :Apollo is thinking…",
  );
  expect(server.metadata.has("captain")).toBe(false);
});

test("unlabelled guarded replies are not reported sent while still wholly buffered", async () => {
  const { server, client } = await setup();
  await until(() => Reflect.get(client, "metadataPending") === undefined);

  const socket = Reflect.get(client, "socket") as {
    write(data: Uint8Array): number;
  };

  const write = spyOn(socket, "write").mockImplementation(() => 0);
  let allowed = true;
  let outcome = "pending";
  const sent = client.privmsg("#ship", "answer", {}, () => allowed);
  void sent.then(
    () => {
      outcome = "sent";
    },
    () => {
      outcome = "refused";
    },
  );
  await delay(15);
  const bufferedOutcome = outcome;
  allowed = false;
  write.mockRestore();
  (Reflect.get(client, "flush") as () => void).call(client);
  expect(bufferedOutcome).toBe("pending");
  await expect(sent).rejects.toThrow();
  expect(
    server.received("captain").some((line) => line.includes("PRIVMSG #ship")),
  ).toBe(false);
});

test("a started multiline item finishes atomically when its guard changes during backpressure", async () => {
  const { server, client } = await setup({}, [
    ...caps,
    "message-tags",
    "draft/multiline=max-bytes=4096,max-lines=20",
  ]);

  await until(
    () =>
      client.inChannel("#ship") &&
      Reflect.get(client, "metadataPending") === undefined,
  );

  const socket = Reflect.get(client, "socket") as {
    write(data: Uint8Array): number;
  };

  const original = socket.write.bind(socket);
  let started = false;

  const write = spyOn(socket, "write").mockImplementation((data) => {
    if (!started) {
      started = true;
      const end = Buffer.from(data).indexOf("\r\n") + 2;

      return original(data.subarray(0, end));
    }

    return 0;
  });

  let allowed = true;

  const sent = client.sendBatch(
    "#ship",
    [
      { text: "first", concat: false },
      { text: "second", concat: false },
    ],
    {},
    () => allowed,
  );

  void sent.catch(() => {});

  try {
    await until(() => started);
    allowed = false;
  } finally {
    write.mockRestore();
  }

  (Reflect.get(client, "flush") as () => void).call(client);
  await sent;
  await until(() => server.batches.length === 1);
  expect(server.batches[0]?.lines.map((line) => line.text)).toEqual([
    "first",
    "second",
  ]);
  await client.tagmsg("#ship", { "+typing": "done" });
});
