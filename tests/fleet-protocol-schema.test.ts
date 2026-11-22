import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Info, ToolEditor } from "@opencode/plugin/promise/tool";
import { Result, Schema } from "effect";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "effect/StandardSchema";
import { installFleetTools } from "../src/fleet/plugin";
import * as protocol from "../src/fleet/protocol";
import { settingsIssues } from "../src/settings-schema";
import { Store } from "../src/gateway/store";

const target = {
  repository: "Owner/Repo",
  pullRequest: 7,
  headSHA: "a".repeat(40),
  baseSHA: "b".repeat(40),
  mergeBaseSHA: "c".repeat(40),
};
const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
const source = {
  reference: "source",
  transport: "irc",
  account: "human",
  authority: "human",
  text: "  Original text 😀  ",
  channel: "#ship",
  messageID: "message",
  receivedAt: "2024-02-29T12:30:00.123456Z",
} as const;
const maker = {
  messageID: "message",
  agent: "worker",
  provider: "provider",
  model: "model",
};

test("all fleet runtime protocol validators are native", () => {
  for (const schema of [
    protocol.reviewTargetSchema,
    protocol.reviewContextTextSchema,
    protocol.reviewAssignmentSchema,
    protocol.sourceSchema,
    protocol.callerSchema,
    protocol.verifyInputSchema,
    protocol.dispatchInputSchema,
    protocol.statusInputSchema,
    protocol.reviewInputSchema,
    protocol.requestSchema,
    protocol.nativeMakerSchema,
    protocol.reviewContextSchema,
    protocol.reviewBindingSchema,
    protocol.reviewVerdictSchema,
    protocol.reviewProofSchema,
    protocol.fleetOriginSchema,
    protocol.fleetCompletionSchema,
    protocol.fleetJobSchema,
  ])
    expect(Schema.isSchema(schema)).toBe(true);
});

test("fleet decoding keeps raw text, omitted versus undefined keys, transforms and field order", () => {
  const decode = Schema.decodeUnknownSync(protocol.dispatchInputSchema);
  const input = {
    sourceReference: "source",
    text: " note\n\t😀 ",
    target: "captain",
  };
  expect(JSON.stringify(decode(input))).toBe(
    '{"target":"captain","text":" note\\n\\t😀 ","sourceReference":"source"}',
  );
  expect(Object.hasOwn(decode(input), "requestID")).toBe(false);
  expect(
    Object.hasOwn(decode({ ...input, requestID: undefined }), "requestID"),
  ).toBe(true);
  for (const value of [
    { ...input, requestID: null },
    { ...input, target: " captain " },
    { ...input, text: "bad\0text" },
    { ...input, text: "😀".repeat(1801) },
  ])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(protocol.dispatchInputSchema)(value),
      ),
    ).toBe(true);
  expect(decode({ ...input, text: "😀".repeat(1800) }).text).toHaveLength(3600);
  expect(Schema.decodeUnknownSync(protocol.reviewTargetSchema)(target)).toEqual(
    { ...target, repository: "owner/repo" },
  );
  expect(
    Schema.encodeUnknownSync(protocol.reviewTargetSchema)(target).repository,
  ).toBe("Owner/Repo");
  expect(Schema.decodeUnknownSync(protocol.sourceSchema)(source).text).toBe(
    source.text,
  );
});

test("UTC timestamps retain spelling and require valid calendar dates and seconds", () => {
  const decode = Schema.decodeUnknownSync(protocol.sourceSchema);
  for (const receivedAt of [
    source.receivedAt,
    "2000-02-29T00:00:00Z",
    "2026-11-19T23:59:59.0Z",
  ])
    expect(decode({ ...source, receivedAt }).receivedAt).toBe(receivedAt);
  for (const receivedAt of [
    "2023-02-29T12:30:00Z",
    "1900-02-29T00:00:00Z",
    "2026-04-31T12:30:00Z",
    "2026-11-19T12:30Z",
    "2026-11-19T12:30:00+00:00",
    "2026-11-19T12:30:00z",
    "2026-11-19T24:00:00Z",
  ])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(protocol.sourceSchema)({
          ...source,
          receivedAt,
        }),
      ),
    ).toBe(true);
});

test("strict runtime objects reject own/inherited and nested extras on native decode/encode", async () => {
  const request = {
    operation: "dispatch",
    caller: {
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      id: "call",
    },
    input: {
      target: "captain",
      text: "note",
      sourceReference: "source",
      review: { ...target, context: diff },
    },
  };
  for (const value of [
    { ...request, extra: true },
    {
      ...request,
      input: {
        ...request.input,
        review: { ...request.input.review, extra: true },
      },
    },
    Object.assign(Object.create({ extra: true }), request),
  ]) {
    const result = Schema.decodeUnknownResult(protocol.requestSchema)(value);
    expect(Result.isFailure(result)).toBe(true);
    expect(
      Result.isFailure(
        Schema.encodeUnknownResult(protocol.requestSchema)(value),
      ),
    ).toBe(true);
    expect(
      await Schema.toStandardSchemaV1(protocol.requestSchema)[
        "~standard"
      ].validate(value),
    ).toHaveProperty("issues");
  }
  const failed = Schema.decodeUnknownResult(protocol.requestSchema)({
    ...request,
    input: {
      ...request.input,
      review: { ...target, pullRequest: 0, context: diff },
    },
  });
  if (Result.isSuccess(failed)) throw new Error("Invalid nested PR accepted");
  expect(settingsIssues(failed.failure.issue).issues).toContainEqual(
    expect.objectContaining({ path: ["input", "review", "pullRequest"] }),
  );
  const badTag = Schema.decodeUnknownResult(protocol.reviewInputSchema)({
    op: "unknown",
  });
  if (Result.isSuccess(badTag)) throw new Error("Unknown review accepted");
  expect(settingsIssues(badTag.failure.issue).issues).toContainEqual(
    expect.objectContaining({ path: ["op"] }),
  );
  const badSource = Schema.decodeUnknownResult(protocol.sourceSchema)({
    ...source,
    transport: "fleet",
  });
  if (Result.isSuccess(badSource))
    throw new Error("Human fleet context accepted");
  expect(settingsIssues(badSource.failure.issue).issues).toContainEqual(
    expect.objectContaining({
      message: "Fleet completion context must remain non-human",
    }),
  );
});

test("review diff and proof byte limits remain separate from code-point bounds", () => {
  const decode = Schema.decodeUnknownSync(protocol.reviewContextTextSchema);
  expect(decode(diff)).toBe(diff);
  const prefix = "diff --git a/a b/a\nrename from ";
  const suffix = "\nrename to a\n";
  const bounded =
    prefix + "x".repeat(256000 - prefix.length - suffix.length) + suffix;
  expect(Buffer.byteLength(bounded)).toBe(256000);
  expect(decode(bounded)).toBe(bounded);
  for (const value of [
    diff.replace("+new\n", "+new"),
    diff.replace("+new\n", ""),
    diff + "\ud800",
    diff + "\0",
    bounded.replace("rename to a", "rename to aa"),
  ])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(protocol.reviewContextTextSchema)(value),
      ),
    ).toBe(true);
  const proof = {
    ...target,
    id: "proof",
    reviewID: "review",
    contextDigest: "a".repeat(64),
    authorShip: "author",
    coordinatorShip: "coordinator",
    reviewerShip: "reviewer",
    reviewerAgent: "worker",
    kind: "crew",
    sessionID: "session",
    inputID: "input",
    makers: [maker],
    family: "family",
    outcome: "completed",
    verdict: "approve",
    resultText: "😀".repeat(16000),
    resultDigest: "b".repeat(64),
    completedAt: source.receivedAt,
    authority: "agent",
    humanApproval: false,
  };
  expect(
    Schema.decodeUnknownSync(protocol.reviewProofSchema)(proof).resultText,
  ).toHaveLength(32000);
  for (const resultText of [proof.resultText + "x", "\ud800"])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(protocol.reviewProofSchema)({
          ...proof,
          resultText,
        }),
      ),
    ).toBe(true);
});

test("binding reviewer defaults are fresh mutable arrays and nested rules stay strict", () => {
  const input = {
    id: "binding",
    nonce: "a".repeat(32),
    context: {
      ...target,
      id: "review",
      authorShip: "author",
      coordinatorShip: "coordinator",
      coordinatorSessionID: "session",
      dispatchID: "dispatch",
      contextDigest: "b".repeat(64),
    },
    contextText: diff,
    reviewerShip: "reviewer",
    reviewer: {
      agent: "worker",
      kind: "crew",
      family: "family",
      directory: "/review",
      models: [{ provider: "provider", model: "model" }],
    },
    sessionID: "session",
    inputID: "input",
    createdAt: source.receivedAt,
  };
  const decode = Schema.decodeUnknownSync(protocol.reviewBindingSchema);
  const first = decode(input),
    second = decode(input);
  expect(first.reviewer.permissions).toEqual([]);
  expect(first.reviewer.permissions).not.toBe(second.reviewer.permissions);
  first.reviewer.permissions.push({
    action: "read",
    resource: "*",
    effect: "allow",
  });
  expect(second.reviewer.permissions).toEqual([]);
  expect(first.context.repository).toBe("owner/repo");
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(protocol.reviewBindingSchema)({
        ...input,
        reviewer: {
          ...input.reviewer,
          permissions: [{ action: "shell", resource: "*", effect: "allow" }],
        },
      }),
    ),
  ).toBe(true);
});

test("Store fleet makers preserve read101/write100 and immutable first-save behavior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-fleet-schema-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  try {
    store.enqueue({
      eventId: "event",
      botKey: "bot",
      conversation: "conversation",
      channel: "channel",
      thread: "thread",
      user: "user",
      text: "text",
      fleet: { kind: "assignment", dispatchID: "dispatch" },
    });
    const job = store.jobByEvent("bot", "event");
    if (!job) throw new Error("Missing fixture job");
    expect(job.fleet).toEqual({ kind: "assignment", dispatchID: "dispatch" });
    expect(() =>
      store.fleet.saveMakers(
        job.id,
        Array.from({ length: 101 }, () => maker),
      ),
    ).toThrow();
    store.fleet.saveMakers(job.id, [maker]);
    store.fleet.saveMakers(job.id, [{ ...maker, agent: "different" }]);
    expect(store.jobByEvent("bot", "event")?.makers).toEqual([maker]);
    const db = new Database(path);
    try {
      db.query("UPDATE jobs SET makers=? WHERE id=?").run(
        JSON.stringify(Array.from({ length: 101 }, () => maker)),
        job.id,
      );
    } finally {
      db.close();
    }
    expect(store.jobByEvent("bot", "event")?.makers).toHaveLength(101);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual fleet tool registrations stay native with explicit review opt-in and union advertisement", async () => {
  for (const reviews of [undefined, true]) {
    const tools: Info[] = [];
    const editor: ToolEditor = {
      list: () => [],
      get: () => undefined,
      namespace() {},
      add(tool) {
        tools.push(tool);
      },
      update() {},
      remove() {},
    };
    const dispose = await installFleetTools({
      options: {
        socketPath: "/fleet.sock",
        ...(reviews === undefined ? {} : { reviews }),
      },
      tool: {
        async transform(edit) {
          edit(editor);
          return { async dispose() {} };
        },
      },
      permission: {
        async assert() {
          throw new Error("No execution expected");
        },
      },
    });
    try {
      expect(tools.map(({ name }) => name)).toEqual([
        ...(reviews ? ["fleet_review"] : []),
        "fleet_verify_instruction",
        "fleet_dispatch",
        "fleet_answer_offer",
        "fleet_status",
      ]);
      for (const tool of tools) expect(Schema.isSchema(tool.input)).toBe(true);
      const dispatch = tools.find(({ name }) => name === "fleet_dispatch");
      if (!dispatch || !("~standard" in dispatch.input))
        throw new Error("Missing Standard dispatch input");
      expect(
        await (dispatch.input as StandardSchemaV1)["~standard"].validate({
          target: "captain",
          text: " note ",
          sourceReference: "source",
        }),
      ).toEqual({
        value: { target: "captain", text: " note ", sourceReference: "source" },
      });
      const dispatchJSON = (
        dispatch.input as StandardSchemaV1 & StandardJSONSchemaV1
      )["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      expect(dispatchJSON).toMatchObject({
        type: "object",
        required: ["target", "text", "sourceReference"],
        additionalProperties: false,
      });
      if (reviews) {
        const review = tools.find(({ name }) => name === "fleet_review");
        if (!review) throw new Error("Missing opted-in review");
        expect(
          (review.input as StandardSchemaV1 & StandardJSONSchemaV1)[
            "~standard"
          ].jsonSchema.input({ target: "draft-2020-12" }),
        ).toHaveProperty("oneOf");
      }
    } finally {
      await dispose();
    }
  }
  await expect(
    installFleetTools({
      options: { socketPath: "/fleet.sock", reviews: null },
      tool: {
        async transform() {
          throw new Error("Invalid options registered tools");
        },
      },
      permission: { async assert() {} },
    }),
  ).rejects.toBeDefined();
});
