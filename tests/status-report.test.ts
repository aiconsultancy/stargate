import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/app/cli";
import {
  botStatusReport,
  statusReport,
  summarizeLog,
} from "../src/app/status-report";
import { bot } from "./fixtures";

const now = Date.parse("2026-11-16T12:00:00Z");

const line = (time: number, extra: object = {}) =>
  JSON.stringify({
    time,
    bot: "helper",
    msg: "Agent request failed or timed out",
    ...extra,
  });

test("detailed shared status returns only OpenCode counts and version from read-only calls", async () => {
  const calls: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);

      if (path === "/api/info")
        return Response.json({
          version: "2.5.1",
          pid: 1,
          urls: [],
          paths: { tmp: "/" },
        });

      if (path === "/api/session/active")
        return Response.json({ data: { ses_test: { type: "running" } } });

      if (path === "/api/form" || path === "/api/permission/request")
        return Response.json({
          data: [{ sessionID: "ses_test", prompt: "secret-prompt" }],
        });

      if (path === "/api/mcp")
        return Response.json({
          data: [
            { name: "private-server", status: { status: "connected" } },
            {
              name: "private-server-2",
              status: { status: "failed", error: "secret-error" },
            },
          ],
        });

      return new Response("unknown", { status: 404 });
    },
  });

  try {
    const registration = bot();

    if (registration.backend.type !== "opencode")
      throw new Error("Invalid fixture");
    registration.backend = {
      ...registration.backend,
      url: server.url.href,
      sessionID: undefined,
    };

    const result = await botStatusReport(
      registration,
      {},
      undefined,
      now,
      true,
    );

    expect(result.openCode).toEqual({
      version: "2.5.1",
      activeSessions: 1,
      pendingForms: 1,
      pendingPermissions: 1,
      mcpConnected: 1,
      mcpFailed: 1,
    });
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /secret-|private-server|ses_test/,
    );
  } finally {
    await server.stop(true);
  }
});

test("unreadable OpenCode detail stays unknown without losing observed version", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/info")
        return Response.json({
          version: "2.5.1",
          pid: 1,
          urls: [],
          paths: { tmp: "/" },
        });

      return new Response("secret-upstream", { status: 503 });
    },
  });

  try {
    const registration = bot();

    if (registration.backend.type !== "opencode")
      throw new Error("Invalid fixture");
    registration.backend = {
      ...registration.backend,
      url: server.url.href,
      sessionID: undefined,
    };

    const result = await botStatusReport(
      registration,
      {},
      undefined,
      now,
      true,
    );

    expect(result.openCode).toEqual({
      version: "2.5.1",
      activeSessions: null,
      pendingForms: null,
      pendingPermissions: null,
      mcpConnected: null,
      mcpFailed: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret-upstream");
  } finally {
    await server.stop(true);
  }
});

test("groups a bounded window without exposing injected fields or inferring recovery", () => {
  const text = [
    line(now - 1000, {
      job: 1,
      failure: "secret-token",
      prompt: "secret-prompt",
    }),
    line(now - 2000),
    line(now - 86_400_001),
    line(now + 1),
    line(now - 3000, { bot: "other" }),
    line(now - 4000, { bot: undefined }),
    "not json",
    JSON.stringify({ time: now, msg: "__proto__" }),
  ].join("\n");

  const result = summarizeLog(text, "helper", now, true);
  expect(result.incidents).toHaveLength(2);
  expect(result.incidents[0]).toMatchObject({
    count: 2,
    first: new Date(now - 2000).toISOString(),
    last: new Date(now - 1000).toISOString(),
    state: "unknown",
    scope: "selected-bot",
  });
  expect(result.incidents[1]).toMatchObject({
    count: 1,
    scope: "unattributed",
  });
  expect(result.reasons.join(" ")).toContain("truncated");
  expect(result.reasons.join(" ")).toContain("attribution");
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(result.malformedLines).toBe(1);
});

test("read-only report keeps history when metadata succeeds and crew fails", async () => {
  const paths: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      paths.push(`${req.method} ${new URL(req.url).pathname}`);

      if (new URL(req.url).pathname.endsWith("/info"))
        return Response.json({
          version: "2",
          pid: 1,
          urls: [],
          paths: { tmp: "/" },
        });

      return new Response("secret error", { status: 500 });
    },
  });

  const dir = await mkdtemp(join(tmpdir(), "status-report-"));

  try {
    const registration = bot();

    if (registration.backend.type !== "opencode")
      throw new Error("invalid fixture");
    registration.backend = { ...registration.backend, url: server.url.href };
    const config = join(dir, "config.json");
    const log = join(dir, "log");
    await writeFile(config, JSON.stringify({ bots: [registration] }));
    await writeFile(log, line(now - 500));
    const before = await readFile(config, "utf8");
    const result = await statusReport(config, "helper", log, now);
    expect(result.checks.backendRead.state).toBe("available");
    expect(result.checks.backendWait.state).toBe("unknown");
    expect(result.checks.crewReporting.state).toBe("unknown");
    expect(result.history.incidents[0]).toMatchObject({
      state: "unknown",
      count: 1,
    });
    expect(JSON.stringify(result)).not.toContain("secret error");
    expect(paths.every((path) => path.startsWith("GET "))).toBe(true);
    expect(await readFile(config, "utf8")).toBe(before);

    const unreadable = await statusReport(
      config,
      "helper",
      join(dir, "missing"),
      now,
    );

    expect(unreadable.history.state).toBe("unknown");
    expect(
      (await statusReport(config, "helper", undefined, now)).history.state,
    ).toBe("unknown");
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("status help and argument errors precede configuration reads", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {});

  try {
    await runCli(["status", "--help", "--config", "/missing"]);
    expect(output.mock.calls.flat().join(" ")).toContain("--log PATH");

    for (const args of [
      ["status"],
      ["status", "--bot", "helper", "extra"],
      ["status", "--bot", "helper", "--name", "bad"],
      ["start", "--log", "bad"],
    ])
      await expect(runCli(args)).rejects.toThrow();
  } finally {
    output.mockRestore();
  }
});

test("status never requests a location or crew RPC, including if it is evicted", async () => {
  const calls: string[] = [];
  let incompatible = false;
  let evicted = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);

      if (url.pathname === "/api/info")
        return Response.json({
          version: "2",
          pid: 1,
          urls: [],
          paths: { tmp: "/" },
        });

      if (url.pathname === "/api/session/ses_fixture")
        return Response.json({
          data: {
            id: "ses_fixture",
            location: { directory: incompatible ? "/wrong" : "/workspace" },
          },
        });

      if (url.pathname === "/api/debug/location") {
        evicted = true; // A loaded location disappears after the list response.

        return Response.json([{ directory: "/workspace" }]);
      }

      if (url.pathname === "/api/rpc/stargate.crew.reporting/status")
        return new Response(null, { status: evicted ? 500 : 404 });

      return new Response(null, { status: 404 });
    },
  });

  const dir = await mkdtemp(join(tmpdir(), "status-rpc-"));

  try {
    const registration = bot();

    if (registration.backend.type !== "opencode")
      throw new Error("invalid fixture");
    registration.backend = {
      ...registration.backend,
      url: server.url.href,
      sessionID: "ses_fixture",
    };
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({ bots: [registration] }));
    const report = await statusReport(config, "helper", undefined, now);
    expect(report.checks.pinnedSession.state).toBe("available");
    expect(report.checks.crewReporting).toEqual({
      state: "unknown",
      reason: "atomic loaded-only read unavailable",
    });
    expect(calls).toEqual(["GET /api/info", "GET /api/session/ses_fixture"]);
    expect(evicted).toBe(false);
    incompatible = true;
    const failed = await statusReport(config, "helper", undefined, now);
    expect(failed.checks.pinnedSession.state).toBe("failed");
    expect(calls).toEqual([
      "GET /api/info",
      "GET /api/session/ses_fixture",
      "GET /api/info",
      "GET /api/session/ses_fixture",
    ]);
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("large log reads only tail and reports truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "status-tail-"));

  try {
    const registration = bot();
    registration.backend = {
      type: "pi-durable",
      directory: "/workspace",
      model: "openai/test",
      systemPrompt: "",
      tools: "none",
    };
    const config = join(dir, "config.json");
    const log = join(dir, "log");
    await writeFile(config, JSON.stringify({ bots: [registration] }));
    await writeFile(
      log,
      `${"x".repeat(2 * 1024 * 1024)}\n${line(now - 500)}\n`,
    );
    const result = await statusReport(config, "helper", log, now);
    expect(result.history.reasons.join(" ")).toContain("truncated");
    expect(result.history.incidents[0]).toMatchObject({ count: 1 });
    expect(result.checks.backendRead.state).toBe("unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("groups worker failures separately without exposing errors", () => {
  const text = [
    line(now - 2000, {
      msg: "Worker failed; request will need recovery",
      job: 17,
      error: "private exception",
    }),
    line(now - 1000, {
      msg: "Worker failed; request will need recovery",
      job: 18,
      prompt: "private prompt",
    }),
    line(now - 500, { failure: "backend", job: 19 }),
  ].join("\n");

  const report = summarizeLog(text, "helper", now, false);
  expect(report.incidents).toHaveLength(2);
  expect(report.incidents[0]).toMatchObject({
    category: "worker-recovery-required",
    capability: "worker",
    impact: "worker failed; recovery required",
    count: 2,
    first: new Date(now - 2000).toISOString(),
    last: new Date(now - 1000).toISOString(),
    jobs: [17, 18],
    state: "unknown",
  });
  expect(report.incidents[1]).toMatchObject({
    category: "agent-failure:backend",
    jobs: [19],
  });
  expect(JSON.stringify(report)).not.toContain("private");
});
