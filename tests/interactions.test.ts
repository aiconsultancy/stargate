import { expect, test } from "bun:test";
import { controlInteractions } from "../src/slack/interactions";

test("configuration buttons use the existing interaction path without consuming Stop or cron", async () => {
  const calls: string[] = [];
  const handler = {
    async command() {},
    async interactive() {
      calls.push("cron");
    },
  };
  const controls = controlInteractions(
    handler,
    handler,
    (body) => {
      if (body === "stop") {
        calls.push("stop");
        return true;
      }
      return false;
    },
    undefined,
    async (body, ack) => {
      if (body !== "panel") return false;
      calls.push("panel");
      await ack();
      return true;
    },
  );
  const ack = async () => {
    calls.push("ack");
  };
  await controls.interactive("panel", ack);
  await controls.interactive("stop", ack);
  await controls.interactive("other", ack);
  expect(calls).toEqual(["panel", "ack", "stop", "ack", "cron"]);
});

test("exact namespaces dispatch pairing, cron and Stop; unknown commands stay private", async () => {
  const calls: string[] = [];
  const interaction = (name: string) => ({
    async command() {
      calls.push(`${name}-command`);
    },
    async interactive() {
      calls.push(`${name}-interactive`);
    },
  });
  const controls = controlInteractions(
    interaction("cron"),
    interaction("pair"),
    (body) => {
      const stop = body === "stop";
      if (stop) calls.push("stop");
      return stop;
    },
    interaction("crew"),
  );
  const ack = async () => {
    calls.push("ack");
  };
  await controls.command({ command: "/stargate", text: "pair" }, ack);
  await controls.command({ command: "/cron", text: "list" }, ack);
  await controls.command({ command: "/stargate", text: "crew" }, ack);
  await controls.command({ command: "/stargate", text: "crew twiki" }, ack);
  await controls.command({ command: "/stargate", text: "usage" }, ack);
  await controls.interactive(
    { actions: [{ action_id: "stargate_pair_generate" }] },
    ack,
  );
  await controls.interactive({ view: { callback_id: "stargate_pair" } }, ack);
  await controls.interactive("stop", ack);
  await controls.interactive({ actions: [{ action_id: "cron_add" }] }, ack);
  expect(calls).toEqual([
    "pair-command",
    "cron-command",
    "crew-command",
    "crew-command",
    "crew-command",
    "pair-interactive",
    "pair-interactive",
    "stop",
    "ack",
    "cron-interactive",
  ]);
  const acks: (Record<string, unknown> | undefined)[] = [];
  for (const command of [
    "/pair",
    "/stargate-other",
    "/cron-other",
    undefined,
  ]) {
    await controls.command({ command }, async (payload) => {
      acks.push(payload);
    });
  }
  expect(acks).toHaveLength(4);
  for (const payload of acks)
    expect(payload).toMatchObject({ response_type: "ephemeral" });
  for (const text of [
    "pair extra",
    "pairing",
    "crew-other",
    "usage-other",
    "",
    undefined,
  ]) {
    await controls.command({ command: "/stargate", text }, async (payload) => {
      expect(payload).toMatchObject({ response_type: "ephemeral" });
    });
  }
  expect(calls).toHaveLength(10);
});
