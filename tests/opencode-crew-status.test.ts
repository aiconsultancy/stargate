import { expect, test } from "bun:test";
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

      expect(await crew.fleetCrewStatus(input, signal)).toBeUndefined();
      replied = requested;
      expect(await crew.fleetCrewStatus(input, signal)).toEqual({
        ...output,
        ...(requested && { taskText: requested }),
      });
      replied = undefined;
      expect(await crew.fleetCrewStatus(input, signal)).toEqual(output);

      if (requested) {
        // Once the retry drops taskText, that RPC must not return raw text.
        old = true;
        replied = requested;
        expect(await crew.fleetCrewStatus(input, signal)).toBeUndefined();
        replied = undefined;
        expect(await crew.fleetCrewStatus(input, signal)).toEqual(output);
      }
    } finally {
      await rpc.stop(true);
    }
  },
);
