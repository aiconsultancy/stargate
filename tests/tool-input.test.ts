import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Effect, Result, Schema, SchemaIssue } from "effect";
import { z } from "zod";
import { postInputSchema } from "../src/captain-post/captain-post";
import { crewOpenCodeInput } from "../src/crew/input/crew-tool-input";
import { crewInputSchema } from "../src/crew/execution/engine";
import {
  historyInputBranches,
  historyInputSchema,
} from "../src/crew/history/history";
import { journalInputSchema } from "../src/crew/reporting/journal";
import {
  messageOpenCodeInput,
  messagePortableSchema,
} from "../src/crew/messaging/message-tool-input";
import {
  mailInputBranches,
  mailInputSchema,
} from "../src/crew/messaging/messaging";
import {
  modelInputSchema,
  modelToolInputSchema,
} from "../src/crew/controls/models";
import { projectToolInput } from "../src/crew/input/project-options";
import * as toolInputs from "../src/crew/input/tool-input";
import { objectToolInput } from "../src/crew/input/tool-input";
import { cronToolInput } from "../src/crew/cron/cron";
import { cronOperationSchema } from "../src/cron/control";
import { notificationInputSchema } from "../src/notifications/preferences/notification-store";
import { quotaInputSchema } from "../src/quota/quota";

const schemas = {
  stargate_notifications: notificationInputSchema,
};

test("native post SDK input keeps defaults, raw text and its input advertisement", async () => {
  const input = messagePortableSchema(postInputSchema);
  const standard = input["~standard"];
  expect(Schema.isSchema(input)).toBe(true);
  expect(
    await standard.validate({ channel: "C123", text: "  hello 😀  " }),
  ).toEqual({
    value: {
      channel: "C123",
      text: "  hello 😀  ",
      files: [],
      reply_broadcast: false,
    },
  });

  const advertisement: Record<string, unknown> = standard.jsonSchema.input({
    target: "draft-2020-12",
  });

  expect(advertisement).toEqual({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      channel: { type: "string", pattern: "^[CGD][A-Z0-9]{2,40}$" },
      thread_ts: { type: "string", pattern: "^\\d{1,12}\\.\\d{1,12}$" },
      text: { type: "string" },
      files: {
        default: [],
        maxItems: 10,
        type: "array",
        items: { type: "string", minLength: 2, maxLength: 4096 },
      },
      reply_broadcast: { default: false, type: "boolean" },
      key: { type: "string", minLength: 1, maxLength: 255 },
    },
    required: ["channel", "text"],
    additionalProperties: false,
  });
  expect(Object.keys(advertisement["properties"] ?? {})).toEqual([
    "channel",
    "thread_ts",
    "text",
    "files",
    "reply_broadcast",
    "key",
  ]);

  const invalid = await standard.validate({
    channel: "C123",
    text: "note",
    reply_broadcast: true,
  });

  expect(invalid).toHaveProperty("issues");

  if (!invalid.issues) throw new Error("Broadcast without thread accepted");
  expect(invalid.issues).toContainEqual(
    expect.objectContaining({
      path: ["reply_broadcast"],
      message: "reply_broadcast requires thread_ts",
    }),
  );
  expect(
    await standard.validate({ channel: "C123", text: "note", extra: true }),
  ).toHaveProperty("issues");
});

test("post compound constraints retain broadcast diagnostics but structural failures abort them", async () => {
  const standard = messagePortableSchema(postInputSchema)["~standard"];

  for (const text of ["", 123]) {
    const input = { channel: "C123", text, reply_broadcast: true };

    const direct = Schema.decodeUnknownResult(postInputSchema, {
      errors: "all",
    })(input);

    if (Result.isSuccess(direct)) throw new Error("Invalid post accepted");
    const sdk = await standard.validate(input);

    if (!sdk.issues) throw new Error("Invalid SDK post accepted");

    for (const issues of [
      SchemaIssue.makeFormatterStandardSchemaV1()(direct.failure.issue).issues,
      sdk.issues,
    ]) {
      expect(issues).toContainEqual(
        expect.objectContaining({ path: ["text"] }),
      );

      if (text === "") {
        expect(issues).toContainEqual(
          expect.objectContaining({
            path: ["reply_broadcast"],
            message: "reply_broadcast requires thread_ts",
          }),
        );
      } else {
        expect(
          issues.some((issue) => issue.path?.includes("reply_broadcast")),
        ).toBe(false);
      }
    }
  }
});

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

  const cron = cronToolInput()["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  });

  expect(cron["type"]).toBe("object");

  for (const key of ["oneOf", "anyOf", "allOf"])
    expect(cron).not.toHaveProperty(key);
  expect(cron["required"]).toEqual(["op"]);
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

test("original branch requirements, strictness and bounds remain enforced", async () => {
  const schema = crewOpenCodeInput()["~standard"];

  for (const input of [
    {},
    { op: "unknown" },
    { op: "dispatch", crew: "apollo" },
    { op: "dispatch", crew: "apollo", text: "" },
    { op: "roster", text: "extra branch field" },
    { op: "roster", unexpected: true },
    { op: "abandon", acknowledgeUnconfirmedStop: false },
  ]) {
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(crewInputSchema)(input)),
    ).toBe(false);
    expect(await schema.validate(input)).toHaveProperty("issues");
  }

  expect(await schema.validate({ op: "roster" })).toHaveProperty("value");
  expect(
    await schema.validate({ op: "dispatch", crew: "apollo", text: "check" }),
  ).toHaveProperty("value");
});

test("native mail project envelope retains branch requirements and field paths", async () => {
  const schema = messageOpenCodeInput(mailInputBranches)["~standard"];
  const inbox = { op: "inbox", project: "stargate" };
  expect(await schema.validate(inbox)).toEqual({ value: inbox });

  const invalid = await schema.validate({
    op: "send",
    text: "note",
    project: "stargate",
  });

  if (!invalid.issues) throw new Error("Missing mail recipient accepted");
  expect(invalid.issues).toContainEqual(
    expect.objectContaining({ path: ["to"] }),
  );
});

test("Zod project helper preserves required operation fields after separating project", () => {
  const schema = projectToolInput(
    z.discriminatedUnion("op", [
      z.strictObject({ op: z.literal("report") }),
      z.strictObject({ op: z.literal("run"), name: z.string().min(1) }),
    ]),
  );

  expect(schema.parse({ op: "report", project: "stargate" })).toEqual({
    op: "report",
    project: "stargate",
  });
  const missing = schema.safeParse({ op: "run", project: "stargate" });

  if (missing.success) throw new Error("Missing operation name accepted");
  expect(missing.error.issues).toContainEqual(
    expect.objectContaining({ path: ["name"] }),
  );
});

test("remaining quota Zod project helper stays strict and validates project keys", () => {
  const schema = projectToolInput(quotaInputSchema);
  expect(schema.parse({})).toEqual({});
  expect(schema.parse({ project: undefined })).toEqual({ project: undefined });
  expect(schema.parse({ project: "stargate" })).toEqual({
    project: "stargate",
  });

  for (const raw of [
    null,
    [],
    { project: null },
    { project: "../foreign" },
    { project: "constructor" },
    { op: "inbox" },
  ])
    expect(schema.safeParse(raw).success).toBe(false);
});

test("optional envelope fields do not inject another operation's defaults", async () => {
  const cron = { op: "report" };
  const adaptedCron = await cronToolInput()["~standard"].validate(cron);
  expect(adaptedCron).toEqual({ value: cron });

  if (adaptedCron.issues) throw new Error("Cron report rejected");
  expect(
    Schema.decodeUnknownSync(cronOperationSchema)(adaptedCron.value),
  ).toEqual(Schema.decodeUnknownSync(cronOperationSchema)(cron));

  for (const [branches, original, input] of [
    [mailInputBranches, mailInputSchema, { op: "inbox" }],
    [historyInputBranches, historyInputSchema, { op: "sessions" }],
  ] as const) {
    const adapted =
      await messageOpenCodeInput(branches)["~standard"].validate(input);

    expect(adapted).toEqual({ value: input });

    if (adapted.issues) throw new Error("Native operation rejected");
    expect(Schema.decodeUnknownSync(original)(adapted.value)).toEqual(
      Schema.decodeUnknownSync(original)(input),
    );
  }

  const crew = await crewOpenCodeInput()["~standard"].validate({
    op: "ensure",
  });

  expect(crew).toEqual({ value: { op: "ensure" } });
  const input = { op: "get" };
  const adapted = await modelToolInputSchema["~standard"].validate(input);
  expect(adapted).toEqual({ value: input });

  if (adapted.issues) throw new Error("Unexpected model validation failure");
  expect(Schema.decodeUnknownSync(modelInputSchema)(adapted.value)).toEqual({
    op: "get",
    target: "self",
  });
});
