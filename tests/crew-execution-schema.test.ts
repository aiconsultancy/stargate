import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Result, Schema } from "effect";
import type { BackendContext } from "../src/backends/backend";
import {
  crewOpenCodeInput,
  crewPiParameters,
} from "../src/coordination/crew/input/crew-tool-input";
import {
  crewInputSchema,
  crewOptionsSchema,
} from "../src/coordination/crew/execution/engine";
import { crewMessageMetadataKey } from "../src/coordination/crew/message-protocol";
import { piCrewExtension } from "../src/coordination/crew/pi/pi-extension";
import { projectsSchema } from "../src/coordination/crew/input/project-options";
import {
  CrewRecovery,
  recoveryRequestSchema,
} from "../src/coordination/crew/execution/recovery-rpc";
import {
  MissingTaskResult,
  type ResultAPI,
  type ResultMessage,
  readTaskResult,
} from "../src/coordination/crew/execution/result";
import type { CrewTask } from "../src/coordination/crew/execution/state";
import { settingsIssues } from "../src/config/settings-schema";
import { settingsCanonical } from "./settings-cases";

export type BackendCrewCompatibility<
  T extends Parameters<typeof piCrewExtension>[0] = NonNullable<
    BackendContext["crew"]
  >,
> = T;

const team = {
  captain: { id: "captain" },
  crew: [{ id: "worker", role: "Builder", permissionProfile: "coding" }],
};

const options = {
  namespace: "fixture",
  stateDirectory: "/state",
  captainDirectory: "/captain",
  projectDirectory: "/project",
  worktrees: { worker: "/crew/worker" },
  mesijCommand: "/bin/mesij",
  team,
};

const resume = {
  op: "resume",
  taskID: "task_fixture",
  expected: {
    workerSessionID: "session",
    originCaptainID: "captain",
    inputID: "input",
    idleAt: 1,
  },
};

test("crew SDK advertisements retain frozen input and Pi contracts", () => {
  const values = [
    [
      crewOpenCodeInput()["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      }),
      "c7904990b07789c2e7e0c44e725f06c6ece0d0e859d1be7ba68fbd7645cb9498",
    ],
    [
      crewPiParameters(),
      "74121f5cd00b9af99d53d8ede9bff184b6c0c365c32451bcea1ec9f136cab387",
    ],
    [
      CrewRecovery.methods.run.input["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      }),
      "e1dbb81c0306c43bd4c237c5926ec4a77c73fdd42760efb0182248d074e4f573",
    ],
  ] as const;

  // Frozen c6 advertisements, canonical JSON object keys only; array order stays.
  for (const [json, hash] of values) {
    expect(
      createHash("sha256").update(settingsCanonical(json)).digest("hex"),
    ).toBe(hash);
  }

  expect(Schema.isSchema(CrewRecovery.methods.run.input)).toBe(true);
});

test("crew envelope preserves native field transforms but not top-level defaults", async () => {
  const standard = crewOpenCodeInput()["~standard"];

  const expected = {
    status: "uncertain",
    workerSessionID: "session",
    originCaptainID: "captain",
    inputID: "input",
  };

  const input = {
    op: "abandon",
    taskID: "task_fixture",
    expected,
    reason: " inspect ",
    key: "fixture",
    acknowledgeUnconfirmedStop: true,
  };

  expect(await standard.validate(input)).toEqual({
    value: { ...input, reason: "inspect" },
  });
  expect(
    await standard.validate({
      ...input,
      expected: { ...expected, controlID: undefined },
    }),
  ).toEqual({
    value: {
      ...input,
      expected: { ...expected, controlID: null },
      reason: "inspect",
    },
  });

  const invalid = Schema.decodeUnknownResult(crewInputSchema)({
    op: "reset",
    crew: "worker",
    expected: {
      head: "a".repeat(40),
      fingerprint: "b".repeat(64),
      taskID: null,
    },
    acknowledgeDiscard: false,
  });

  if (Result.isSuccess(invalid)) {
    throw new Error("False acknowledgement accepted");
  }

  expect(invalid.failure.message).toContain('["acknowledgeDiscard"]');
});

test("crew defaults and optional protection preserve input distinctions", () => {
  const decode = Schema.decodeUnknownSync(crewInputSchema);
  expect(decode({ op: "dispatch", crew: "worker", text: " raw " })).toEqual({
    op: "dispatch",
    crew: "worker",
    text: " raw ",
    queue: false,
  });
  expect(decode({ op: "wait", taskID: "task_fixture" })).toEqual({
    op: "wait",
    taskID: "task_fixture",
    afterNoticeID: 0,
  });
  expect(decode({ op: "workspace", crew: "worker" })).toEqual({
    op: "workspace",
    crew: "worker",
    patch: false,
  });
  const absent = Schema.decodeUnknownSync(crewOptionsSchema)(options);
  expect(Object.hasOwn(absent, "exclusiveWorkerInput")).toBe(false);
  expect(
    Schema.decodeUnknownSync(crewOptionsSchema)({
      ...options,
      exclusiveWorkerInput: false,
    }).exclusiveWorkerInput,
  ).toBe(false);

  const explicit = Schema.decodeUnknownSync(crewOptionsSchema)({
    ...options,
    exclusiveWorkerInput: undefined,
  });

  expect(Object.hasOwn(explicit, "exclusiveWorkerInput")).toBe(true);

  const abandoned = decode({
    op: "abandon",
    taskID: "task_fixture",
    expected: {
      status: "uncertain",
      workerSessionID: "session",
      originCaptainID: "captain",
      inputID: "input",
    },
    reason: " inspect ",
    key: "fixture",
    acknowledgeUnconfirmedStop: true,
  });

  expect(abandoned).toMatchObject({
    reason: "inspect",
    expected: { controlID: null },
  });

  for (const idleAt of [1, Number.MAX_SAFE_INTEGER]) {
    expect(
      decode({ ...resume, expected: { ...resume.expected, idleAt } }),
    ).toMatchObject({ expected: { idleAt } });
  }

  for (const idleAt of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
    "1",
  ]) {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(crewInputSchema)({
          ...resume,
          expected: { ...resume.expected, idleAt },
        }),
      ),
    ).toBe(true);
  }
});

test("project raw-key rejection precedes record stripping and path rules stay distinct", () => {
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(crewOptionsSchema)({
        ...options,
        projectDirectory: "/project/../project",
      }),
    ),
  ).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(projectsSchema)({
        other: {
          projectDirectory: "/project/../project",
          worktrees: { worker: "/crew/worker" },
        },
      }),
    ),
  ).toBe(true);

  for (const key of ["__proto__", "constructor", "prototype", "default"]) {
    const raw = JSON.parse(
      `{"${key}":{"projectDirectory":"/other","worktrees":{"worker":"/other/worker"}}}`,
    );

    expect(
      Result.isFailure(Schema.decodeUnknownResult(projectsSchema)(raw)),
    ).toBe(true);
  }

  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(projectsSchema)(
        Object.create({ foreign: true }),
      ),
    ),
  ).toBe(true);
  expect(Schema.decodeUnknownSync(projectsSchema)(Object.create(null))).toEqual(
    {},
  );
});

test("OpenCode envelope is strict and raw; Pi keeps union/default requirements and coercion", async () => {
  const standard = crewOpenCodeInput()["~standard"];
  expect(
    await standard.validate({ op: "dispatch", crew: "worker", text: " raw " }),
  ).toEqual({ value: { op: "dispatch", crew: "worker", text: " raw " } });
  const json = standard.jsonSchema.input({ target: "draft-2020-12" });
  expect(json).toMatchObject({
    type: "object",
    required: ["op"],
    additionalProperties: false,
  });

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    expect(json).not.toHaveProperty(key);
  }

  expect(
    await standard.validate({
      ...resume,
      expected: { ...resume.expected, status: "uncertain" },
    }),
  ).toHaveProperty("issues");

  const extension = piCrewExtension(
    { authorize() {}, async run() {} },
    async () => ({}),
  );

  const tool = extension.tools?.find((tool) => tool.name === "stargate_crew");

  if (!tool) {
    throw new Error("Missing native crew tool");
  }

  expect(tool.parameters).toHaveProperty("oneOf");

  const parse = (
    input: Parameters<typeof validateToolArguments>[1]["arguments"],
  ): unknown =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "fixture",
      name: "stargate_crew",
      arguments: input,
    });

  expect(() =>
    parse({ op: "dispatch", crew: "worker", text: "raw" }),
  ).toThrow();
  expect(
    parse({ op: "dispatch", crew: "worker", text: "raw", queue: "false" }),
  ).toEqual({ op: "dispatch", crew: "worker", text: "raw", queue: false });
  expect(
    parse({ op: "wait", taskID: "task_fixture", afterNoticeID: "1" }),
  ).toEqual({ op: "wait", taskID: "task_fixture", afterNoticeID: 1 });
});

test("portable recovery RPC stays nested-strict and excludes resume", async () => {
  const validate = CrewRecovery.methods.run.input["~standard"].validate;

  const input = {
    sessionID: "captain",
    request: { op: "inspect" as const, crew: "worker" },
  };

  expect(await validate(input)).toEqual({ value: input });

  for (const request of [
    resume,
    { ...input.request, extra: true },
    {
      op: "inspect",
      crew: "worker",
      requestStatus: { key: "fixture", extra: true },
    },
  ]) {
    expect(await validate({ sessionID: "captain", request })).toHaveProperty(
      "issues",
    );
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(recoveryRequestSchema)({
          sessionID: "captain",
          request,
        }),
      ),
    ).toBe(true);
  }
});

test("recovery acknowledgements retain field paths in native and Standard input", async () => {
  const operations = [
    [
      {
        op: "reset",
        crew: "worker",
        expected: {
          head: "a".repeat(40),
          fingerprint: "b".repeat(64),
          taskID: null,
        },
      },
      "acknowledgeDiscard",
    ],
    [
      {
        op: "abandon",
        taskID: "task_fixture",
        expected: {
          status: "uncertain",
          workerSessionID: "session",
          originCaptainID: "captain",
          inputID: "input",
        },
        reason: "inspected",
        key: "fixture",
      },
      "acknowledgeUnconfirmedStop",
    ],
  ] as const;

  const codec = CrewRecovery.methods.run.input;
  const decode = Schema.decodeUnknownResult(codec);

  for (const [request, field] of operations) {
    expect(
      await codec["~standard"].validate({
        sessionID: "captain",
        request: { ...request, [field]: true },
      }),
    ).toHaveProperty("value");

    for (const acknowledgement of [
      {},
      { [field]: undefined },
      { [field]: false },
    ]) {
      const input = {
        sessionID: "captain",
        request: { ...request, ...acknowledgement },
      };

      const parsed = decode(input);

      if (Result.isSuccess(parsed)) {
        throw new Error("Invalid recovery acknowledgement accepted");
      }

      const expected = expect.arrayContaining([
        expect.objectContaining({ path: ["request", field] }),
      ]);

      expect(settingsIssues(parsed.failure.issue).issues).toEqual(expected);
      expect(await codec["~standard"].validate(input)).toMatchObject({
        issues: expected,
      });
    }
  }
});

test("automatic evidence retains MissingTaskResult identity, UTF16 clipping and raw resume proof", async () => {
  const task: CrewTask = {
    id: "task_fixture",
    crewID: "worker",
    workerSessionID: "session",
    originCaptainID: "captain",
    originInputID: null,
    inputID: "input",
    status: "uncertain",
    result: null,
    released: 0,
    notifying: 0,
  };

  const input: ResultMessage = {
    id: "input",
    type: "user",
    time: { created: 1 },
    text:
      "Stargate task envelope: " +
      JSON.stringify({
        taskID: task.id,
        crewID: task.crewID,
        originCaptainID: task.originCaptainID,
        inputID: task.inputID,
      }),
    metadata: {
      [crewMessageMetadataKey]: {
        taskID: task.id,
        originCaptainID: task.originCaptainID,
      },
    },
  };

  let data: ResultMessage[] = [input];

  const api: ResultAPI = {
    message: {
      async list() {
        return { data, cursor: {} };
      },
    },
  };

  const signal = new AbortController().signal;
  await expect(readTaskResult(api, task, signal)).rejects.toBeInstanceOf(
    MissingTaskResult,
  );

  const final: ResultMessage = {
    id: "final",
    type: "assistant",
    agent: "worker",
    finish: "stop",
    time: { created: 3, completed: 4 },
    content: [{ type: "text", text: " a" + "😀".repeat(32_000) + " " }],
  };

  data = [final, input];
  const text = await readTaskResult(api, task, signal);
  expect(text.length).toBe(64_000);
  expect(text.charCodeAt(63_999)).toBe(0xd8_3d);
  data = [
    final,
    {
      id: "wrong-resume",
      type: "synthetic",
      time: { created: 2 },
      metadata: {
        [crewMessageMetadataKey]: {
          taskID: task.id,
          sourceTaskID: task.id,
          originCaptainID: task.originCaptainID,
          resumeIdleAt: "invalid",
        },
      },
    },
    input,
  ];
  await expect(readTaskResult(api, task, signal)).rejects.toThrow(
    "A later input follows this task",
  );
});
