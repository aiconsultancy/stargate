import { describe, expect, test } from "bun:test";
import { request, type Server } from "node:http";
import { AuthError, type VerifiedToken } from "../src/teams/botframework-auth";
import {
  createTeamsListener,
  HEADERS_TIMEOUT_MS,
  MAX_ACTIVITY_BYTES,
  REQUEST_TIMEOUT_MS,
  type TeamsListenerOptions,
} from "../src/teams/http";
import { close } from "../src/lib/http-util";

const token: VerifiedToken = { claims: {}, endorsements: ["msteams"] };
const headers = {
  "content-type": "application/json",
  authorization: "Bearer good",
};

async function serve(overrides: Partial<TeamsListenerOptions> = {}) {
  const activities: Record<string, unknown>[] = [];
  const server = createTeamsListener({
    verifyToken: async (authorization) => {
      if (authorization !== "Bearer good") throw new AuthError("bad token");
      return token;
    },
    checkActivity: () => {},
    onActivity: async (activity) => {
      activities.push(activity);
    },
    log: () => {},
    ...overrides,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, activities };
}

function post(
  server: Server,
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; closed: boolean; body: string }> {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local listener");
  const body = options.body ?? "{}";
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: options.path ?? "/api/messages",
        method: options.method ?? "POST",
        headers: {
          "content-length": Buffer.byteLength(body),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            closed: res.headers["connection"] === "close",
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("Teams HTTP authentication boundary", () => {
  test("sets bounded production request limits", () => {
    const server = createTeamsListener({
      verifyToken: async () => token,
      checkActivity: () => {},
      onActivity: async () => {},
      log: () => {},
    });
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(MAX_ACTIVITY_BYTES).toBe(512 * 1024);
  });

  test("acknowledges only after authenticated activity handling completes", async () => {
    const entered = Promise.withResolvers<void>();
    const persisted = Promise.withResolvers<void>();
    const f = await serve({
      onActivity: async () => {
        entered.resolve();
        await persisted.promise;
      },
    });
    try {
      const response = post(f.server, { headers, body: '{"type":"message"}' });
      await entered.promise;
      const early = await Promise.race([
        response.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
      ]);
      expect(early).toBe(false);
      persisted.resolve();
      expect((await response).status).toBe(200);
    } finally {
      persisted.resolve();
      await close(f.server);
    }
  });

  test("refuses non-callback paths and methods before token checks", async () => {
    let checks = 0;
    const f = await serve({
      verifyToken: async () => {
        checks++;
        return token;
      },
    });
    try {
      for (const path of [
        "/",
        "/api/messages/",
        "/api/messages/../admin",
        "/admin",
      ]) {
        expect((await post(f.server, { path, headers })).status).toBe(404);
      }
      for (const method of ["GET", "PUT", "DELETE"]) {
        expect((await post(f.server, { method, headers })).status).toBe(405);
      }
      expect(checks).toBe(0);
      expect(f.activities).toEqual([]);
    } finally {
      await close(f.server);
    }
  });

  test("rejects missing auth before oversized or malformed body parsing", async () => {
    const f = await serve({ maxActivityBytes: 10 });
    try {
      const result = await post(f.server, {
        headers: { "content-type": "application/json" },
        body: "malformed".repeat(100),
      });
      expect(result.status).toBe(401);
      expect(result.closed).toBe(true);
      expect(f.activities).toEqual([]);
    } finally {
      await close(f.server);
    }
  });

  test("rejects wrong media type, malformed/non-object JSON and oversized activities", async () => {
    const f = await serve({ maxActivityBytes: 128 });
    try {
      expect(
        (
          await post(f.server, {
            headers: { ...headers, "content-type": "text/plain" },
          })
        ).status,
      ).toBe(415);
      for (const body of ["{invalid", "null", "[]", '"text"']) {
        expect((await post(f.server, { headers, body })).status).toBe(400);
      }
      const large = await post(f.server, {
        headers,
        body: JSON.stringify({ text: "x".repeat(256) }),
      });
      expect(large.status).toBe(413);
      expect(large.closed).toBe(true);
      expect(f.activities).toEqual([]);
    } finally {
      await close(f.server);
    }
  });

  test("checks service/channel binding before durable intake", async () => {
    const f = await serve({
      checkActivity: () => {
        throw new AuthError("wrong channel endorsement", 403);
      },
    });
    try {
      expect((await post(f.server, { headers })).status).toBe(403);
      expect(f.activities).toEqual([]);
    } finally {
      await close(f.server);
    }
  });

  test("temporary key failures return retryable 503 and persistence errors do not ACK", async () => {
    const unavailable = await serve({
      verifyToken: async () => {
        throw new Error("keys unavailable");
      },
    });
    try {
      const result = await post(unavailable.server, { headers });
      expect(result.status).toBe(503);
      expect(result.closed).toBe(true);
      expect(unavailable.activities).toEqual([]);
    } finally {
      await close(unavailable.server);
    }
    const persistence = await serve({
      onActivity: async () => {
        throw new Error("disk unavailable");
      },
    });
    try {
      expect((await post(persistence.server, { headers })).status).toBe(500);
    } finally {
      await close(persistence.server);
    }
  });
});
