import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pluginAccountSchema,
  readPluginQuota,
  type QuotaCredential,
  type QuotaRequest,
} from "../src/backends/quota/plugin-quota";
import { QuotaReader } from "../src/backends/quota/quota";

const now = Date.parse("2026-11-25T10:00:00Z");

const credential: QuotaCredential = {
  provider: "opencode-go",
  auth_index: "7f5c47c65117e8ec",
};

function discoveryResponse(
  providers: { provider: string; display_name: string }[],
) {
  return { providers };
}

function fetchResponse() {
  return {
    subscription: { plan: "Go" },
    groups: [
      {
        displayName: "OpenCode Go",
        buckets: [
          {
            window: "rolling",
            remainingFraction: 0.75,
            resetTime: "2026-11-25T14:38:51Z",
          },
          {
            window: "weekly",
            remainingFraction: 0.73,
            resetTime: "2026-11-30T00:00:00Z",
          },
          {
            window: "monthly",
            remainingFraction: 0.51,
            resetTime: "2026-11-30T05:30:37Z",
          },
        ],
      },
    ],
  };
}

const passThrough: QuotaRequest = (path, _signal, body) => {
  if (path === "/v0/management/quota/providers") {
    return Promise.resolve(
      discoveryResponse([
        { provider: "opencode-go", display_name: "OpenCode Go" },
      ]),
    );
  }

  if (path === "/v0/management/quota/fetch") {
    expect((body as { auth_index: string }).auth_index).toBe(
      "7f5c47c65117e8ec",
    );

    return Promise.resolve(fetchResponse());
  }

  return Promise.reject(new Error(`unexpected path ${path}`));
};

test("readPluginQuota normalizes discovered providers with all windows", async () => {
  const accounts = await readPluginQuota(
    passThrough,
    [credential],
    new AbortController().signal,
    () => now,
  );

  expect(accounts).toHaveLength(1);

  const account = accounts.at(0);

  if (!account) {
    throw new Error("Expected one plugin account");
  }

  expect(account.provider).toBe("opencode-go");
  expect(account.label).toBe("OpenCode Go");
  expect(account.status).toBe("ok");
  expect(account.plan).toBe("Go");
  expect(account.observedAt).toBe(now);
  expect(account.windows).toHaveLength(3);

  const rolling = account.windows[0];
  const weekly = account.windows[1];
  const monthly = account.windows[2];

  expect(rolling).toBeDefined();
  expect(weekly).toBeDefined();
  expect(monthly).toBeDefined();

  expect(rolling).toEqual({
    window: "rolling",
    remainingPercent: 25,
    resetAt: Math.floor(Date.parse("2026-11-25T14:38:51Z") / 1000),
  });
  expect(weekly?.remainingPercent).toBe(27);
  expect(monthly?.remainingPercent).toBe(49);
  expect(pluginAccountSchema.fields).toBeDefined();
});

test("readPluginQuota skips credentials whose provider is not discovered", async () => {
  const unknown: QuotaCredential = {
    provider: "not-discovered",
    auth_index: "abc123",
  };

  const accounts = await readPluginQuota(
    passThrough,
    [unknown, credential],
    new AbortController().signal,
    () => now,
  );

  expect(accounts).toHaveLength(1);
  expect(accounts[0]?.provider).toBe("opencode-go");
});

test("readPluginQuota reports a failed fetch as unavailable, not fatal", async () => {
  const failing: QuotaRequest = (path, _signal, body) => {
    if (path === "/v0/management/quota/providers") {
      return Promise.resolve(
        discoveryResponse([
          { provider: "opencode-go", display_name: "OpenCode Go" },
          { provider: "google-antigravity", display_name: "Antigravity" },
        ]),
      );
    }

    if (path === "/v0/management/quota/fetch") {
      const index = (body as { auth_index: string }).auth_index;

      if (index === "fail") {
        return Promise.reject(new Error("quota unavailable"));
      }

      return Promise.resolve(fetchResponse());
    }

    return Promise.reject(new Error(`unexpected path ${path}`));
  };

  const accounts = await readPluginQuota(
    failing,
    [
      { provider: "opencode-go", auth_index: "7f5c47c65117e8ec" },
      { provider: "google-antigravity", auth_index: "fail" },
    ],
    new AbortController().signal,
    () => now,
  );

  expect(accounts).toHaveLength(2);
  expect(accounts[0]?.status).toBe("ok");
  expect(accounts[1]?.status).toBe("unavailable");
  expect(accounts[1]?.provider).toBe("google-antigravity");
  expect(accounts[1]?.label).toBe("Antigravity");
  expect(accounts[1]?.windows).toHaveLength(0);
});

test("readPluginQuota stops at twenty accounts", async () => {
  const many: QuotaCredential[] = Array.from({ length: 30 }, (_, i) => ({
    provider: "opencode-go",
    auth_index: `key-${i}`,
  }));

  const accounts = await readPluginQuota(
    passThrough,
    many,
    new AbortController().signal,
    () => now,
  );

  expect(accounts.length).toBeLessThanOrEqual(20);
  expect(accounts[0]?.label).toBe("OpenCode Go");
  expect(accounts[1]?.label).toBe("OpenCode Go 2");
});

test("QuotaReader snapshot includes pluginAccounts from the proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plugin-quota-"));

  try {
    const key = join(directory, "management.key");
    await writeFile(key, "fixture-only", { mode: 0o600 });

    const credentials = {
      files: [
        { provider: "opencode-go", auth_index: "7f5c47c65117e8ec" },
        {
          provider: "claude",
          auth_index: "claude-key-1",
          email: "user@example.com",
        },
      ],
    };

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;

        if (path === "/v8/management/credentials") {
          return Response.json(credentials);
        }

        if (path === "/v0/management/quota/providers") {
          return Response.json(
            discoveryResponse([
              { provider: "opencode-go", display_name: "OpenCode Go" },
            ]),
          );
        }

        if (path === "/v0/management/quota/fetch") {
          return Response.json(fetchResponse());
        }

        return new Response(null, { status: 404 });
      },
    });

    try {
      const reader = new QuotaReader(
        { baseURL: server.url.origin, managementKeyFile: key },
        () => now,
      );

      const snapshot = await reader.read(new AbortController().signal);
      expect(snapshot.pluginAccounts).toHaveLength(1);
      expect(snapshot.pluginAccounts?.[0]?.provider).toBe("opencode-go");
      expect(snapshot.pluginAccounts?.[0]?.windows).toHaveLength(3);
    } finally {
      await server.stop(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
