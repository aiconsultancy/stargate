import { expect, spyOn, test } from "bun:test";
import { setImmediate as drain } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import { OpenCodeCrewStatus } from "../src/backends/opencode/crew-status";

type Lane = "ordinary" | "unredacted";

const deadline = () => new DOMException("Fixture deadline", "TimeoutError");

function heldRead() {
  return {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
}

/** A plugin with per-ask holds that ignore abort, and per-view failures. */
function laneFixture() {
  const asked: Lane[] = [];
  const active = { ordinary: 0, unredacted: 0 };

  const holds: Record<Lane, ReturnType<typeof heldRead>[]> = {
    ordinary: [],
    unredacted: [],
  };

  const plugin = { fail: new Set<Lane>(), missing: false };

  const output = {
    status: { members: [], total: 0, truncated: false },
    metadata: {
      projectDirectory: "/fixture",
      contexts: [
        {
          member: "pilot",
          project: null,
          directory: "/fixture/pilot",
          role: "Navigator",
          model: "provider/model",
        },
      ],
    },
  };

  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).text();

      const lane: Lane = body.includes('"taskText"')
        ? "unredacted"
        : "ordinary";

      asked.push(lane);
      active[lane]++;

      try {
        const hold = holds[lane].shift();

        if (hold) {
          hold.entered.resolve();
          await hold.release.promise;
        }

        if (plugin.missing) {
          return Response.json(
            {
              _tag: "RpcError",
              type: "rpc.method_not_found",
              message: "Fixture",
            },
            { status: 404 },
          );
        }

        return Response.json({
          output: plugin.fail.has(lane)
            ? { malformed: true }
            : { ...output, ...(lane === "unredacted" && { taskText: lane }) },
        });
      } finally {
        active[lane]--;
      }
    },
    { preconnect: fetch.preconnect },
  );

  const crew = new OpenCodeCrewStatus(
    OpenCode.make({ baseUrl: "http://127.0.0.1:1", fetch: transport }),
    () => "/fixture",
  );

  const ordinary = { kind: "answer" as const, answer: output };

  const unredacted = {
    kind: "answer" as const,
    answer: { ...output, taskText: "unredacted" as const },
  };

  const hold = (lane: Lane) => {
    const read = heldRead();
    holds[lane].push(read);

    return read;
  };

  return { asked, active, hold, plugin, crew, ordinary, unredacted };
}

const inputs = {
  ordinary: {},
  unredacted: { taskText: "unredacted" },
} as const;

test("an ordinary read behind a pending task-text probe asks for and gets its own answer", async () => {
  const f = laneFixture();
  const signal = new AbortController().signal;
  const hold = f.hold("unredacted");

  try {
    const taskText = f.crew.fleetCrewStatus(inputs.unredacted, signal);
    await hold.entered.promise;

    // Its own fleet status answer, with role and model, not a fallback.
    expect(await f.crew.fleetCrewStatus(inputs.ordinary, signal)).toEqual(
      f.ordinary,
    );
    expect(f.asked).toEqual(["unredacted", "ordinary"]);
    hold.release.resolve();
    expect(await taskText).toEqual(f.unredacted);
  } finally {
    hold.release.resolve();
  }
});

test("a task-text read behind a draining ordinary probe asks for and gets its own answer", async () => {
  const f = laneFixture();
  const signal = new AbortController().signal;
  const probeDeadline = new AbortController();
  const hold = f.hold("ordinary");

  const timeout = spyOn(AbortSignal, "timeout").mockReturnValueOnce(
    probeDeadline.signal,
  );

  try {
    const ordinary = f.crew.fleetCrewStatus(inputs.ordinary, signal);
    await hold.entered.promise;
    timeout.mockRestore();
    // Its deadline passes; the plugin ignores the abort and keeps the read.
    probeDeadline.abort(deadline());
    expect(await ordinary).toEqual({ kind: "unavailable" });

    expect(await f.crew.fleetCrewStatus(inputs.unredacted, signal)).toEqual(
      f.unredacted,
    );
    expect(f.asked).toEqual(["ordinary", "unredacted"]);
  } finally {
    timeout.mockRestore();
    hold.release.resolve();
  }
}, 2000);

test("each lane can retry once while its abandoned read still drains", async () => {
  const f = laneFixture();
  const caller = new AbortController();
  const nextTask = new AbortController();

  const reads = [
    [f.hold("ordinary"), f.hold("unredacted")],
    [f.hold("ordinary"), f.hold("unredacted")],
  ];

  const clock = spyOn(performance, "now").mockReturnValue(0);
  const timeout = spyOn(AbortSignal, "timeout");

  try {
    for (const [index, pair] of reads.entries()) {
      // Step over the 19.2 s abandon threshold without settling the transport.
      clock.mockReturnValue(index * 20_000);
      const ordinaryDeadline = new AbortController();
      const taskDeadline = new AbortController();
      timeout.mockReturnValueOnce(ordinaryDeadline.signal);

      const ordinary = f.crew.fleetCrewStatus(inputs.ordinary, caller.signal);

      const task = f.crew
        .fleetCrewStatus(inputs.unredacted, taskDeadline.signal)
        .catch((error: unknown) => error);

      await Promise.all(pair.map((read) => read.entered.promise));
      expect(f.active).toEqual({ ordinary: index + 1, unredacted: index + 1 });
      ordinaryDeadline.abort(deadline());
      taskDeadline.abort(deadline());
      expect(await ordinary).toEqual({ kind: "unavailable" });
      expect(await task).toBe(taskDeadline.signal.reason);
    }

    // The retries have also timed out, but neither lane can abandon again.
    clock.mockReturnValue(40_000);

    const next = f.crew
      .fleetCrewStatus(inputs.unredacted, nextTask.signal)
      .catch((error: unknown) => error);

    const ordinary = f.crew.fleetCrewStatus(inputs.ordinary, caller.signal);
    await drain();
    expect(f.asked.toSorted()).toEqual([
      "ordinary",
      "ordinary",
      "unredacted",
      "unredacted",
    ]);
    expect(f.active).toEqual({ ordinary: 2, unredacted: 2 });
    nextTask.abort(deadline());
    expect(await ordinary).toEqual({ kind: "unavailable" });
    expect(await next).toBe(nextTask.signal.reason);

    for (const read of reads.flat()) {
      read.release.resolve();
    }

    await drain();
    expect(f.active).toEqual({ ordinary: 0, unredacted: 0 });
    expect(
      await Promise.all([
        f.crew.fleetCrewStatus(inputs.ordinary, caller.signal),
        f.crew.fleetCrewStatus(inputs.unredacted, caller.signal),
      ]),
    ).toEqual([f.ordinary, f.unredacted]);
    expect(f.asked.slice(4).toSorted()).toEqual(["ordinary", "unredacted"]);
  } finally {
    for (const read of reads.flat()) {
      read.release.resolve();
    }

    nextTask.abort();
    caller.abort();
    timeout.mockRestore();
    clock.mockRestore();
  }
});

test.each([
  ["ordinary", "unredacted"],
  ["unredacted", "ordinary"],
] as const)(
  "three %s failures back off only that lane",
  async (failing, other) => {
    const f = laneFixture();
    const signal = new AbortController().signal;
    f.plugin.fail.add(failing);

    for (let i = 0; i < 3; i++) {
      expect(await f.crew.fleetCrewStatus(inputs[failing], signal)).toEqual({
        kind: "unavailable",
      });
    }

    f.plugin.fail.clear();
    f.asked.length = 0;
    expect(await f.crew.fleetCrewStatus(inputs[failing], signal)).toEqual({
      kind: "unavailable",
    });
    expect(await f.crew.fleetCrewStatus(inputs[other], signal)).toEqual(
      f[other],
    );
    expect(f.asked).toEqual([other]);
  },
);

test.each([
  ["ordinary", "unredacted"],
  ["unredacted", "ordinary"],
] as const)(
  "a missing method on an %s read backs off both lanes",
  async (first, other) => {
    const f = laneFixture();
    const signal = new AbortController().signal;
    f.plugin.missing = true;

    expect(await f.crew.fleetCrewStatus(inputs[first], signal)).toEqual({
      kind: "unsupported",
    });
    f.plugin.missing = false;
    expect(await f.crew.fleetCrewStatus(inputs[other], signal)).toEqual({
      kind: "unsupported",
    });
    expect(f.asked).toEqual([first]);
  },
);
