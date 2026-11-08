import { expect, test } from "bun:test";
import type { AgentBackend } from "../src/backend";
import type { MaintenanceWatch } from "../src/maintenance";
import { startMaintenanceDelivery } from "../src/maintenance-delivery";

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
