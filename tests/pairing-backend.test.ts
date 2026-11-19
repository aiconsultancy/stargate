import { expect, test } from "bun:test";
import { Schema } from "effect";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema } from "../src/config";

const fixtureAuthEnv = "STARGATE_PAIR_FIXTURE_AUTH";

function backend(url: string, headersEnv: Record<string, string> = {}) {
  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url,
    directory: "/workspace",
    headersEnv,
  });
  if (config.type !== "opencode") throw new Error("Invalid fixture");
  return new OpenCodeBackend(config);
}

test("SDK pairing uses existing authentication and only POST /api/pair; no redemption", async () => {
  const requests: {
    path: string;
    method: string;
    auth: string | null;
    body: string;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        auth: request.headers.get("authorization"),
        body: await request.text(),
      });
      return Response.json({ code: "fixture-code", expires_in: 47 });
    },
  });
  process.env[fixtureAuthEnv] = "Bearer fixture-auth";
  try {
    const adapter = backend(server.url.href, {
      authorization: fixtureAuthEnv,
    });
    expect(await adapter.pair(new AbortController().signal)).toEqual({
      code: "fixture-code",
      expiresIn: 47,
    });
    await adapter.close();
    expect(requests).toEqual([
      {
        path: "/api/pair",
        method: "POST",
        auth: "Bearer fixture-auth",
        body: "",
      },
    ]);
  } finally {
    delete process.env[fixtureAuthEnv];
    await server.stop(true);
  }
});

test("pairing accepts code and expiry bounds while discarding unknown response fields", async () => {
  const code = "A".repeat(512);
  const cases = [
    {
      body: { code: "_", expires_in: 1, extra: "ignored" },
      expected: { code: "_", expiresIn: 1 },
    },
    {
      body: { code, expires_in: 86_400, extra: "ignored" },
      expected: { code, expiresIn: 86_400 },
    },
  ];
  for (const { body, expected } of cases) {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json(body),
    });
    const adapter = backend(server.url.href);
    try {
      expect(await adapter.pair(new AbortController().signal)).toEqual(
        expected,
      );
    } finally {
      await adapter.close();
      await server.stop(true);
    }
  }
});

test("pairing failures and invalid codes are sanitized, with no retry or redirect", async () => {
  for (const result of [
    { status: 401, body: { message: "PRIVATE failure" } },
    { status: 503, body: { code: "PRIVATE" } },
    { status: 200, body: { code: "PRIVATE", expires_in: 0 } },
    { status: 200, body: { code: "PRIVATE", expires_in: -1 } },
    { status: 200, body: { code: "PRIVATE", expires_in: 1.5 } },
    { status: 200, body: { code: "PRIVATE", expires_in: 86_401 } },
    { status: 200, body: { code: "", expires_in: 300 } },
    { status: 200, body: { code: "P".repeat(513), expires_in: 300 } },
    { status: 200, body: { code: "PRIVATE/path", expires_in: 300 } },
    { status: 200, body: { code: "PRIVATE\n", expires_in: 300 } },
    { status: 200, body: { code: "PRIVATE", expires_in: "300" } },
    { status: 302, body: null },
  ]) {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return result.status === 302
          ? new Response(null, {
              status: 302,
              headers: { location: "/auth/connect/PRIVATE" },
            })
          : Response.json(result.body, { status: result.status });
      },
    });
    try {
      await expect(
        backend(server.url.href).pair(new AbortController().signal),
      ).rejects.toThrow("OpenCode pairing failed; outcome may be unknown");
      expect(paths).toEqual(["/api/pair"]);
    } finally {
      await server.stop(true);
    }
  }
});

test("pairing AbortSignal stops the underlying SDK request without retry", async () => {
  const received = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      requests++;
      received.resolve();
      return response.promise;
    },
  });
  try {
    const controller = new AbortController();
    const run = backend(server.url.href).pair(controller.signal);
    await received.promise;
    controller.abort();
    await expect(run).rejects.toThrow("OpenCode pairing failed");
    await expect(
      backend(server.url.href).pair(controller.signal),
    ).rejects.toThrow("OpenCode pairing failed");
    expect(requests).toBe(1);
  } finally {
    response.resolve(Response.json({ code: "unused", expires_in: 300 }));
    await server.stop(true);
  }
});
