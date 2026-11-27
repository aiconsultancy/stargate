import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { decodeJwt } from "jose";
import { SubspaceApi } from "../src/coordination/fleet/dispatch/api";
import { runApiRequest, runMcpBridge } from "../src/subspace/bridge";
import {
  type AgentKey,
  bundleText,
  generateAgentKey,
  parseBundle,
} from "../src/subspace/certificate";
import { apiPath } from "../src/subspace/proxy";
import { startSubspaceAgents } from "../src/subspace/start";
import {
  ENROLMENT_TOKEN,
  type Recorded,
  StubApi,
  bearer,
  captain,
  capturedLog,
  childDirectory,
  enrolled,
  overSocket,
  ownership,
  privateDirectory,
  removeDirectories,
  section,
  verifyAgentToken,
} from "./subspace-fixture";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }

  await removeDirectories();
});

const env = { SUBSPACE_ENROLMENT: ENROLMENT_TOKEN };
const enrol = "/api/v1/agents/enrol";
const none = {} as Recorded;

/** API requests other than background enrolment. */
const forwarded = (stub: StubApi) =>
  stub.requests.filter((request) => request.path !== enrol);

type Handler = (request: Recorded) => Response | Promise<Response>;

/** A stub API: enrolment always succeeds; everything else goes to `handler`. */
function stubApi(handler: Handler = () => Response.json({ ok: true })) {
  const stub = new StubApi();
  cleanup.push(() => stub.stop());
  stub.handler = (request) =>
    request.path === enrol ? enrolled(request) : handler(request);

  return stub;
}

/** Officers' proxies, each in its own private socket directory. */
async function officers(
  names: readonly string[] = ["captain-a", "captain-b"],
  handler?: Handler,
  extra: Record<string, unknown> = {},
) {
  const stub = stubApi(handler);
  const dataDirectory = await privateDirectory();
  const sockets = await privateDirectory("sg-");
  const socketOf = new Map<string, string>();

  for (const name of names) {
    socketOf.set(
      name,
      join(await childDirectory(sockets, name, 0o700), "a.sock"),
    );
  }

  const config = section(
    stub.url,
    names.map((name) => captain(name, { socketPath: socketOf.get(name) })),
    extra,
  );

  const { log, lines } = capturedLog();

  const runtime = await startSubspaceAgents({
    config,
    dataDirectory,
    log,
    env,
    ownership,
  });

  cleanup.push(() => runtime.close());

  const bundleOf = (name: string) =>
    join(dataDirectory, "subspace-agents", `${name}.pem`);

  const keyOf = async (name: string): Promise<AgentKey> =>
    parseBundle(await readFile(bundleOf(name), "utf8"));

  return {
    stub,
    runtime,
    socket: (name: string) => socketOf.get(name) ?? "",
    keyOf,
    bundleOf,
    lines,
  };
}

test("dispatch requests through the officer proxy get the enrolled signature", async () => {
  const name = "example-admiral";

  const { stub, socket, keyOf } = await officers([name], () =>
    Response.json({
      userId: "officer",
      kind: "agent",
      agentRank: "rearAdmiral",
      fleetId: "fleet",
    }),
  );

  const api = new SubspaceApi({ socketPath: socket(name), env: {} });
  const identity = await api.me(AbortSignal.timeout(3000));
  expect(identity.agentRank).toBe("rearAdmiral");

  const sent = forwarded(stub)[0] ?? none;
  const officer = await keyOf(name);

  const signed = await verifyAgentToken(
    bearer(sent),
    officer.certificate,
    stub.url,
  );

  expect(signed.payload.sub).toBe(officer.fingerprint);
});

test("proxy: each officer's socket signs as that officer, whatever the caller sends", async () => {
  const { stub, socket, keyOf } = await officers();

  const answer = await overSocket(
    socket("captain-a"),
    "GET",
    "/api/v1/me?agent=captain-b",
    {
      authorization: "Bearer caller-chosen-token",
      cookie: "session=caller",
      "x-subspace-agent": "captain-b",
      "x-forwarded-for": "198.51.100.7",
      forwarded: "for=198.51.100.7",
      origin: "https://example.test",
      "proxy-authorization": "Basic caller",
      "x-correlation-id": "correlation-1",
      accept: "application/json",
    },
  );

  expect(answer.status).toBe(200);
  expect(JSON.parse(answer.body)).toEqual({ ok: true });

  const first = forwarded(stub)[0] ?? none;

  expect(first.path).toBe("/api/v1/me?agent=captain-b");

  for (const header of [
    "cookie",
    "x-subspace-agent",
    "x-forwarded-for",
    "forwarded",
    "origin",
    "proxy-authorization",
  ]) {
    expect(first.headers[header]).toBeUndefined();
  }

  expect(first.headers["x-correlation-id"]).toBe("correlation-1");
  expect(first.headers["accept"]).toBe("application/json");

  const a = await keyOf("captain-a");
  const b = await keyOf("captain-b");
  const signed = await verifyAgentToken(bearer(first), a.certificate, stub.url);

  expect(signed.payload.sub).toBe(a.fingerprint);
  expect(signed.protectedHeader.kid).toBe(a.fingerprint);
  await expect(
    verifyAgentToken(bearer(first), b.certificate, stub.url),
  ).rejects.toThrow();

  // Through B's socket the token is B's, with a fresh jti for each request.
  await overSocket(socket("captain-b"), "GET", "/api/v1/me");
  await overSocket(socket("captain-b"), "GET", "/api/v1/me");
  const [, second = none, third = none] = forwarded(stub);

  expect(
    (await verifyAgentToken(bearer(second), b.certificate, stub.url)).payload
      .sub,
  ).toBe(b.fingerprint);
  await expect(
    verifyAgentToken(bearer(second), a.certificate, stub.url),
  ).rejects.toThrow();
  expect(decodeJwt(bearer(second)).jti).not.toBe(decodeJwt(bearer(third)).jti);
});

test("proxy: only /api/v1/ paths and the usual methods reach the one configured API", async () => {
  for (const [target, expected] of [
    ["/api/v1/issues?state=open", "/api/v1/issues?state=open"],
    ["/mcp", "/mcp"],
    ["/mcp?session=1", "/mcp?session=1"],
    ["/mcp/other", undefined],
    ["/mcpx", undefined],
    ["/api/v1/mcp", "/api/v1/mcp"],
    ["/api/v1/search?q=a%2Fb%2e", "/api/v1/search?q=a%2Fb%2e"],
    ["/api/v1/../admin", undefined],
    ["/api/v1/%2e%2e/admin", undefined],
    ["/api/v1/a%2fb", undefined],
    ["/api/v1/a\\b", undefined],
    ["/api/v2/issues", undefined],
    ["/api/v1", undefined],
    ["/admin", undefined],
    ["//evil.example/api/v1/me", undefined],
    ["http://evil.example/api/v1/me", undefined],
    ["/api/v1/me#fragment", undefined],
  ] as const) {
    expect(apiPath(target)).toBe(expected);
  }

  const { stub, socket } = await officers(["captain-a"]);

  for (const target of [
    "/api/v1/../admin",
    "/api/v1/%2e%2e/admin",
    "/api/v2/issues",
    "/admin",
    "http://evil.example/api/v1/me",
  ]) {
    const answer = await overSocket(socket("captain-a"), "GET", target);

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toEqual({
      error: "Only /api/v1/ paths and /mcp reach the Subspace API",
      source: "stargate",
    });
  }

  for (const method of ["OPTIONS", "TRACE"]) {
    expect(
      (await overSocket(socket("captain-a"), method, "/api/v1/me")).status,
    ).toBe(405);
  }

  expect(forwarded(stub)).toEqual([]);
});

test("proxy: bodies pass unchanged, response headers are filtered and a redirect is never followed", async () => {
  const { stub, socket } = await officers(["captain-a"], (request) =>
    request.path === "/api/v1/moved"
      ? new Response("moved", {
          status: 302,
          headers: { location: "https://elsewhere.example/steal" },
        })
      : new Response(JSON.stringify({ echoed: request.body }), {
          status: 201,
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=secret",
            "x-internal": "hidden",
            "mcp-session-id": "session-1",
            etag: '"v2"',
          },
        }),
  );

  // Crew act as their captain and name themselves; the body is not touched.
  const body =
    '{"title":"Example",  "relayedCrew":{"name":"crew-one","model":"example-model"}}';

  const created = await overSocket(
    socket("captain-a"),
    "POST",
    "/api/v1/issues",
    { "content-type": "application/json" },
    body,
  );

  expect(created.status).toBe(201);
  expect(JSON.parse(created.body)).toEqual({ echoed: body });
  expect(created.headers["set-cookie"]).toBeUndefined();
  expect(created.headers["x-internal"]).toBeUndefined();
  expect(created.headers["mcp-session-id"]).toBe("session-1");
  expect(created.headers["etag"]).toBe('"v2"');
  expect(forwarded(stub)[0]?.body).toBe(body);
  expect(forwarded(stub)[0]?.headers["content-type"]).toBe("application/json");

  const moved = await overSocket(socket("captain-a"), "GET", "/api/v1/moved");

  expect(moved.status).toBe(302);
  expect(moved.headers["location"]).toBeUndefined();
  expect(forwarded(stub).map((request) => request.path)).toEqual([
    "/api/v1/issues",
    "/api/v1/moved",
  ]);
});

test("proxy: an API that is down, slow or refusing gives a clear error and the proxy keeps serving", async () => {
  let mode: "slow" | "refuse" | "ok" = "slow";

  const { stub, socket, lines } = await officers(["captain-a"], async () => {
    if (mode === "slow") {
      await Bun.sleep(3000);
    }

    return mode === "refuse"
      ? Response.json(
          { title: "Unauthorised", detail: "Unknown key" },
          { status: 401 },
        )
      : Response.json({ ok: true });
  });

  const slow = await overSocket(socket("captain-a"), "GET", "/api/v1/me");

  expect(slow.status).toBe(504);
  expect(JSON.parse(slow.body).error).toBe(
    "The Subspace API did not answer in time",
  );

  mode = "refuse";
  const refused = await overSocket(socket("captain-a"), "GET", "/api/v1/me");

  expect(refused.status).toBe(401);
  expect(JSON.parse(refused.body)).toEqual({
    title: "Unauthorised",
    detail: "Unknown key",
  });
  await overSocket(socket("captain-a"), "GET", "/api/v1/me");
  expect(
    lines.filter((line) => line.includes("refused this officer's agent token")),
  ).toHaveLength(1);

  mode = "ok";
  expect(
    (await overSocket(socket("captain-a"), "GET", "/api/v1/me")).status,
  ).toBe(200);
  await stub.stop();

  const down = await overSocket(socket("captain-a"), "GET", "/api/v1/me");

  expect(down.status).toBe(502);
  expect(JSON.parse(down.body)).toEqual({
    error: "The Subspace API is unreachable",
    source: "stargate",
  });
  // Nothing about a request, token or key ever reaches the log.
  expect(lines.join("\n")).not.toMatch(/Bearer|PRIVATE KEY|senr1\./);
});

test("proxy: an unusable key is a clear error; a rotated bundle is used without a restart", async () => {
  const { stub, socket, bundleOf } = await officers(["captain-a"]);
  const bundle = bundleOf("captain-a");

  await chmod(bundle, 0o644);

  const exposed = await overSocket(socket("captain-a"), "GET", "/api/v1/me");

  expect(exposed.status).toBe(503);
  expect(JSON.parse(exposed.body).error).toBe(
    "This officer's Subspace key is unavailable; run stargate subspace enrol",
  );
  expect(forwarded(stub)).toEqual([]);

  const rotated = generateAgentKey("captain-a");
  await chmod(bundle, 0o600);
  await writeFile(bundle, bundleText(rotated));

  expect(
    (await overSocket(socket("captain-a"), "GET", "/api/v1/me")).status,
  ).toBe(200);
  expect(
    (
      await verifyAgentToken(
        bearer(forwarded(stub)[0] ?? none),
        rotated.certificate,
        stub.url,
      )
    ).payload.sub,
  ).toBe(rotated.fingerprint);
});

test("start-up: a bundle or socket directory others can use stops it, with a log line saying why", async () => {
  const stub = stubApi();
  const dataDirectory = await privateDirectory();
  const sockets = await privateDirectory("sg-");
  const open = await childDirectory(sockets, "open", 0o755);
  const sharedA = await childDirectory(sockets, "group-a", 0o750);
  const sharedB = await childDirectory(sockets, "group-b", 0o750);

  const start = async (officers: Record<string, unknown>[]) => {
    const { log, lines } = capturedLog();

    try {
      const runtime = await startSubspaceAgents({
        config: section(stub.url, officers),
        dataDirectory,
        log,
        env,
        ownership,
      });

      await runtime.close();

      return "started";
    } catch {
      return lines.join("\n");
    }
  };

  expect(
    await start([captain("captain-a", { socketPath: join(open, "a.sock") })]),
  ).toContain("socket directory must give others no access");
  expect(existsSync(join(open, "a.sock"))).toBe(false);

  // Two officers whose directories admit the same group could reach each other.
  expect(
    await start([
      captain("captain-a", { socketPath: join(sharedA, "a.sock") }),
      captain("captain-b", { socketPath: join(sharedB, "a.sock") }),
    ]),
  ).toContain("share a group");

  // One officer with a group directory is fine: the socket gets that group.
  expect(
    await start([
      captain("captain-a", { socketPath: join(sharedA, "a.sock") }),
    ]),
  ).toBe("started");

  await chmod(join(dataDirectory, "subspace-agents", "captain-a.pem"), 0o604);
  expect(
    await start([
      captain("captain-a", { socketPath: join(sharedA, "a.sock") }),
    ]),
  ).toContain("captain-a's Subspace bundle must be a regular file");
  expect(existsSync(join(sharedA, "a.sock"))).toBe(false);
});

test("socket: 0660 in a directory the gateway owns, removed on close", async () => {
  const { runtime, socket } = await officers(["captain-a"]);
  const info = await stat(socket("captain-a"));

  expect(info.isSocket()).toBe(true);
  expect((info.mode & 0o777).toString(8)).toBe("660");
  expect(info.uid).toBe(process.getuid?.() ?? -1);
  await runtime.close();
  expect(existsSync(socket("captain-a"))).toBe(false);
});

/** A stand-in for the API's MCP endpoint: JSON answers, 202 for notifications. */
function mcpApi(stream = false): Handler {
  return (request) => {
    if (request.path !== "/mcp") {
      return Response.json({ title: "Not found" }, { status: 404 });
    }

    const message = JSON.parse(request.body) as {
      id?: number;
      method: string;
    };

    if (message.id === undefined) {
      return new Response(null, { status: 202 });
    }

    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "Subspace API", version: "1.0.0" },
            capabilities: { tools: {} },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "list_issues" }] }
          : { content: [{ type: "text", text: "done" }], isError: false };

    const answer = { jsonrpc: "2.0", id: message.id, result };

    return stream
      ? new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\nevent: message\ndata: ${JSON.stringify(answer)}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json(answer);
  };
}

async function bridge(socketPath: string, messages: unknown[]) {
  const input = new PassThrough();
  const written: unknown[] = [];
  const reports: string[] = [];

  const running = runMcpBridge({
    socketPath,
    input,
    write: (line) => {
      expect(line).not.toContain("\n");
      written.push(JSON.parse(line));
    },
    report: (text) => {
      reports.push(text);
    },
  });

  for (const message of messages) {
    input.write(
      `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
    );
  }

  input.end();
  await running;

  return { written, reports };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "example" },
  },
};

test("bridge: an MCP exchange round-trips over stdio and the officer's socket", async () => {
  const { stub, socket, keyOf } = await officers(["captain-a"], mcpApi());

  const { written, reports } = await bridge(socket("captain-a"), [
    initialize,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: "three",
      method: "tools/call",
      params: {
        name: "create_issue",
        arguments: {
          title: "Example",
          relayedCrew: { name: "crew-one", model: "m" },
        },
      },
    },
  ]);

  expect(reports).toEqual([]);
  expect(written).toHaveLength(3);
  expect(written).toContainEqual(
    expect.objectContaining({
      id: 1,
      result: expect.objectContaining({ protocolVersion: "2025-06-18" }),
    }),
  );
  expect(written).toContainEqual({
    jsonrpc: "2.0",
    id: 2,
    result: { tools: [{ name: "list_issues" }] },
  });
  expect(written).toContainEqual(expect.objectContaining({ id: "three" }));

  const requests = forwarded(stub);

  expect(requests.map((request) => request.headers["content-type"])).toEqual(
    Array(4).fill("application/json"),
  );
  expect(requests[0]?.headers["mcp-protocol-version"]).toBeUndefined();
  // After initialize, the negotiated version accompanies each request.
  expect(
    requests.slice(1).map((request) => request.headers["mcp-protocol-version"]),
  ).toEqual(Array(3).fill("2025-06-18"));
  expect(requests[3]?.body).toContain(
    '"relayedCrew":{"name":"crew-one","model":"m"}',
  );

  const key = await keyOf("captain-a");

  for (const request of requests) {
    expect(
      (await verifyAgentToken(bearer(request), key.certificate, stub.url))
        .payload.sub,
    ).toBe(key.fingerprint);
  }
});

test("bridge: streamed answers become one line per event", async () => {
  const { socket } = await officers(["captain-a"], mcpApi(true));
  const { written } = await bridge(socket("captain-a"), [initialize]);

  expect(written).toEqual([
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 1 },
    },
    expect.objectContaining({
      id: 1,
      result: expect.objectContaining({ protocolVersion: "2025-06-18" }),
    }),
  ]);
});

test("bridge: a character split across streamed chunks arrives whole", async () => {
  const answer = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "Café, naïve ☕" }] },
  };

  const bytes = Buffer.from(
    `event: message\ndata: ${JSON.stringify(answer)}\n\n`,
    "utf8",
  );

  // Inside the two bytes of "é", so each write ends mid-character.
  const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1;

  const { socket } = await officers(
    ["captain-a"],
    () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(bytes.subarray(0, cut));
            await Bun.sleep(100);
            controller.enqueue(bytes.subarray(cut));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );

  const { written } = await bridge(socket("captain-a"), [initialize]);

  expect(written).toEqual([answer]);
});

test("bridge: refusals become JSON-RPC errors for requests, and diagnostics for notifications", async () => {
  const { socket } = await officers(["captain-a"], (request) =>
    request.body.includes("refuse")
      ? Response.json(
          { title: "The agent token was refused." },
          {
            status: 401,
            headers: { "content-type": "application/problem+json" },
          },
        )
      : Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32_600, message: "Invalid JSON-RPC request." },
          },
          { status: 400 },
        ),
  );

  const { written, reports } = await bridge(socket("captain-a"), [
    { jsonrpc: "2.0", id: 7, method: "refuse" },
    { jsonrpc: "2.0", method: "notifications/refuse" },
    { jsonrpc: "2.0", id: 8, method: "bad" },
    "not json",
  ]);

  expect(written).toContainEqual({
    jsonrpc: "2.0",
    id: 7,
    error: {
      code: -32_000,
      message:
        "The Subspace API answered HTTP 401: The agent token was refused.",
    },
  });
  // The API's own JSON-RPC error answers the request it was for.
  expect(written).toContainEqual({
    jsonrpc: "2.0",
    id: 8,
    error: { code: -32_600, message: "Invalid JSON-RPC request." },
  });
  expect(written).toContainEqual({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32_700, message: "Parse error" },
  });
  expect(written).toHaveLength(3);
  expect(reports).toEqual([
    "The Subspace API answered HTTP 401: The agent token was refused.",
  ]);

  const missing = await bridge(
    join(resolve(socket("captain-a"), ".."), "missing.sock"),
    [{ jsonrpc: "2.0", id: 9, method: "tools/list" }],
  );

  expect(missing.written).toEqual([
    {
      jsonrpc: "2.0",
      id: 9,
      error: {
        code: -32_000,
        message:
          "The Subspace signing proxy is unavailable: is the gateway running, and is this the officer's own socket?",
      },
    },
  ]);
});

test("request command: a REST call through the socket; exit 1 unless 2xx", async () => {
  const { socket } = await officers(["captain-a"], (request) =>
    request.path.startsWith("/api/v1/issues")
      ? Response.json({ items: [], method: request.method, body: request.body })
      : Response.json({ title: "Not found" }, { status: 404 }),
  );

  const run = async (method: string, path: string, body?: string) => {
    const chunks: Buffer[] = [];
    const reports: string[] = [];

    const code = await runApiRequest({
      socketPath: socket("captain-a"),
      method,
      path,
      ...(body !== undefined && { body: Buffer.from(body) }),
      output: new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      }),
      report: (text) => reports.push(text),
    });

    return { code, output: Buffer.concat(chunks).toString("utf8"), reports };
  };

  expect(await run("GET", "/api/v1/issues?limit=1")).toEqual({
    code: 0,
    output: JSON.stringify({ items: [], method: "GET", body: "" }),
    reports: [],
  });
  expect(
    (await run("POST", "/api/v1/issues", '{"title":"x"}')).output,
  ).toContain('"body":"{\\"title\\":\\"x\\"}"');
  expect(await run("GET", "/api/v1/missing")).toMatchObject({
    code: 1,
    reports: ["The Subspace API answered HTTP 404: Not found"],
  });
  expect((await run("GET", "/admin")).code).toBe(2);
});

test("command: stargate subspace mcp serves a harness as a child process", async () => {
  const { socket } = await officers(["captain-a"], mcpApi());

  const child = Bun.spawn(
    [
      process.execPath,
      resolve("src/main.ts"),
      "subspace",
      "mcp",
      "--socket",
      socket("captain-a"),
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "" },
    },
  );

  cleanup.push(() => child.kill());
  void child.stdin.write(`${JSON.stringify(initialize)}\n`);
  void child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  await child.stdin.end();

  const output = await new Response(child.stdout).text();

  expect(await child.exited).toBe(0);
  expect(
    output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number })
      .map((message) => message.id)
      .sort(),
  ).toEqual([1, 2]);
}, 20_000);
