import { expect, test } from "bun:test";
import { Schema } from "effect";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema } from "../src/config";

const directory = "/workspace/assigned";
const agentID = "configured-agent";
const permissions = [{ action: "*", resource: "*", effect: "deny" }];

type Options = { pinned?: boolean; enforce?: boolean; agent?: boolean };

function fixture(options: Options = {}) {
  const calls: string[] = [];
  let ready = false;
  let missing = 0;
  let returnedID = agentID;
  let returnedDirectory = directory;
  let stalled = false;
  const entered = Promise.withResolvers<void>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push(url.pathname);

      if (url.pathname === `/api/agent/${agentID}`) {
        expect(url.searchParams.get("location[directory]")).toBe(directory);
        entered.resolve();

        if (stalled) {
          return new Promise<Response>(() => {});
        }

        if (missing-- > 0) {
          return Response.json(
            {
              _tag: "AgentNotFoundError",
              agentID,
              message: "sensitive plugin activation payload",
            },
            { status: 404 },
          );
        }

        ready = true;

        return Response.json({
          location: { directory: returnedDirectory },
          data: {
            id: returnedID,
            name: "Display name differs from ID",
            mode: "primary",
            hidden: false,
            request: { settings: {}, headers: {}, body: {} },
            permissions,
          },
        });
      }

      if (url.pathname === "/api/session" && request.method === "POST") {
        if (options.enforce !== false && options.agent !== false) {
          expect(ready).toBe(true);
        }

        expect(await request.json()).toMatchObject({
          ...(options.agent === false ? {} : { agent: agentID }),
          location: { directory },
        });

        return Response.json({ data: { id: "ses_created" } });
      }

      if (url.pathname === "/api/session/ses_pinned") {
        expect(ready).toBe(true);

        return Response.json({
          data: {
            id: "ses_pinned",
            agent: agentID,
            location: { directory },
            permissions,
          },
        });
      }

      throw new Error("Unexpected request before agent readiness");
    },
  });

  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url: server.url.href,
    directory,
    ...(options.agent === false ? {} : { agent: agentID }),
    ...(options.enforce === false ? {} : { enforcePermissions: true }),
    ...(options.pinned ? { sessionID: "ses_pinned" } : {}),
  });

  if (config.type !== "opencode") {
    throw new Error("Wrong fixture backend");
  }

  const backend = new OpenCodeBackend(config);

  return {
    backend,
    calls,
    entered: entered.promise,
    set missing(value: number) {
      missing = value;
    },
    set id(value: string) {
      returnedID = value;
    },
    set location(value: string) {
      returnedDirectory = value;
    },
    set stalled(value: boolean) {
      stalled = value;
    },
    resetReady() {
      ready = false;
    },
    create(signal = new AbortController().signal) {
      return backend.createSession({
        key: "conversation",
        title: "Fleet test",
        signal,
      });
    },
    async close() {
      await backend.close();
      await server.stop(true);
    },
  };
}

test("fleet waits for the exact configured native agent before creating a session", async () => {
  const f = fixture();
  f.missing = 2;

  try {
    expect(await f.create()).toBe("ses_created");
    expect(f.calls).toEqual([
      `/api/agent/${agentID}`,
      `/api/agent/${agentID}`,
      `/api/agent/${agentID}`,
      "/api/session",
    ]);
  } finally {
    await f.close();
  }
});

test("pinned session reuse rechecks readiness after the native engine restarts", async () => {
  const f = fixture({ pinned: true });

  try {
    expect(await f.create()).toBe("ses_pinned");
    f.resetReady();
    f.missing = 1;
    expect(await f.create()).toBe("ses_pinned");
    expect(f.calls).toEqual([
      `/api/agent/${agentID}`,
      "/api/session/ses_pinned",
      `/api/agent/${agentID}`,
      `/api/agent/${agentID}`,
      "/api/session/ses_pinned",
    ]);
  } finally {
    await f.close();
  }
});

test("a different agent ID or location is refused without fallback or session creation", async () => {
  for (const wrong of ["agent", "location"]) {
    const f = fixture();

    if (wrong === "agent") {
      f.id = "build";
    } else {
      f.location = "/another/workspace";
    }

    try {
      await expect(f.create()).rejects.toThrow(
        "Configured OpenCode agent unavailable or incompatible; no session was created or reused",
      );
      expect(f.calls).toEqual([`/api/agent/${agentID}`]);
    } finally {
      await f.close();
    }
  }
});

test("caller cancellation interrupts a stalled readiness HTTP call", async () => {
  const f = fixture();
  f.stalled = true;
  const stop = new AbortController();

  try {
    const result = f.create(stop.signal);
    await f.entered;
    const start = Date.now();
    stop.abort();
    await expect(result).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(f.calls).toEqual([`/api/agent/${agentID}`]);
  } finally {
    await f.close();
  }
});

test("cancellation also stops repeated transient agent-not-found responses", async () => {
  const f = fixture();
  f.missing = 1000;
  const stop = new AbortController();

  try {
    const result = f.create(stop.signal);
    await f.entered;
    stop.abort();
    await expect(result).rejects.toThrow();
    expect(f.calls).toEqual([`/api/agent/${agentID}`]);
  } finally {
    await f.close();
  }
});

test("readiness is opt-in and needs both enforced permissions and an explicit agent", async () => {
  for (const options of [{ enforce: false }, { agent: false }]) {
    const f = fixture(options);

    try {
      expect(await f.create()).toBe("ses_created");
      expect(f.calls).toEqual(["/api/session"]);
    } finally {
      await f.close();
    }
  }
});
