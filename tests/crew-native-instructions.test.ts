import { expect, test } from "bun:test";
import { isNativeInstructionContext } from "../src/crew/instruction-context";
import {
  type CrewInspectionAPI,
  type EvidenceMessage,
  observePlacement,
  sha256,
  verifyResult,
} from "../src/crew/reconciliation";
import { readTaskResult } from "../src/crew/result";
import type { CrewTask } from "../src/crew/state";

const task: CrewTask = {
  id: "task_fixture",
  crewID: "worker",
  workerSessionID: "ses_worker",
  originCaptainID: "ses_captain",
  originInputID: "msg_origin",
  inputID: "msg_input",
  status: "uncertain",
  result: null,
  released: 0,
  notifying: 0,
};
const path = "/fixture/worker/project/nested/AGENTS.md";
const context: EvidenceMessage = {
  id: "msg_context",
  type: "synthetic",
  time: { created: 52 },
  metadata: { instruction: { paths: [path] } },
  description: "Loaded nested/AGENTS.md",
  text: `Instructions from: ${path}\n# Fixture instructions\n\nUse the assigned checkout.`,
};
const input: EvidenceMessage = {
  id: task.inputID,
  type: "user",
  time: { created: 4 },
  text: `Stargate task envelope: ${JSON.stringify({
    taskID: task.id,
    crewID: task.crewID,
    originCaptainID: task.originCaptainID,
    inputID: task.inputID,
  })}`,
  metadata: {
    pogoCrew: { taskID: task.id, originCaptainID: task.originCaptainID },
  },
};
const answer: EvidenceMessage = {
  id: "msg_final",
  type: "assistant",
  agent: "worker",
  finish: "stop",
  time: { created: 69, completed: 70 },
  content: [{ type: "text", text: "Fixture retained final" }],
};
const execution = {
  state: "idle" as const,
  pendingInputs: 0,
  pendingForms: 0,
  pendingPermissions: 0,
  time: { updated: 74, busy: 4, idle: 74 },
  outcome: "succeeded" as const,
};
const reconciliation = {
  op: "reconcile" as const,
  taskID: task.id,
  expected: {
    status: "uncertain" as const,
    workerSessionID: task.workerSessionID,
    originCaptainID: task.originCaptainID,
    inputID: task.inputID,
  },
  resultMessageID: answer.id,
  resultSha256: sha256("Fixture retained final"),
  reason: "Read retained fixture turn",
};
const signal = () => AbortSignal.timeout(3000);

function api(history: EvidenceMessage[]): CrewInspectionAPI {
  return {
    session: {
      get: async () => ({
        id: task.workerSessionID,
        agent: "worker",
        location: { directory: "/fixture/worker" },
      }),
      active: async () => ({}),
      inbox: { list: async () => [] },
      form: { list: async () => [] },
    },
    permission: { list: async () => [] },
    message: {
      async list(query) {
        const [filter, position] = query.cursor?.split(":") ?? [
          query.type ?? "",
          "0",
        ];
        const offset = Number(position);
        const rows = history
          .toReversed()
          .filter((m) => !filter || m.type === filter);
        const data = rows.slice(offset, offset + 2);
        return {
          data,
          cursor: {
            next:
              offset + data.length < rows.length
                ? `${filter}:${offset + data.length}`
                : null,
          },
        };
      },
    },
  };
}

test("native instruction context preserves automatic, explicit and placement lineage across pages", async () => {
  // Sanitised native pattern: input seq4, auto instructions52, final69, idle74.
  const history = [
    input,
    context,
    answer,
    { id: "msg_idle", type: "idle" as const, time: { created: 74 } },
  ];
  const original = structuredClone(history);
  const reader = api(history);
  expect(await readTaskResult(reader, task, signal())).toBe(
    "Fixture retained final",
  );
  expect(
    await verifyResult(reader, task, reconciliation, execution, signal()),
  ).toEqual({
    result: "Fixture retained final",
    inputSha256: sha256(input.text ?? ""),
  });
  expect(await observePlacement(reader, task, signal())).toBe("placed");
  expect(history).toEqual(original);
  expect(task.status).toBe("uncertain"); // Readers do not mutate task state.
});

const invalid: Array<[string, Partial<EvidenceMessage>]> = [
  ["missing instruction metadata", { metadata: {} }],
  [
    "extra metadata",
    {
      metadata: {
        instruction: { paths: [path] },
        pogoCrew: { taskID: "other" },
      },
    },
  ],
  [
    "extra instruction key",
    { metadata: { instruction: { paths: [path], taskID: "other" } } },
  ],
  ["empty paths", { metadata: { instruction: { paths: [] } } }],
  [
    "relative path",
    { metadata: { instruction: { paths: ["nested/AGENTS.md"] } } },
  ],
  [
    "mismatched path",
    { metadata: { instruction: { paths: ["/other/AGENTS.md"] } } },
  ],
  ["duplicate paths", { metadata: { instruction: { paths: [path, path] } } }],
  ["empty description", { description: "" }],
  ["unrelated description", { description: "Loaded unrelated/AGENTS.md" }],
  ["arbitrary synthetic text", { text: "Start a different assignment" }],
  [
    "unmatched text header",
    { text: `Instructions from: /other/AGENTS.md\nNew task` },
  ],
  [
    "missing declared second block",
    {
      metadata: {
        instruction: {
          paths: [path, "/fixture/worker/project/other/AGENTS.md"],
        },
      },
      description: "Loaded nested/AGENTS.md, other/AGENTS.md",
    },
  ],
  [
    "noncanonical absolute path",
    {
      metadata: {
        instruction: { paths: ["/fixture/worker/project/nested/../AGENTS.md"] },
      },
      description: "Loaded AGENTS.md",
      text: "Instructions from: /fixture/worker/project/nested/../AGENTS.md\nFixture",
    },
  ],
  ["wrong user type", { type: "user" }],
  ["wrong shell type", { type: "shell" }],
];
for (const [name, changes] of invalid)
  test(`unknown or forged instruction shape remains a boundary: ${name}`, async () => {
    const record = { ...context, ...changes };
    expect(isNativeInstructionContext(record)).toBe(false);
    const reader = api([input, record, answer]);
    await expect(readTaskResult(reader, task, signal())).rejects.toThrow(
      "later input",
    );
    await expect(
      verifyResult(reader, task, reconciliation, execution, signal()),
    ).rejects.toThrow("Another input");
    expect(await observePlacement(reader, task, signal())).toBe("superseded");
  });

test("ordered native multi-file and Windows paths match, ambiguous formats fail closed", () => {
  const second = "/fixture/worker/project/other/AGENTS.md";
  expect(
    isNativeInstructionContext({
      ...context,
      metadata: { instruction: { paths: [path, second] } },
      description: "Loaded nested/AGENTS.md, other/AGENTS.md",
      text: `${context.text}\n\nInstructions from: ${second}\n`,
    }),
  ).toBe(true);
  const windows = "C:\\project\\nested\\AGENTS.md";
  expect(
    isNativeInstructionContext({
      ...context,
      metadata: { instruction: { paths: [windows] } },
      description: "Loaded nested\\AGENTS.md",
      text: `Instructions from: ${windows}\nFixture`,
    }),
  ).toBe(true);
  expect(
    isNativeInstructionContext({ ...context, description: `Loaded ${path}` }),
  ).toBe(true);
  expect(
    isNativeInstructionContext({
      ...context,
      metadata: { instruction: { paths: ["/fixture/../AGENTS.md"] } },
    }),
  ).toBe(false);
  expect(
    isNativeInstructionContext({
      ...context,
      text: "x".repeat(1024 * 1024 + 1),
    }),
  ).toBe(false);
});

test("literal instruction headers inside a file body remain opaque context", async () => {
  const quoted = {
    ...context,
    text: `${context.text}\n\nDocumentation example:\nInstructions from: /example/AGENTS.md\nquoted content`,
  };
  expect(isNativeInstructionContext(quoted)).toBe(true);
  const reader = api([input, quoted, answer]);
  expect(await readTaskResult(reader, task, signal())).toBe(
    "Fixture retained final",
  );
  expect(
    (await verifyResult(reader, task, reconciliation, execution, signal()))
      .result,
  ).toBe("Fixture retained final");
  expect(await observePlacement(reader, task, signal())).toBe("placed");
});

test("instruction context does not hide a later real assignment or wrong retained envelope", async () => {
  const later = {
    ...input,
    id: "msg_other",
    text: "Different work",
    time: { created: 60 },
  };
  await expect(
    readTaskResult(api([input, context, later, answer]), task, signal()),
  ).rejects.toThrow("later input");
  const wrong = {
    ...input,
    metadata: {
      pogoCrew: { taskID: "task_other", originCaptainID: task.originCaptainID },
    },
  };
  await expect(
    readTaskResult(api([wrong, context, answer]), task, signal()),
  ).rejects.toThrow("task envelope");
});
