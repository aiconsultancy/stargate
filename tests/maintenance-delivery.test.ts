import { expect, spyOn, test } from "bun:test";
import type { AgentBackend } from "../src/backends/backend";
import type { MaintenanceWatch } from "../src/automation/maintenance/maintenance";
import { startMaintenanceDelivery } from "../src/automation/maintenance/maintenance-delivery";

const notice = {
  id: "notice",
  plan: "Restart",
  impact: "Brief disconnect",
  rollback: "Restore",
};

function fixture(watch: MaintenanceWatch) {
  const stop = new AbortController();

  const backend: AgentBackend = {
    async createSession() {
      return "session";
    },
    async prompt() {
      return "answer";
    },
    async close() {},
    async startMaintenance() {
      return watch;
    },
  };

  const input = {
    backend,
    sessionID: "captain",
    requestID: "turn",
    signal: stop.signal,
    async publish() {},
    resume() {},
    cancel() {
      stop.abort();
    },
  };

  return { input, stop };
}

test("gate acknowledges only after cancellable Slack publication completes", async () => {
  const publishing = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const order: string[] = [];

  const f = fixture({
    async read() {
      return notice;
    },
    async delivered(id) {
      expect(id).toBe("notice");
      order.push("delivered");
      delivered.resolve();
    },
    async close() {
      order.push("closed");
    },
  });

  f.input.publish = async () => {
    order.push("publish");
    publishing.resolve();
    await released.promise;
  };

  const handle = await startMaintenanceDelivery(f.input);
  await publishing.promise;
  expect(order).toEqual(["publish"]);
  released.resolve();
  await delivered.promise;
  expect(order).toEqual(["publish", "delivered"]);
  await handle?.close();
  expect(order).toEqual(["publish", "delivered", "closed"]);
});

test("publication failure, transport failure and cancellation never acknowledge delivery", async () => {
  for (const failure of ["publish", "read", "stop"] as const) {
    let acknowledged = false;
    const cancelled = Promise.withResolvers<void>();

    const f = fixture({
      async read() {
        if (failure === "read") throw new Error("Transport failed");

        return notice;
      },
      async delivered() {
        acknowledged = true;
      },
      async close() {},
    });

    f.input.publish = async () => {
      if (failure === "publish") throw new Error("Slack unavailable");
      f.stop.abort();
      cancelled.resolve();
    };

    f.input.cancel = () => {
      f.stop.abort();
      cancelled.resolve();
    };

    const handle = await startMaintenanceDelivery(f.input);
    await cancelled.promise;
    await handle?.close();
    expect(acknowledged).toBe(false);
    expect(f.stop.signal.aborted).toBe(true);
  }
});

test("missing plugin is compatible with ordinary bots but creates no maintenance gate", async () => {
  const f = fixture({
    async read() {
      return null;
    },
    async delivered() {},
    async close() {},
  });

  f.input.backend.startMaintenance = async () => {
    throw new Error("RPC absent");
  };

  expect(await startMaintenanceDelivery(f.input)).toBeUndefined();
  expect(f.stop.signal.aborted).toBe(false);
});

test("delivery acknowledgement gets a fresh deadline after slow publication", async () => {
  const deadlines: { ms: number; controller: AbortController }[] = [];

  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    deadlines.push({ ms, controller });

    return controller.signal;
  });

  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<AbortSignal>();
  let readSignal: AbortSignal | undefined;

  const f = fixture({
    async read(signal) {
      readSignal = signal;

      return notice;
    },
    async delivered(_id, signal) {
      acknowledged.resolve(signal);
    },
    async close() {},
  });

  f.input.publish = async () => {
    publishing.resolve();
    await release.promise;
  };

  let handle: Awaited<ReturnType<typeof startMaintenanceDelivery>>;

  try {
    handle = await startMaintenanceDelivery(f.input);
    await publishing.promise;
    const readDeadline = deadlines.find(({ ms }) => ms === 5000);
    expect(readDeadline).toBeDefined();
    readDeadline?.controller.abort();
    expect(readSignal?.aborted).toBe(true);
    release.resolve();
    const deliveredSignal = await acknowledged.promise;
    expect(deliveredSignal).not.toBe(readSignal);
    expect(deliveredSignal.aborted).toBe(false);
    expect(deadlines.filter(({ ms }) => ms === 5000)).toHaveLength(2);
    expect(f.stop.signal.aborted).toBe(false);
  } finally {
    release.resolve();
    await handle?.close();
    timeout.mockRestore();
  }
});

test("owner cancellation during publication never acknowledges or restores authority", async () => {
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];

  const f = fixture({
    async read() {
      return notice;
    },
    async delivered() {
      order.push("delivered");
    },
    async close() {},
  });

  f.input.publish = async () => {
    publishing.resolve();
    await release.promise;
    order.push("published");
  };

  f.input.resume = () => {
    expect(f.stop.signal.aborted).toBe(true);
    order.push("resume-cancelled");
  };

  const handle = await startMaintenanceDelivery(f.input);

  try {
    await publishing.promise;
    f.stop.abort();
    release.resolve();
    await handle?.close();
    expect(order).toEqual(["published", "resume-cancelled"]);
    expect(f.stop.signal.aborted).toBe(true);
  } finally {
    release.resolve();
    await handle?.close();
  }
});
