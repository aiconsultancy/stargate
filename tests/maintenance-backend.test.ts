import { expect, test } from "bun:test";
import { Schema } from "effect";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema } from "../src/config";

test("maintenance RPC pins session, request, notice and captain location", async () => {
  const calls: { path: string; location: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        location: url.searchParams.get("location[directory]"),
        body: await request.json(),
      });
      return Response.json({
        output: url.pathname.endsWith("/read")
          ? {
              id: "notice",
              plan: "Restart",
              impact: "Disconnect",
              rollback: "Restore",
            }
          : true,
      });
    },
  });
  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/captain",
    });
    if (config.type !== "opencode") throw new Error("Wrong fixture");
    const backend = new OpenCodeBackend(config);
    const signal = new AbortController().signal;
    const watch = await backend.startMaintenance("captain", "turn", signal);
    expect((await watch.read(signal))?.id).toBe("notice");
    await watch.delivered("notice", signal);
    await watch.close(signal);
    expect(calls.map(({ path }) => path)).toEqual(
      ["open", "read", "delivered", "close"].map(
        (method) => `/api/rpc/stargate.maintenance/${method}`,
      ),
    );
    expect(calls.every(({ location }) => location === "/captain")).toBe(true);
    expect(calls[0]?.body).toEqual({
      input: { sessionID: "captain", id: "turn" },
    });
    expect(calls[2]?.body).toEqual({
      input: { sessionID: "captain", id: "turn", noticeID: "notice" },
    });
  } finally {
    await server.stop(true);
  }
});
