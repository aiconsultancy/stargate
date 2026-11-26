import { expect, spyOn, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { OpenCodeCrewStatus } from "../src/backends/opencode/crew-status";
import type { FleetCrewStatusInput } from "../src/coordination/crew/reporting/fleet-status";

type View = FleetCrewStatusInput["taskText"];

test.each([
  ["ordinary", "unredacted"],
  ["unredacted", "full"],
  ["full", "unredacted"],
] as const)(
  "Fleet RPC rejects a %s request answered with %s, but accepts ordinary fallback",
  async (mode, wrong) => {
    const requested = mode === "ordinary" ? undefined : mode;
    let replied: View = wrong;
    let old = false;

    const output = {
      status: { members: [], total: 0, truncated: false },
      metadata: { projectDirectory: "/fixture", contexts: [] },
    };

    const rpc = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const asksForTaskText = (await request.text()).includes('"taskText"');

        if (old && asksForTaskText) {
          return Response.json(
            {
              _tag: "RpcError",
              type: "rpc.invalid_input",
              message: "Fixture does not support taskText",
            },
            { status: 400 },
          );
        }

        return Response.json({
          output: { ...output, ...(replied && { taskText: replied }) },
        });
      },
    });

    try {
      const crew = new OpenCodeCrewStatus(
        OpenCode.make({ baseUrl: rpc.url.href }),
        () => "/fixture",
      );

      const signal = new AbortController().signal;

      const input = {
        member: "pilot",
        ...(requested && { taskText: requested }),
      };

      expect(await crew.fleetCrewStatus(input, signal)).toEqual({
        kind: "unavailable",
      });
      replied = requested;
      expect(await crew.fleetCrewStatus(input, signal)).toEqual({
        kind: "answer",
        answer: { ...output, ...(requested && { taskText: requested }) },
      });
      replied = undefined;
      expect(await crew.fleetCrewStatus(input, signal)).toEqual(
        requested
          ? { kind: "unavailable" }
          : { kind: "answer", answer: output },
      );

      if (requested) {
        // Once the retry drops taskText, that RPC must not return raw text.
        old = true;
        replied = requested;
        expect(await crew.fleetCrewStatus(input, signal)).toEqual({
          kind: "unavailable",
        });
        replied = undefined;
        expect(await crew.fleetCrewStatus(input, signal)).toEqual({
          kind: "unsupported",
          answer: output,
        });
      }
    } finally {
      await rpc.stop(true);
    }
  },
);

test.each(["busy", "draining"] as const)(
  "task text waits behind a %s probe with a different filter",
  async (state) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const status = { members: [], total: 0, truncated: false };
    const metadata = { projectDirectory: "/fixture", contexts: [] };
    const deadline = new AbortController();
    let called = 0;

    const fetchProbe = Object.assign(
      async () => {
        if (++called === 1) {
          entered.resolve();
          await release.promise;

          return Response.json({ output: { status, metadata } });
        }

        return Response.json({
          output: { status, metadata, taskText: "full" },
        });
      },
      { preconnect: fetch.preconnect },
    );

    const reader = new OpenCodeCrewStatus(
      OpenCode.make({ baseUrl: "http://127.0.0.1:1", fetch: fetchProbe }),
      () => "/fixture",
    );

    const timeout = spyOn(AbortSignal, "timeout").mockReturnValueOnce(
      deadline.signal,
    );

    const caller = new AbortController();
    const ordinary = reader.fleetCrewStatus({}, caller.signal);

    try {
      await entered.promise;
      timeout.mockRestore();

      if (state === "draining") {
        deadline.abort(new DOMException("Fixture deadline", "TimeoutError"));
        await ordinary;
      }

      const full = reader.fleetCrewStatus(
        { member: "pilot", taskText: "full" },
        caller.signal,
      );

      const observed = await Promise.race([
        full,
        Bun.sleep(5).then(() => "waiting"),
      ]);

      expect(observed).toBe("waiting");
      expect(called).toBe(1);
      release.resolve();
      await ordinary;
      expect(await full).toEqual({
        kind: "answer",
        answer: { status, metadata, taskText: "full" },
      });
      expect(called).toBe(2);
    } finally {
      timeout.mockRestore();
      release.resolve();
      caller.abort();
      await ordinary.catch(() => {});
    }
  },
);

/**
 * A crew plugin that checks input as the real one does: an invalid member
 * fails either ask, and an old plugin also refuses `taskText` itself.
 * `hold` keeps that ask open until the client drops it.
 */
function pluginFixture() {
  const asked: string[] = [];

  const plugin: {
    old: boolean;
    reject: boolean;
    ordinaryMissing: boolean;
    hold?: "full" | "ordinary" | undefined;
  } = { old: false, reject: false, ordinaryMissing: false };

  const counts = { held: 0, dropped: 0 };
  const watchers = new Set<() => void>();

  const notify = () => {
    for (const watch of watchers) {
      watch();
    }
  };

  /** Resolves once `count` reaches `n`. */
  const reach = (count: keyof typeof counts, n: number) =>
    new Promise<void>((resolve) => {
      const watch = () => {
        if (counts[count] >= n) {
          watchers.delete(watch);
          resolve();
        }
      };

      watchers.add(watch);
      watch();
    });

  const output = {
    status: { members: [], total: 0, truncated: false },
    metadata: { projectDirectory: "/fixture", contexts: [] },
  };

  const invalid = () =>
    Response.json(
      { _tag: "RpcError", type: "rpc.invalid_input", message: "Fixture" },
      { status: 400 },
    );

  const rpc = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const member = /"member":"([^"]*)"/.exec(body)?.[1];
      const mode = /"taskText":"(\w+)"/.exec(body)?.[1];
      asked.push(`${member}:${mode ?? "ordinary"}`);

      if (plugin.hold === (mode ? "full" : "ordinary")) {
        const dropped = Promise.withResolvers<void>();
        request.signal.addEventListener("abort", () => dropped.resolve());
        counts.held++;
        notify();
        await dropped.promise;
        counts.dropped++;
        notify();
      }

      if (
        plugin.reject ||
        (member !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member)) ||
        (plugin.old && mode)
      ) {
        return invalid();
      }

      if (plugin.ordinaryMissing && !mode) {
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
        output: { ...output, ...(mode && { taskText: mode }) },
      });
    },
  });

  const crew = new OpenCodeCrewStatus(
    OpenCode.make({ baseUrl: rpc.url.href }),
    () => "/fixture",
  );

  return {
    asked,
    plugin,
    output,
    crew,
    counts,
    reach,
    stop: () => rpc.stop(true),
  };
}

test("a member the plugin rejects is never sent, nor marks the field unsupported", async () => {
  const f = pluginFixture();
  const signal = new AbortController().signal;
  const full = { member: "pilot", taskText: "full" } as const;

  try {
    // Phobos's fixture: the member, not the field, is what the plugin rejects.
    for (const member of ["Pilot", "pilot.x", "-pilot", "p".repeat(65)]) {
      expect(
        await f.crew.fleetCrewStatus({ member, taskText: "full" }, signal),
      ).toEqual({ kind: "unavailable" });
    }

    expect(f.asked).toEqual([]);
    expect(await f.crew.fleetCrewStatus(full, signal)).toEqual({
      kind: "answer",
      answer: { ...f.output, taskText: "full" },
    });
  } finally {
    await f.stop();
  }
});

test("a failed re-ask is unavailable and caches nothing", async () => {
  const f = pluginFixture();
  const signal = new AbortController().signal;
  const full = { member: "pilot", taskText: "full" } as const;

  try {
    // Both asks fail, so the input was bad, not the field.
    f.plugin.reject = true;
    expect(await f.crew.fleetCrewStatus(full, signal)).toEqual({
      kind: "unavailable",
    });
    expect(f.asked).toEqual(["pilot:full", "pilot:ordinary"]);
    f.plugin.reject = false;
    expect(await f.crew.fleetCrewStatus(full, signal)).toEqual({
      kind: "answer",
      answer: { ...f.output, taskText: "full" },
    });

    // Each failed pair is one failure: three in a row pause probes.
    f.plugin.reject = true;

    for (let i = 0; i < 3; i++) {
      expect(await f.crew.fleetCrewStatus(full, signal)).toEqual({
        kind: "unavailable",
      });
    }

    f.asked.length = 0;
    f.plugin.reject = false;
    expect(await f.crew.fleetCrewStatus(full, signal)).toEqual({
      kind: "unavailable",
    });
    expect(f.asked).toEqual([]);
  } finally {
    await f.stop();
  }
});

test("a genuine old plugin still falls back, and its fallback is cached", async () => {
  const f = pluginFixture();
  const signal = new AbortController().signal;
  const full = { member: "pilot", taskText: "full" } as const;
  f.plugin.old = true;

  try {
    for (const asked of [
      ["pilot:full", "pilot:ordinary"],
      ["pilot:ordinary"],
    ]) {
      f.asked.length = 0;
      expect(await f.crew.fleetCrewStatus(full, signal)).toEqual({
        kind: "unsupported",
        answer: f.output,
      });
      expect(f.asked).toEqual(asked);
    }
  } finally {
    await f.stop();
  }
});

test("a missing method on re-ask does not block the next full probe", async () => {
  const f = pluginFixture();
  const signal = new AbortController().signal;
  const full = { member: "pilot", taskText: "full" } as const;
  f.plugin.old = true;
  f.plugin.ordinaryMissing = true;

  try {
    const failed = await f.crew.fleetCrewStatus(full, signal);
    f.plugin.old = false;
    f.plugin.ordinaryMissing = false;
    const recovered = await f.crew.fleetCrewStatus(full, signal);

    expect({ failed, recovered, asked: f.asked }).toEqual({
      failed: { kind: "unavailable" },
      recovered: { kind: "answer", answer: { ...f.output, taskText: "full" } },
      asked: ["pilot:full", "pilot:ordinary", "pilot:full"],
    });
  } finally {
    await f.stop();
  }
});

test("three missing-method re-asks reach the plugin before ordinary backoff", async () => {
  const f = pluginFixture();
  const signal = new AbortController().signal;
  const full = { member: "pilot", taskText: "full" } as const;
  f.plugin.old = true;
  f.plugin.ordinaryMissing = true;

  try {
    const failures = [];

    for (let i = 0; i < 3; i++) {
      failures.push(await f.crew.fleetCrewStatus(full, signal));
    }

    f.plugin.old = false;
    f.plugin.ordinaryMissing = false;
    const backedOff = await f.crew.fleetCrewStatus(full, signal);
    const unavailable = { kind: "unavailable" } as const;

    expect({ failures, backedOff, asked: f.asked }).toEqual({
      failures: [unavailable, unavailable, unavailable],
      backedOff: unavailable,
      asked: Array.from({ length: 3 }, () => [
        "pilot:full",
        "pilot:ordinary",
      ]).flat(),
    });
  } finally {
    await f.stop();
  }
});

const deadline = () => new DOMException("Fixture deadline", "TimeoutError");

test("three deadline-ended re-asks pause probes like any failed re-ask", async () => {
  const f = pluginFixture();
  const full = { member: "pilot", taskText: "full" } as const;
  f.plugin.old = true;
  f.plugin.hold = "ordinary";

  try {
    for (let i = 1; i <= 3; i++) {
      const caller = new AbortController();
      const read = f.crew.fleetCrewStatus(full, caller.signal);
      await f.reach("held", i);
      caller.abort(deadline());
      expect(await read.catch((error: unknown) => error)).toBe(
        caller.signal.reason,
      );
      // Abort still reaches the plugin's request.
      await f.reach("dropped", i);
    }

    expect(f.asked).toEqual(
      Array.from({ length: 3 }, () => ["pilot:full", "pilot:ordinary"]).flat(),
    );
    f.asked.length = 0;
    f.plugin.old = false;
    f.plugin.hold = undefined;
    expect(
      await f.crew.fleetCrewStatus(full, new AbortController().signal),
    ).toEqual({ kind: "unavailable" });
    expect(f.asked).toEqual([]);
  } finally {
    await f.stop();
  }
});

test("a caller that disconnects counts no failure, in either phase", async () => {
  const f = pluginFixture();
  const full = { member: "pilot", taskText: "full" } as const;

  try {
    for (const [i, hold] of [
      [1, "full"],
      [2, "ordinary"],
      [3, "ordinary"],
    ] as const) {
      f.plugin.old = hold === "ordinary";
      f.plugin.hold = hold;
      const caller = new AbortController();
      const read = f.crew.fleetCrewStatus(full, caller.signal);
      await f.reach("held", i);
      caller.abort();
      await expect(read).rejects.toThrow();
      await f.reach("dropped", i);
    }

    f.asked.length = 0;
    f.plugin.old = false;
    f.plugin.hold = undefined;
    expect(
      await f.crew.fleetCrewStatus(full, new AbortController().signal),
    ).toEqual({ kind: "answer", answer: { ...f.output, taskText: "full" } });
    expect(f.asked).toEqual(["pilot:full"]);
  } finally {
    await f.stop();
  }
});

test("one deadline with two waiters aborts the probe and counts once", async () => {
  const f = pluginFixture();
  const full = { member: "pilot", taskText: "full" } as const;
  const signal = new AbortController().signal;
  f.plugin.hold = "full";

  try {
    const first = new AbortController();
    const second = new AbortController();

    const reads = [first, second].map((caller) =>
      f.crew.fleetCrewStatus(full, caller.signal).catch((error) => error),
    );

    await f.reach("held", 1);

    // One waiter leaving while another waits neither aborts nor counts.
    first.abort(deadline());
    expect(await reads[0]).toBe(first.signal.reason);
    await Bun.sleep(20);
    expect(f.counts.dropped).toBe(0);

    second.abort(deadline());
    expect(await reads[1]).toBe(second.signal.reason);
    await f.reach("dropped", 1);

    // The deadline is one failure: two more reach the plugin, then a pause.
    f.plugin.hold = undefined;
    f.plugin.reject = true;
    f.asked.length = 0;

    for (let i = 0; i < 2; i++) {
      expect(await f.crew.fleetCrewStatus(full, signal)).toEqual({
        kind: "unavailable",
      });
    }

    f.plugin.reject = false;
    expect(await f.crew.fleetCrewStatus(full, signal)).toEqual({
      kind: "unavailable",
    });
    expect(f.asked).toEqual(
      Array.from({ length: 2 }, () => ["pilot:full", "pilot:ordinary"]).flat(),
    );
  } finally {
    await f.stop();
  }
});

test("a re-ask answered after the deadline caches nothing", async () => {
  const asked: string[] = [];
  const entered = Promise.withResolvers<void>();
  let old = true;

  const output = {
    status: { members: [], total: 0, truncated: false },
    metadata: { projectDirectory: "/fixture", contexts: [] },
  };

  // A transport that drains: it answers the re-ask after the abort.
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const mode = /"taskText":"(\w+)"/.exec(await request.text())?.[1];
      asked.push(mode ?? "ordinary");

      if (old && mode) {
        return Response.json(
          { _tag: "RpcError", type: "rpc.invalid_input", message: "Fixture" },
          { status: 400 },
        );
      }

      if (old) {
        const aborted = Promise.withResolvers<void>();
        request.signal.addEventListener("abort", () => aborted.resolve());
        entered.resolve();
        await aborted.promise;
      }

      return Response.json({
        output: { ...output, ...(mode && { taskText: mode }) },
      });
    },
    { preconnect: fetch.preconnect },
  );

  const crew = new OpenCodeCrewStatus(
    OpenCode.make({ baseUrl: "http://127.0.0.1:1", fetch: transport }),
    () => "/fixture",
  );

  const full = { member: "pilot", taskText: "full" } as const;
  const caller = new AbortController();
  const read = crew.fleetCrewStatus(full, caller.signal);
  await entered.promise;
  caller.abort(deadline());
  expect(await read.catch((error: unknown) => error)).toBe(
    caller.signal.reason,
  );
  old = false;

  expect(
    await crew.fleetCrewStatus(full, new AbortController().signal),
  ).toEqual({ kind: "answer", answer: { ...output, taskText: "full" } });
  expect(asked).toEqual(["full", "ordinary", "full"]);
});
