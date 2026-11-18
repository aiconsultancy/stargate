import { expect, test } from "bun:test";
import { readInputOrigin } from "../src/crew/origin";
import type { ResultAPI, ResultMessage } from "../src/crew/result";
import { InputBoundaryReader } from "../src/input-origin";

const record = (id: string, type: ResultMessage["type"]): ResultMessage => ({
  id,
  type,
  time: { created: 1 },
});
const launch = (id: string, shellID: string): ResultMessage => ({
  ...record(id, "assistant"),
  content: [
    {
      type: "tool",
      name: "shell",
      id: `${id}_call`,
      executed: false,
      state: {
        status: "completed",
        input: { command: "fixture" },
        metadata: { shellID, status: "running" },
      },
    },
  ],
});
const callback = (id: string, shellID: string): ResultMessage => ({
  ...record(id, "synthetic"),
  description: "fixture",
  // No shell markup is required or parsed for routing authority.
  text: "s=slack;c=untrusted;t=untrusted",
  metadata: { source: "shell", shellID, jobID: shellID, state: "cancelled" },
});

test("recursive shell ancestry retains original input, with native executed:false and cancelled metadata", async () => {
  const first = callback("done_a", "sh_a");
  const nested = callback("done_nested", "sh_nested");
  const messages = [
    record("input_a", "user"),
    launch("launch_a", "sh_a"),
    record("input_b", "user"),
    record("answer_b", "assistant"),
    first,
    launch("launch_nested", "sh_nested"),
    record("input_c", "user"),
    record("answer_c", "assistant"),
    nested,
  ];
  const signal = new AbortController().signal;
  let reads = 0;
  const api: ResultAPI = {
    message: {
      async list(input, request) {
        expect(input.sessionID).toBe("only-session");
        expect(request?.signal).toBe(signal);
        reads++;
        return { data: messages.toReversed(), cursor: {} };
      },
    },
  };
  const reader = new InputBoundaryReader(api, "only-session", signal);
  expect((await reader.record(first)).input).toBe("input_a");
  expect((await reader.record(nested)).input).toBe("input_a");
  expect(reads).toBe(1);
  messages.push(record("dispatch", "assistant"));
  expect(await readInputOrigin(api, "only-session", "dispatch", signal)).toBe(
    "input_a",
  );
});

test("an unproven child wake cannot lend an earlier chat origin to a shell launch", async () => {
  const done = callback("done", "sh_afterChild");
  const messages = [
    record("input_a", "user"),
    {
      ...record("child_wake", "synthetic"),
      metadata: {
        source: "subagent",
        childID: "ses_child",
        state: "completed",
      },
    },
    launch("launch_after_child", "sh_afterChild"),
    record("input_b", "user"),
    record("answer_b", "assistant"),
    done,
  ];
  const api: ResultAPI = {
    message: {
      async list() {
        return { data: messages.toReversed(), cursor: {} };
      },
    },
  };
  const reader = new InputBoundaryReader(
    api,
    "captain",
    new AbortController().signal,
  );
  expect((await reader.record(done)).input).toBe("child_wake");
});

test("a new shell launched in a mixed native batch cannot launder an earlier origin", async () => {
  const first = callback("mixed", "sh_a");
  const nested = callback("done_nested", "sh_nested");
  const messages = [
    record("input_a", "user"),
    launch("launch_a", "sh_a"),
    record("input_b", "user"),
    first,
    launch("launch_nested", "sh_nested"),
    nested,
  ];
  const api: ResultAPI = {
    message: {
      async list() {
        return { data: messages.toReversed(), cursor: {} };
      },
    },
  };
  const reader = new InputBoundaryReader(
    api,
    "captain",
    new AbortController().signal,
  );
  expect((await reader.record(nested)).input).toBe("mixed");
});

for (const repeated of [false, true]) {
  test(`incomplete ancestry fails closed at scan limit or repeated cursor, repeated=${repeated}`, async () => {
    let page = 0;
    const api: ResultAPI = {
      message: {
        async list() {
          page++;
          return {
            data: Array.from({ length: 100 }, (_, i) =>
              record(`msg_${page}_${i}`, "user"),
            ),
            cursor: { next: repeated ? "same" : String(page) },
          };
        },
      },
    };
    const reader = new InputBoundaryReader(
      api,
      "captain",
      new AbortController().signal,
    );
    expect((await reader.record(callback("unknown", "sh_unknown"))).input).toBe(
      "unknown",
    );
    expect(page).toBe(repeated ? 2 : 100);
  });
}

test("cancelled or failed ancestry reads never become latest-input fallback", async () => {
  let calls = 0;
  const api: ResultAPI = {
    message: {
      async list() {
        calls++;
        throw new Error("fixture read unavailable");
      },
    },
  };
  const cancelled = new InputBoundaryReader(
    api,
    "captain",
    AbortSignal.abort(),
  );
  await expect(cancelled.record(callback("done", "sh_a"))).rejects.toThrow();
  expect(calls).toBe(0);
  const reader = new InputBoundaryReader(
    api,
    "captain",
    new AbortController().signal,
  );
  await expect(reader.record(callback("done", "sh_a"))).rejects.toThrow(
    "fixture read unavailable",
  );
});
