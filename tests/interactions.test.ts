import { expect, test } from "bun:test";
import { controlInteractions } from "../src/interactions";

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
  await controls.command({ command: "/pogo", text: "pair" }, ack);
  await controls.command({ command: "/cron", text: "list" }, ack);
  await controls.command({ command: "/pogo", text: "crew" }, ack);
  await controls.command({ command: "/pogo", text: "crew twiki" }, ack);
  await controls.interactive(
    { actions: [{ action_id: "pogo_pair_generate" }] },
    ack,
  );
  await controls.interactive({ view: { callback_id: "pogo_pair" } }, ack);
  await controls.interactive("stop", ack);
  await controls.interactive({ actions: [{ action_id: "cron_add" }] }, ack);
  expect(calls).toEqual([
    "pair-command",
    "cron-command",
    "crew-command",
    "crew-command",
    "pair-interactive",
    "pair-interactive",
    "stop",
    "ack",
    "cron-interactive",
  ]);
  const acks: (Record<string, unknown> | undefined)[] = [];
  for (const command of ["/pair", "/pogo-other", "/cron-other", undefined]) {
    await controls.command({ command }, async (payload) => {
      acks.push(payload);
    });
  }
  expect(acks).toHaveLength(4);
  for (const payload of acks)
    expect(payload).toMatchObject({ response_type: "ephemeral" });
  for (const text of ["pair extra", "pairing", "crew-other", "", undefined]) {
    await controls.command({ command: "/pogo", text }, async (payload) => {
      expect(payload).toMatchObject({ response_type: "ephemeral" });
    });
  }
  expect(calls).toHaveLength(9);
});
