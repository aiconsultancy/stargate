import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readInputOrigin } from "../src/crew/execution/origin";
import type { ResultAPI, ResultMessage } from "../src/crew/execution/result";
import { CrewState } from "../src/crew/execution/state";
import { inputBoundary } from "../src/backends/opencode/input-boundary";
import { fixtureRoot } from "./fixture-root";

const message = (
  id: string,
  type: ResultMessage["type"],
  metadata?: Record<string, unknown>,
): ResultMessage => ({
  id,
  type,
  time: { created: 1 },
  ...(metadata ? { metadata } : {}),
});

test("crew input ancestry anchors the exact assistant across descending pages", async () => {
  const requests: (string | undefined)[] = [];

  const api: ResultAPI = {
    message: {
      async list({ cursor, order, limit }, request) {
        expect(request?.signal).toBe(signal);
        expect(limit).toBe(64);
        requests.push(cursor);

        if (!cursor) {
          expect(order).toBe("desc");

          return {
            data: [message("later", "user"), message("tool", "assistant")],
            cursor: { next: "older" },
          };
        }

        expect(order).toBeUndefined();

        return { data: [message("original", "user")], cursor: {} };
      },
    },
  };

  const signal = new AbortController().signal;
  expect(await readInputOrigin(api, "captain", "tool", signal)).toBe(
    "original",
  );
  expect(requests).toEqual([undefined, "older"]);
  expect(await readInputOrigin(api, "captain", "absent", signal)).toBeNull();
  expect(await readInputOrigin(api, "captain", "later", signal)).toBeNull();
});

test("message evidence keeps one stable pogoCrew key, not the active session key", () => {
  const metadata = Object.freeze({
    pogoCrew: Object.freeze({
      originCaptainID: "captain",
      originInputID: "original",
    }),
  });

  const retained = message("wake", "synthetic", metadata);
  const before = JSON.stringify(retained);
  expect(inputBoundary(retained, "captain")).toBe("original");
  expect(
    inputBoundary(
      message("wake", "synthetic", { stargateCrew: metadata.pogoCrew }),
      "captain",
    ),
  ).toBe("wake");
  expect(JSON.stringify(retained)).toBe(before);
});

test("crew synthetic boundaries inherit only a proven same-captain origin", async () => {
  const signal = new AbortController().signal;

  for (const [metadata, expected] of [
    [
      {
        pogoCrew: { originCaptainID: "captain", originInputID: "original" },
      },
      "original",
    ],
    [
      {
        pogoCrew: { originCaptainID: "foreign", originInputID: "original" },
      },
      null,
    ],
    [{ pogoCrew: { originCaptainID: "captain" } }, null],
    [{ pogoCrew: null }, null],
  ] as const) {
    const wake = message("wake", "synthetic", metadata);
    expect(inputBoundary(wake, "captain")).toBe(expected ?? "wake");

    const api: ResultAPI = {
      message: {
        async list() {
          return {
            data: [
              message("tool", "assistant"),
              wake,
              message("previous-answer", "assistant"),
              message("other", "user"),
            ],
            cursor: {},
          };
        },
      },
    };

    expect(await readInputOrigin(api, "captain", "tool", signal)).toBe(
      expected,
    );
  }

  expect(inputBoundary(message("shell", "shell"), "captain")).toBe("shell");
  expect(inputBoundary(message("shell-done", "synthetic"), "captain")).toBe(
    "shell-done",
  );
});

test("only recognised native context records retain ownership without an origin", () => {
  expect(
    inputBoundary(
      message("restart", "synthetic", { notice: "restart" }),
      "captain",
    ),
  ).toBeUndefined();
  expect(
    inputBoundary(
      message("unknown", "synthetic", { notice: "other" }),
      "captain",
    ),
  ).toBe("unknown");
  expect(
    inputBoundary(
      {
        ...message("instructions", "synthetic", {
          instruction: { paths: ["/workspace/AGENTS.md"] },
        }),
        description: "Loaded AGENTS.md",
        text: "Instructions from: /workspace/AGENTS.md\nOpaque context",
      },
      "captain",
    ),
  ).toBeUndefined();
});

test("native output-limit continuation stays neutral only with its exact native shape", () => {
  const text =
    "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.";

  const continuation = { ...message("limit", "synthetic"), text };
  expect(inputBoundary(continuation, "captain")).toBeUndefined();
  expect(
    inputBoundary({ ...continuation, metadata: {} }, "captain"),
  ).toBeUndefined();

  for (const invalid of [
    { ...continuation, text: `${text}\n` },
    { ...continuation, description: "Completion" },
    { ...continuation, metadata: { source: "subagent" } },
    { ...continuation, metadata: { source: "shell" } },
    { ...continuation, text: "unknown context" },
  ])
    expect(inputBoundary(invalid, "captain")).toBe("limit");
  expect(inputBoundary({ ...continuation, type: "user" }, "captain")).toBe(
    "limit",
  );
});

test("crew ancestry folds adjacent mixed wakes across pages without restoring ownership", async () => {
  const wake = (id: string, input: string) =>
    message(id, "synthetic", {
      pogoCrew: { originCaptainID: "captain", originInputID: input },
    });

  for (const [older, newer, expected] of [
    [wake("older", "first"), wake("newer", "second"), null],
    [wake("older", "first"), wake("newer", "first"), "first"],
    [message("public", "user"), wake("newer", "first"), null],
  ] as const) {
    const records = [
      message("tool", "assistant"),
      newer,
      message("ordinary", "system"),
      older,
      message("separator", "assistant"),
    ];

    const api: ResultAPI = {
      message: {
        async list({ cursor }) {
          const offset = Number(cursor ?? 0);
          const next = offset + 2;

          return {
            data: records.slice(offset, next),
            cursor: next < records.length ? { next: String(next) } : {},
          };
        },
      },
    };

    expect(
      await readInputOrigin(
        api,
        "captain",
        "tool",
        new AbortController().signal,
      ),
    ).toBe(expected);
  }

  const api: ResultAPI = {
    message: {
      async list() {
        return {
          data: [
            message("tool", "assistant"),
            wake("third", "second"),
            wake("second", "second"),
            wake("first", "first"),
            message("separator", "assistant"),
          ],
          cursor: {},
        };
      },
    },
  };

  expect(
    await readInputOrigin(api, "captain", "tool", new AbortController().signal),
  ).toBeNull();
});

test("crew ancestry allows an assistant separator and never guards a later raw input", async () => {
  for (const type of ["user", "shell"] as const) {
    const api: ResultAPI = {
      message: {
        async list() {
          return {
            data: [
              message("tool", "assistant"),
              message("own", type),
              message("foreign-wake", "synthetic", { pogoCrew: {} }),
            ],
            cursor: {},
          };
        },
      },
    };

    expect(
      await readInputOrigin(
        api,
        "captain",
        "tool",
        new AbortController().signal,
      ),
    ).toBe("own");
  }
});

test("crew ancestry stops on missing boundaries and repeated history cursors", async () => {
  const api: ResultAPI = {
    message: {
      async list() {
        return {
          data: [message("tool", "assistant")],
          cursor: { next: "same" },
        };
      },
    },
  };

  expect(
    await readInputOrigin(api, "captain", "tool", new AbortController().signal),
  ).toBeNull();
  await expect(
    readInputOrigin(api, "captain", "tool", AbortSignal.abort()),
  ).rejects.toThrow();
});

test("crew ancestry bounds unique history pages without walking past the ceiling", async () => {
  let pages = 0;

  const api: ResultAPI = {
    message: {
      async list({ limit }) {
        expect(limit).toBe(64);

        return {
          data: pages
            ? [message(`ordinary-${pages}`, "synthetic")]
            : [
                message("tool", "assistant"),
                message("wake", "synthetic", {
                  pogoCrew: {
                    originCaptainID: "captain",
                    originInputID: "unproven-batch",
                  },
                }),
              ],
          cursor: { next: String(++pages) },
        };
      },
    },
  };

  expect(
    await readInputOrigin(api, "captain", "tool", new AbortController().signal),
  ).toBeNull();
  expect(pages).toBe(8);
});

test("crew queued origin survives restart and promotion without changing identity", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-origin-"));
  let state = await CrewState.open(directory, "origin", "identity");

  try {
    const peer = state.reservePeer("worker");
    const active = state.reserveTask(peer, "captain", "first", "input-first");

    if (!active) throw new Error("Missing task");

    const queued = state.enqueue(
      peer,
      "captain",
      "second",
      undefined,
      "input-second",
    );

    expect(state.queuedTasks("worker")[0]?.originInputID).toBe("input-second");
    state.complete(active.id, peer.sessionID, "Retained result");
    state.notice(active.id, "Retained notice");
    state.close();
    state = await CrewState.open(directory, "origin", "identity");
    expect(state.task(active.id)).toMatchObject({
      originInputID: "input-first",
      result: "Retained result",
    });
    const promoted = state.promote(queued.id, active.id);
    expect(promoted?.task).toEqual({ ...queued, status: "dispatching" });
    expect(promoted?.text).toBe("second");
    expect(state.notices(active.id, 0).map(({ text }) => text)).toEqual([
      "Retained notice",
    ]);
    expect(state.queuedTasks("worker")).toEqual([]);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("crew origin migration leaves original task and pending rows untagged", async () => {
  const directory = await mkdtemp(
    join(fixtureRoot(), "stargate-origin-migrate-"),
  );

  let state = await CrewState.open(directory, "origin", "identity");

  try {
    const peer = state.reservePeer("worker");
    const active = state.reserveTask(peer, "captain", "first");

    if (!active) throw new Error("Missing task");
    const queued = state.enqueue(peer, "captain", "second");
    state.complete(active.id, peer.sessionID, "Retained result");
    state.notice(active.id, "Retained notice");
    const path = state.path;
    state.close();
    const legacy = new Database(path);

    try {
      legacy.exec(
        "ALTER TABLE tasks DROP COLUMN originInputID; ALTER TABLE pending_tasks DROP COLUMN originInputID;",
      );
    } finally {
      legacy.close();
    }

    state = await CrewState.open(directory, "origin", "identity");
    expect(state.task(active.id)).toEqual({
      ...active,
      originInputID: null,
      status: "completed",
      result: "Retained result",
    });
    expect(state.task(queued.id)).toEqual({ ...queued, originInputID: null });
    expect(state.promote(queued.id, active.id)?.task).toEqual({
      ...queued,
      originInputID: null,
      status: "dispatching",
    });
    expect(state.notices(active.id, 0).map(({ text }) => text)).toEqual([
      "Retained notice",
    ]);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
