import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Effect, Result, Schema, SchemaIssue } from "effect";
import { z } from "zod";
import { crewInputSchema } from "../src/crew/engine";
import { historyInputSchema } from "../src/crew/history";
import { journalInputSchema } from "../src/crew/journal";
import { mailInputSchema } from "../src/crew/messaging";
import { modelInputSchema, modelToolInputSchema } from "../src/crew/models";
import * as toolInputs from "../src/crew/tool-input";
import { objectToolInput } from "../src/crew/tool-input";
import { cronOperationSchema } from "../src/cron-control";
import { notificationInputSchema } from "../src/notification-store";

const schemas = {
  stargate_cron: cronOperationSchema,
  stargate_crew: crewInputSchema,
  stargate_history: historyInputSchema,
  stargate_mail: mailInputSchema,
  stargate_notifications: notificationInputSchema,
};

test("Effect envelope advertises encoded fields and validates without injecting branch values", () => {
  const original = Schema.Union([
    Schema.Struct({
      op: Schema.Literal("append"),
      text: Schema.Trim.check(Schema.isMinLength(1)),
      nested: Schema.Struct({ value: Schema.String }),
    }),
    Schema.Struct({
      op: Schema.Literal("read"),
      limit: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
    }),
  ]);
  const envelope = toolInputs.effectObjectToolInput(original);
  const json = Schema.toJsonSchemaDocument(envelope, {
    onExcessProperty: "error",
  }).schema;
  expect(json["type"]).toBe("object");
  expect(json["required"]).toEqual(["op"]);
  for (const key of ["anyOf", "oneOf", "allOf"])
    expect(json).not.toHaveProperty(key);
  const decode = Schema.decodeUnknownSync(envelope);
  expect(decode({ op: "read" })).toEqual({ op: "read" });
  const append = { op: "append", text: "  note  ", nested: { value: "ok" } };
  expect(decode(append)).toEqual(append);
  for (const input of [
    { op: "read", text: "another branch" },
    { op: "read", extra: true },
    { op: "append", text: "  ", nested: { value: "ok" } },
    { op: "append", text: "note", nested: { value: "ok", extra: true } },
  ])
    expect(Result.isFailure(Schema.decodeUnknownResult(envelope)(input))).toBe(
      true,
    );
  const invalid = Schema.decodeUnknownResult(envelope)({
    op: "append",
    text: "note",
    nested: { value: 1 },
  });
  if (!Result.isFailure(invalid)) throw new Error("Expected nested rejection");
  expect(
    SchemaIssue.makeFormatterStandardSchemaV1()(invalid.failure.issue).issues,
  ).toContainEqual(expect.objectContaining({ path: ["nested", "value"] }));
});

test("Effect journal envelope leaves defaults and trim to its handler", () => {
  const decode = Schema.decodeUnknownSync(
    toolInputs.effectObjectToolInput(journalInputSchema),
  );
  expect(decode({ op: "read" })).toEqual({ op: "read" });
  expect(decode({ op: "append", text: "  note  " })).toEqual({
    op: "append",
    text: "  note  ",
  });
  expect(() => decode({ op: "read", text: "wrong branch" })).toThrow();
});

test("Effect struct advertisements keep required fields and resolvable definitions", () => {
  const nested = Schema.Struct({ value: Schema.String }).annotate({
    identifier: "NestedToolInput",
  });
  const original = Schema.Struct({
    nested,
    label: Schema.optional(Schema.String),
  });
  const envelope = toolInputs.effectObjectToolInput(original);
  const document = Schema.toJsonSchemaDocument(envelope, {
    onExcessProperty: "error",
  });
  expect(document.schema["required"]).toEqual(["nested"]);
  expect(document.definitions).toHaveProperty("NestedToolInput");
  const tool = {
    name: "fixture",
    description: "Local schema reference fixture",
    parameters: { ...document.schema, $defs: document.definitions },
  };
  const input = { nested: { value: "kept" }, label: null };
  const coerced = validateToolArguments(tool, {
    type: "toolCall",
    id: "fixture-call",
    name: "fixture",
    arguments: input,
  });
  expect(Schema.decodeUnknownSync(envelope)(coerced)).toEqual({
    nested: { value: "kept" },
  });
  expect(() =>
    Schema.decodeUnknownSync(envelope)({
      nested: { value: "kept", extra: true },
    }),
  ).toThrow();
});

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

test("optional envelope fields do not inject another operation's defaults", async () => {
  for (const [original, input] of [
    [crewInputSchema, { op: "ensure" }],
    [mailInputSchema, { op: "inbox" }],
    [cronOperationSchema, { op: "report" }],
    [historyInputSchema, { op: "sessions" }],
  ] as const) {
    const adapted = objectToolInput(original).parse(input);
    expect(original.parse(adapted)).toEqual(original.parse(input));
  }
  const input = { op: "get" };
  const adapted = await modelToolInputSchema["~standard"].validate(input);
  expect(adapted).toEqual({ value: input });
  if (adapted.issues) throw new Error("Unexpected model validation failure");
  expect(Schema.decodeUnknownSync(modelInputSchema)(adapted.value)).toEqual({
    op: "get",
    target: "self",
  });
});
