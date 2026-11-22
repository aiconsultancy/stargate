import { expect, test } from "bun:test";
import {
  type CrewInspectionAPI,
  type EvidenceMessage,
  observePlacement,
  sha256,
  verifyResult,
} from "../src/crew/execution/reconciliation";
import { readTaskResult } from "../src/crew/execution/result";
import { ShellCompletionContext } from "../src/crew/execution/shell-context";
import type { CrewTask } from "../src/crew/execution/state";

const agent = "captain-crew-worker";
const task: CrewTask = {
  id: "task_shell",
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
const input: EvidenceMessage = {
  id: task.inputID,
  type: "user",
  time: { created: 4 },
  text: `Stargate task envelope: ${JSON.stringify({ taskID: task.id, crewID: task.crewID, originCaptainID: task.originCaptainID, inputID: task.inputID })}`,
  metadata: {
    pogoCrew: { taskID: task.id, originCaptainID: task.originCaptainID },
  },
};
const answer: EvidenceMessage = {
  id: "msg_final",
  type: "assistant",
  agent,
  finish: "stop",
  time: { created: 60, completed: 61 },
  content: [{ type: "text", text: "Retained worker final" }],
};
const execution = {
  state: "idle" as const,
  pendingInputs: 0,
  pendingForms: 0,
  pendingPermissions: 0,
  time: { updated: 70, busy: 4, idle: 70 },
  outcome: "succeeded" as const,
};
const reconcile = {
  op: "reconcile" as const,
  taskID: task.id,
  expected: {
    status: "uncertain" as const,
    workerSessionID: task.workerSessionID,
    originCaptainID: task.originCaptainID,
    inputID: task.inputID,
  },
  resultMessageID: answer.id,
  resultSha256: sha256("Retained worker final"),
  reason: "Verify retained fixture",
};
const signal = () => AbortSignal.timeout(3000);
function shell(job: string, command: string, created: number) {
  // Native 2.2.7 retained fields: executed=false, completed state, background metadata.
  const origin: EvidenceMessage = {
    id: `msg_launch${job}`,
    type: "assistant",
    agent,
    finish: "tool-calls",
    time: { created, completed: created + 1 },
    content: [
      {
        type: "tool",
        id: `call_${job}`,
        name: "shell",
        state: {
          status: "completed",
          input: { command },
          content: [{ type: "text", text: "Command moved to background" }],
          metadata: { shellID: job, status: "running", truncated: false },
        },
        executed: false,
      },
    ],
  };
  const callback: EvidenceMessage = {
    id: `msg_notice${job}`,
    type: "synthetic",
    time: { created: created + 5 },
    description: command,
    metadata: {
      source: "shell",
      shellID: job,
      jobID: job,
      state: "completed",
      truncated: false,
      exit: 0,
    },
    text: `<shell id="${job}" state="completed" command="${command}">\nOpaque output\n</shell>`,
  };
  return { origin, callback };
}
function history() {
  const one = shell("sh_first", 'printf "quoted"\nprintf end', 20);
  const two = shell("sh_second", "cargo check --locked", 40);
  return [input, one.origin, one.callback, two.origin, two.callback, answer];
}
function api(
  rows: EvidenceMessage[],
  options: {
    repeated?: boolean;
    wrongSession?: boolean;
    pageSize?: number;
  } = {},
): CrewInspectionAPI {
  return {
    session: {
      get: async () => ({
        id: task.workerSessionID,
        agent,
        location: { directory: "/fixture/work" },
      }),
      active: async () => ({}),
      inbox: { list: async () => [] },
      form: { list: async () => [] },
    },
    permission: { list: async () => [] },
    message: {
      async list(query, request) {
        request?.signal?.throwIfAborted();
        if (options.wrongSession || query.sessionID !== task.workerSessionID)
          throw new Error("Wrong fixture session");
        const [type, start] = query.cursor?.split(":") ?? [
          query.type ?? "",
          "0",
        ];
        const offset = Number(start);
        const filtered = rows
          .toReversed()
          .filter((row) => !type || row.type === type);
        const data = filtered.slice(
          offset,
          offset + Math.min(query.limit ?? 100, options.pageSize ?? 2),
        );
        return {
          data,
          cursor: {
            next: options.repeated
              ? "repeat:0"
              : offset + data.length < filtered.length
                ? `${type}:${offset + data.length}`
                : null,
          },
        };
      },
    },
  };
}

test("two native shell callbacks retain original-task result and placement across pages without mutation", async () => {
  const rows = history();
  const before = structuredClone(rows);
  const reader = api(rows);
  expect(await readTaskResult(reader, task, signal(), agent)).toBe(
    "Retained worker final",
  );
  expect(
    await verifyResult(reader, task, reconcile, execution, signal(), agent),
  ).toEqual({
    result: "Retained worker final",
    inputSha256: sha256(input.text ?? ""),
  });
  expect(await observePlacement(reader, task, signal(), agent)).toBe("placed");
  expect(rows).toEqual(before);
  expect(task.status).toBe("uncertain");
  expect(task.result).toBeNull();
  expect(task.released).toBe(0);
});

test("callback output is opaque, and a fast notification need not wait for launch completion timestamp", async () => {
  const rows = history();
  const origin = rows[1];
  const callback = rows[2];
  if (!origin || !callback) throw new Error("Missing fixture");
  origin.time.completed = 59;
  if (typeof callback.text !== "string")
    throw new Error("Missing callback text");
  callback.text = callback.text.replace(
    "Opaque output",
    '<shell id="sh_fake">\nquoted wrapper\n</shell>',
  );
  expect(await readTaskResult(api(rows), task, signal(), agent)).toBe(
    "Retained worker final",
  );
  expect(await observePlacement(api(rows), task, signal(), agent)).toBe(
    "placed",
  );
});

const invalid: Array<[string, (rows: EvidenceMessage[]) => void]> = [
  [
    "missing originating launch",
    (rows) => {
      rows.splice(1, 1);
    },
  ],
  [
    "foreign native agent",
    (rows) => {
      const value = rows[1];
      if (value) value.agent = "foreign";
    },
  ],
  [
    "origin before original input",
    (rows) => {
      const value = rows.splice(1, 1)[0];
      if (value) rows.unshift(value);
    },
  ],
  [
    "origin after callback",
    (rows) => {
      const value = rows.splice(1, 1)[0];
      if (value) rows.splice(2, 0, value);
    },
  ],
  [
    "duplicate launch witness",
    (rows) => {
      const value = rows[1];
      if (value) rows.splice(2, 0, { ...value, id: "msg_duplicateLaunch" });
    },
  ],
  [
    "duplicate callback",
    (rows) => {
      const value = rows[2];
      if (value) rows.splice(3, 0, { ...value, id: "msg_duplicateNotice" });
    },
  ],
  [
    "foreign job ID",
    (rows) => {
      const value = rows[2];
      if (value) value.metadata = { ...value.metadata, jobID: "sh_foreign" };
    },
  ],
  [
    "user shell without job ID",
    (rows) => {
      const value = rows[2];
      if (value)
        value.metadata = {
          source: "shell",
          shellID: "sh_first",
          state: "completed",
        };
    },
  ],
  [
    "user shell native prefix",
    (rows) => {
      const value = rows[2];
      if (value)
        value.text =
          "The following shell command was executed by the user:\n" +
          value.text;
    },
  ],
  [
    "unknown synthetic",
    (rows) => {
      const value = rows[2];
      if (value) value.text = "Do different work";
    },
  ],
  [
    "extra callback authority metadata",
    (rows) => {
      const value = rows[2];
      if (value) value.metadata = { ...value.metadata, authority: "new" };
    },
  ],
  [
    "wrong originating command",
    (rows) => {
      const value = rows[1]?.content?.[0];
      if (value && typeof value.state === "object" && value.state !== null)
        value.state = { ...value.state, input: { command: "different" } };
    },
  ],
  [
    "unfinished launch tool",
    (rows) => {
      const value = rows[1]?.content?.[0];
      if (value && typeof value.state === "object" && value.state !== null)
        value.state = { ...value.state, status: "running" };
    },
  ],
  [
    "a tool-call ID is not native shell identity",
    (rows) => {
      const value = rows[1]?.content?.[0];
      if (value && typeof value.state === "object" && value.state !== null) {
        value.id = "sh_first";
        value.state = {
          ...value.state,
          metadata: { status: "running", truncated: false },
        };
      }
    },
  ],
  [
    "genuine later user",
    (rows) => {
      rows.splice(3, 0, {
        ...input,
        id: "msg_newInput",
        text: "Different assignment",
        time: { created: 30 },
      });
    },
  ],
  [
    "standalone native shell input",
    (rows) => {
      rows.splice(3, 0, {
        id: "msg_userShell",
        type: "shell",
        time: { created: 30 },
      });
    },
  ],
];
for (const [name, change] of invalid)
  test(`uncorrelated shell or real input stays a boundary: ${name}`, async () => {
    const rows = history();
    change(rows);
    const reader = api(rows);
    await expect(
      readTaskResult(reader, task, signal(), agent),
    ).rejects.toThrow();
    await expect(
      verifyResult(reader, task, reconcile, execution, signal(), agent),
    ).rejects.toThrow();
    expect(await observePlacement(reader, task, signal(), agent)).toBe(
      "superseded",
    );
    expect(task.status).toBe("uncertain");
    expect(task.released).toBe(0);
  });

test("callbacks cannot manufacture a final, validate a foreign task/session, or bypass cancellation and cursor bounds", async () => {
  await expect(
    readTaskResult(api(history().slice(0, -1)), task, signal(), agent),
  ).rejects.toThrow("No completed visible worker answer");
  const failed = history();
  failed[5] = {
    ...answer,
    finish: "error",
    error: { message: "Fixture provider failure" },
  };
  await expect(
    readTaskResult(api(failed), task, signal(), agent),
  ).rejects.toThrow("No completed visible worker answer");
  await expect(
    readTaskResult(
      api(history()),
      { ...task, id: "task_other" },
      signal(),
      agent,
    ),
  ).rejects.toThrow("task envelope");
  await expect(
    readTaskResult(
      api(history(), { wrongSession: true }),
      task,
      signal(),
      agent,
    ),
  ).rejects.toThrow();
  await expect(
    readTaskResult(api(history(), { repeated: true }), task, signal(), agent),
  ).rejects.toThrow("cursor");
  const aborted = AbortSignal.abort();
  await expect(
    readTaskResult(api(history()), task, aborted, agent),
  ).rejects.toThrow();
  expect(await observePlacement(api(history()), task, aborted, agent)).toBe(
    "unknown",
  );
});

test("compaction remains native context for automatic reading and placement, but explicit reconciliation still refuses", async () => {
  const rows = history();
  rows.splice(5, 0, {
    id: "msg_compact",
    type: "compaction",
    time: { created: 55 },
  });
  expect(await readTaskResult(api(rows), task, signal(), agent)).toBe(
    "Retained worker final",
  );
  expect(await observePlacement(api(rows), task, signal(), agent)).toBe(
    "placed",
  );
  await expect(
    verifyResult(api(rows), task, reconcile, execution, signal(), agent),
  ).rejects.toThrow("Compaction");
});

test("native ordering resolves timestamp ties without permitting reversed launch/callback order", () => {
  const { origin, callback } = shell("sh_tie", "echo fixture", 20);
  callback.time.created = 20;
  const context = new ShellCompletionContext(agent);
  context.track(callback);
  context.track(origin);
  expect(context.finish(4)).toBe(true);
  const reversed = new ShellCompletionContext(agent);
  reversed.track(origin);
  reversed.track(callback);
  expect(reversed.finish(4)).toBe(false);
});

test("a callback after an earlier stop still needs a subsequent visible final", async () => {
  const { origin, callback } = shell("sh_late", "echo fixture", 20);
  const earlier = { ...answer, time: { created: 23, completed: 24 } };
  const rows = [input, origin, earlier, callback];
  await expect(
    readTaskResult(api(rows), task, signal(), agent),
  ).rejects.toThrow("No completed visible worker answer");
  await expect(
    verifyResult(api(rows), task, reconcile, execution, signal(), agent),
  ).rejects.toThrow("Final result evidence");
  expect(await observePlacement(api(rows), task, signal(), agent)).toBe(
    "placed",
  );
});

test("retained crew-ID launch and final use the existing protected session alias rule", async () => {
  const rows = history();
  for (const row of rows) if (row.type === "assistant") row.agent = task.crewID;
  expect(await readTaskResult(api(rows), task, signal(), agent)).toBe(
    "Retained worker final",
  );
  expect(
    (await verifyResult(api(rows), task, reconcile, execution, signal(), agent))
      .result,
  ).toBe("Retained worker final");
  expect(await observePlacement(api(rows), task, signal(), agent)).toBe(
    "placed",
  );
});

test("empty native output has both writer newlines, not an overlapping prefix/suffix", async () => {
  const rows = history();
  const callback = rows[2];
  if (!callback?.text) throw new Error("Missing callback");
  callback.text = callback.text.replace("Opaque output", "");
  expect(callback.text.endsWith(">\n\n</shell>")).toBe(true);
  expect(await readTaskResult(api(rows), task, signal(), agent)).toBe(
    "Retained worker final",
  );
  expect(await observePlacement(api(rows), task, signal(), agent)).toBe(
    "placed",
  );
  callback.text = callback.text.replace("\n\n</shell>", "\n</shell>");
  await expect(
    readTaskResult(api(rows), task, signal(), agent),
  ).rejects.toThrow("later input");
  expect(await observePlacement(api(rows), task, signal(), agent)).toBe(
    "superseded",
  );
});

function longHistory(count: number) {
  const rows = history();
  const retained: EvidenceMessage[] = Array.from(
    { length: count },
    (_, index) => ({
      id: `msg_progress${index}`,
      type: "assistant",
      agent,
      finish: "tool-calls",
      time: {
        created: 26 + index / (count + 1),
        completed: 26 + index / (count + 1),
      },
      content: [{ type: "text", text: "Fixture progress" }],
    }),
  );
  // Same native order as the real long turn: input -> first job -> long work -> next job -> final.
  rows.splice(3, 0, ...retained);
  return rows;
}

test("placement and result prove actual-sized long native turns beyond 512 records in authoritative order", async () => {
  const rows = longHistory(1950);
  const reader = api(rows, { pageSize: 100 });
  expect(rows.length).toBeGreaterThan(512);
  expect(await observePlacement(reader, task, signal(), agent)).toBe("placed");
  expect(await readTaskResult(reader, task, signal(), agent)).toBe(
    "Retained worker final",
  );
  // A complete, equally long scan disproves ownership: this is a boundary, not unreadable evidence.
  const origin = rows[1];
  if (!origin) throw new Error("Missing origin");
  origin.agent = "foreign";
  expect(
    await observePlacement(api(rows, { pageSize: 100 }), task, signal(), agent),
  ).toBe("superseded");
});

test("exhausted history bounds stay unknown and the result diagnostic never invents missing history", async () => {
  const reader = api(longHistory(10020), { pageSize: 100 });
  expect(await observePlacement(reader, task, signal(), agent)).toBe("unknown");
  try {
    await readTaskResult(reader, task, signal(), agent);
    throw new Error("Expected scan bound refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("scan bound exceeded");
    expect(String(error)).not.toContain("Restore");
  }
});
