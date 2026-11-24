import { expect, test } from "bun:test";
import { Schema } from "effect";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema } from "../src/config";

test("activity RPC pins the captain, capture and configured OpenCode location", async () => {
  const requests: { path: string; location: string | null; body: unknown }[] =
    [];

  let wrongCapture = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        location: url.searchParams.get("location[directory]"),
        body: await request.json(),
      });

      const output = url.pathname.endsWith("/cancel")
        ? true
        : {
            id: wrongCapture ? "foreign-capture" : "capture-one",
            revision: 1,
            status: "collecting",
            reporter: "Twiki",
            summary: "",
            entries: [],
            truncated: false,
          };

      return Response.json({ output });
    },
  });

  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/captain",
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid backend fixture");
    }

    const backend = new OpenCodeBackend(config);
    const signal = new AbortController().signal;

    const watch = await backend.startActivity(
      "ses_captain",
      "slack-job-42",
      "twiki",
      signal,
    );

    await watch.read(signal);
    await watch.finish(signal);
    await watch.cancel(signal);
    expect(requests.map(({ path }) => path)).toEqual(
      ["start", "read", "finish", "cancel"].map(
        (method) => `/api/rpc/stargate.crew.reporting/${method}`,
      ),
    );
    expect(requests.every(({ location }) => location === "/captain")).toBe(
      true,
    );
    expect(requests[0]?.body).toEqual({
      input: {
        sessionID: "ses_captain",
        requestID: "slack-job-42",
        reporter: "twiki",
      },
    });

    for (const request of requests.slice(1)) {
      expect(request.body).toEqual({
        input: { sessionID: "ses_captain", id: "capture-one" },
      });
    }

    wrongCapture = true;
    await expect(watch.read(signal)).rejects.toThrow("capture changed");
  } finally {
    await server.stop(true);
  }
});

test("crew status uses authenticated location RPC only, with no captain session or model prompt", async () => {
  const requests: {
    path: string;
    location: string | null;
    auth: string | null;
    body: unknown;
  }[] = [];

  let invalid = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        location: url.searchParams.get("location[directory]"),
        auth: request.headers.get("authorization"),
        body: await request.json(),
      });

      return Response.json({
        output: invalid
          ? { rawSessionID: "private-SDK-data" }
          : { members: [], total: 0, truncated: false },
      });
    },
  });

  process.env["STARGATE_CREW_TEST_AUTH"] = "Bearer fixture-only";

  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/captain",
      headersEnv: { authorization: "STARGATE_CREW_TEST_AUTH" },
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid fixture");
    }

    const backend = new OpenCodeBackend(config);
    const signal = new AbortController().signal;
    expect(await backend.crewStatus({}, signal)).toEqual({
      members: [],
      total: 0,
      truncated: false,
    });
    await backend.crewStatus({ member: "twiki" }, signal);
    expect(requests).toEqual(
      [{}, { member: "twiki" }].map((input) => ({
        path: "/api/rpc/stargate.crew.reporting/status",
        location: "/captain",
        auth: "Bearer fixture-only",
        body: { input },
      })),
    );
    invalid = true;
    await expect(backend.crewStatus({}, signal)).rejects.toThrow(
      "Crew status unavailable",
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(backend.crewStatus({}, aborted.signal)).rejects.toThrow(
      "Crew status unavailable",
    );
    expect(requests).toHaveLength(3);
    expect(
      requests.every(
        ({ path }) => path === "/api/rpc/stargate.crew.reporting/status",
      ),
    ).toBe(true);
  } finally {
    delete process.env["STARGATE_CREW_TEST_AUTH"];
    await server.stop(true);
  }
});
