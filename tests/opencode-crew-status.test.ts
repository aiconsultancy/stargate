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
