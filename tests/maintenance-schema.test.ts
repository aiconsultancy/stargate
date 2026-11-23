import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { messagePortableSchema } from "../src/coordination/crew/messaging/message-tool-input";
import {
  maintenanceNoticeSchema,
  maintenancePlanSchema,
} from "../src/automation/maintenance/maintenance";
import { cleanupItemSchema } from "../src/automation/maintenance/nightly/cleanup/cleanup-config";
import {
  noticeSchema,
  reportJsonSchema,
} from "../src/automation/maintenance/nightly/reports/report";
import { readState } from "../src/automation/maintenance/nightly/state";
import { readySchema } from "../src/automation/maintenance/nightly/update/ready";

// Batch 16 (NET-1806): parity points frozen from the Zod 4.6.7 schemas.
const root = await mkdtemp(join(tmpdir(), "stargate-maintenance-schema-"));

afterAll(() => rm(root, { recursive: true, force: true }));

const accepts = (schema: Schema.Codec<unknown, unknown>, input: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input));

const emoji = (count: number) => "😀".repeat(count);

test("maintenance plan trims, counts code points and rejects unknown keys", () => {
  const plan = { plan: " Update ", impact: "None", rollback: "Revert" };
  expect(Schema.decodeUnknownSync(maintenancePlanSchema)(plan)).toEqual({
    plan: "Update",
    impact: "None",
    rollback: "Revert",
  });
  expect(accepts(maintenancePlanSchema, { ...plan, plan: emoji(1000) })).toBe(
    true,
  );
  expect(accepts(maintenancePlanSchema, { ...plan, plan: emoji(1001) })).toBe(
    false,
  );
  expect(accepts(maintenancePlanSchema, { ...plan, plan: "   " })).toBe(false);
  expect(accepts(maintenancePlanSchema, { ...plan, extra: 1 })).toBe(false);
  expect(
    accepts(
      maintenancePlanSchema,
      Object.assign(Object.create({ inherited: 1 }), plan),
    ),
  ).toBe(false);
  expect(accepts(maintenanceNoticeSchema, { ...plan, id: emoji(100) })).toBe(
    true,
  );
  expect(accepts(maintenanceNoticeSchema, { ...plan, id: emoji(101) })).toBe(
    false,
  );
});

test("the maintenance tool keeps its Zod advertisement", () => {
  const tool = messagePortableSchema(maintenancePlanSchema)["~standard"];

  const text = (minimum: number, maximum: number) => ({
    type: "string",
    minLength: minimum,
    maxLength: maximum,
  });

  expect(
    JSON.stringify(tool.jsonSchema.input({ target: "draft-2020-12" })),
  ).toBe(
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        plan: text(1, 1000),
        impact: text(1, 500),
        rollback: text(1, 500),
      },
      required: ["plan", "impact", "rollback"],
      additionalProperties: false,
    }),
  );
});

test("readiness keeps safe positive integers and strict nested records", () => {
  const ready = {
    schema: "stargate.ready.v1",
    pid: 10,
    readyAt: 1_700_000_000_000,
    version: null,
  };

  expect(accepts(readySchema, ready)).toBe(true);
  expect(accepts(readySchema, { ...ready, pid: 2 ** 53 })).toBe(false);
  expect(accepts(readySchema, { ...ready, pid: 0 })).toBe(false);
  const transport = { kind: "irc", id: emoji(256), state: "connected" };
  expect(accepts(readySchema, { ...ready, transports: [transport] })).toBe(
    true,
  );
  expect(
    accepts(readySchema, {
      ...ready,
      transports: [{ ...transport, extra: true }],
    }),
  ).toBe(false);
  expect(
    accepts(readySchema, {
      ...ready,
      transports: Array.from({ length: 1001 }, () => transport),
    }),
  ).toBe(false);
});

test("state drops only a damaged section and strips unknown entry keys", async () => {
  const data = join(root, "state");
  await mkdir(join(data, "maintenance"), { recursive: true });
  await writeFile(
    join(data, "maintenance", "state.json"),
    JSON.stringify({
      npm: {
        "@opencode/cli": {
          version: "2.2.7",
          before: "2026-11-12T00:07:01+01:00",
          extra: 1,
        },
      },
      cliproxyapi: { "8.0.54": { asset: "A".repeat(64), binary: "a" } },
      openCodeRelease: "v0.5.0",
    }),
  );
  expect(await readState(data)).toEqual({
    npm: {
      "@opencode/cli": {
        version: "2.2.7",
        before: "2026-11-12T00:07:01+01:00",
      },
    },
    cliproxyapi: {},
    failedReleases: {},
    openCodeRelease: "v0.5.0",
  });
});

test("report identifiers, timestamps and notices keep their Zod rules", () => {
  const notice = {
    schema: "stargate.maintenance.notice.v1",
    channel: "C123",
    text: emoji(2800),
    report: "a.json",
  };

  expect(accepts(noticeSchema, notice)).toBe(true);
  expect(accepts(noticeSchema, { ...notice, text: emoji(2801) })).toBe(false);

  const item = {
    kind: "scratch",
    path: "/tmp/scratch",
    status: "removed",
    reason: "stale",
    size: 0,
    newestMtime: 0,
  };

  expect(accepts(cleanupItemSchema, item)).toBe(true);
  expect(accepts(cleanupItemSchema, { ...item, path: "relative" })).toBe(false);
  expect(accepts(cleanupItemSchema, { ...item, path: "/a\u0001" })).toBe(false);
  expect(accepts(cleanupItemSchema, { ...item, size: Infinity })).toBe(false);
});

test("maintenance schema prints the frozen Zod 4.6.7 advertisement", () => {
  const text = JSON.stringify(reportJsonSchema(), null, 2);
  expect(createHash("sha256").update(text).digest("hex")).toBe(
    "96443b7ee8f278bdb12f98d2eab1df132000a6abe51ee6865083d1fc60b8c0db",
  );
});
