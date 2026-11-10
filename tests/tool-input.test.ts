import { expect, test } from "bun:test";
import { z } from "zod";
import { crewInputSchema } from "../src/crew/engine";
import { historyInputSchema } from "../src/crew/history";
import { journalInputSchema } from "../src/crew/journal";
import { mailInputSchema } from "../src/crew/messaging";
import { modelInputSchema } from "../src/crew/models";
import { objectToolInput } from "../src/crew/tool-input";
import { cronOperationSchema } from "../src/cron-control";

const schemas = {
  pogo_cron: cronOperationSchema,
  pogo_crew: crewInputSchema,
  pogo_history: historyInputSchema,
  pogo_journal: journalInputSchema,
  pogo_mail: mailInputSchema,
  pogo_model: modelInputSchema,
};

test("all Pogo union tools advertise an object root with their fields", () => {
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
