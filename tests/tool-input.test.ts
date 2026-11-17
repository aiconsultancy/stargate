import { expect, test } from "bun:test";
import { z } from "zod";
import { crewInputSchema } from "../src/crew/engine";
import { historyInputSchema } from "../src/crew/history";
import { journalInputSchema } from "../src/crew/journal";
import { mailInputSchema } from "../src/crew/messaging";
import { modelInputSchema } from "../src/crew/models";
import { objectToolInput } from "../src/crew/tool-input";
import { cronOperationSchema } from "../src/cron-control";
import { notificationInputSchema } from "../src/notification-store";

const schemas = {
  stargate_cron: cronOperationSchema,
  stargate_crew: crewInputSchema,
  stargate_history: historyInputSchema,
  stargate_journal: journalInputSchema,
  stargate_mail: mailInputSchema,
  stargate_model: modelInputSchema,
  stargate_notifications: notificationInputSchema,
};

test("all Stargate union tools advertise an object root with their fields", () => {
  for (const schema of Object.values(schemas)) {
    const json = z.toJSONSchema(objectToolInput(schema));
    expect(json.type).toBe("object");
    for (const key of ["oneOf", "anyOf", "allOf"])
      expect(json).not.toHaveProperty(key);
    expect(json.required).toContain("op");
    for (const option of schema.options)
      for (const name of Object.keys(option.shape))
        expect(json.properties).toHaveProperty(name);
  }
});

test("notification union keeps explicit scoped requirements and input expiry representation", () => {
  const schema = objectToolInput(notificationInputSchema);
  for (const input of [
    { op: "mute", scope: "thread", channel: "C123" },
    { op: "unmute", scope: "channel", channel: "D123" },
    { op: "clear_all", channel: "C123" },
    {
      op: "status",
      scope: "channel",
      channel: "C123",
      mute_until: "2026-11-18T10:00:00Z",
    },
  ])
    expect(schema.safeParse(input).success).toBe(false);
  const input = {
    op: "mute",
    scope: "thread",
    channel: "C123",
    thread_ts: "1.000",
    mute_until: "2026-11-18T12:00:00+02:00",
  };
  expect(notificationInputSchema.parse(schema.parse(input))).toMatchObject({
    mute_until: "2026-11-18T10:00:00.000Z",
  });
});

test("original branch requirements, strictness and bounds remain enforced", () => {
  const schema = objectToolInput(crewInputSchema);
  for (const input of [
    {},
    { op: "unknown" },
    { op: "dispatch", crew: "apollo" },
    { op: "dispatch", crew: "apollo", text: "" },
    { op: "roster", text: "extra branch field" },
    { op: "roster", unexpected: true },
    { op: "abandon", acknowledgeUnconfirmedStop: false },
  ]) {
    expect(crewInputSchema.safeParse(input).success).toBe(false);
    expect(schema.safeParse(input).success).toBe(false);
  }
  expect(schema.safeParse({ op: "roster" }).success).toBe(true);
  expect(
    schema.safeParse({ op: "dispatch", crew: "apollo", text: "check" }).success,
  ).toBe(true);
});

test("optional envelope fields do not inject another operation's defaults", () => {
  for (const [original, input] of [
    [crewInputSchema, { op: "ensure" }],
    [modelInputSchema, { op: "get" }],
    [mailInputSchema, { op: "inbox" }],
    [journalInputSchema, { op: "read" }],
    [cronOperationSchema, { op: "report" }],
    [historyInputSchema, { op: "sessions" }],
  ] as const) {
    const adapted = objectToolInput(original).parse(input);
    expect(original.parse(adapted)).toEqual(original.parse(input));
  }
});
