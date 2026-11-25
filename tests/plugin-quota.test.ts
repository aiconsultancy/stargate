import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatQuota,
  QuotaReader,
  readPluginQuota,
  type QuotaCredential,
  type QuotaRequest,
} from "../src/backends/quota/quota";
import { QuotaWatch } from "../src/backends/quota/quota-watch";

const now = Date.parse("2026-11-25T10:00:00Z");

const credential: QuotaCredential = {
  provider: "opencode-go",
  auth_index: "7f5c47c65117e8ec",
};

function discoveryResponse(
  providers: {
    provider: string;
    display_name: string;
    supported_providers?: string[];
  }[],
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
            window: "daily",
            remainingFraction: 0.73,
            resetTime: "2026-12-01T00:00:00Z",
          },
          {
            remainingFraction: 0.1,
            resetTime: "2026-11-30T05:30:37Z",
          },
        ],
      },
    ],
  };
}

const passThrough: QuotaRequest = (path) => {
  if (path === "/v0/management/quota/providers") {
    return Promise.resolve(
      discoveryResponse([
        { provider: "opencode-go", display_name: "OpenCode Go" },
      ]),
    );
  }

  if (path === "/v0/management/quota/fetch") {
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
    remainingPercent: 75,
    resetAt: Date.parse("2026-11-25T14:38:51Z"),
  });
  expect(weekly).toEqual({
    window: "daily",
    remainingPercent: 73,
    resetAt: Date.parse("2026-12-01T00:00:00Z"),
  });
  expect(monthly?.window).toBe("other");
  expect(monthly?.remainingPercent).toBe(10);
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
          {
            provider: "google-plugin",
            display_name: "Antigravity",
            supported_providers: ["google-antigravity"],
          },
        ]),
      );
    }

    if (path === "/v0/management/quota/fetch") {
      const index = body?.auth_index;

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
      { provider: "google-antigravity", auth_index: "" },
      { provider: "opencode-go", auth_index: "7f5c47c65117e8ec" },
      { provider: "google-antigravity", auth_index: "fail" },
    ],
    new AbortController().signal,
    () => now,
  );

  expect(accounts).toHaveLength(3);
  expect(accounts[0]?.status).toBe("unavailable");
  expect(accounts[1]?.status).toBe("ok");
  expect(accounts[2]).toMatchObject({
    status: "unavailable",
    provider: "google-antigravity",
    label: "Antigravity 2",
    windows: [],
  });
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

  expect(accounts).toHaveLength(20);
  expect(accounts[0]?.label).toBe("OpenCode Go");
  expect(accounts[1]?.label).toBe("OpenCode Go 2");
});

test.each(["working", "invalid ID", "timeout"])(
  "quota reads keep the Claude account when plugin discovery is %s",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "plugin-quota-"));

    try {
      const key = join(directory, "management.key");
      const stateFile = join(directory, "quota.json");
      await writeFile(key, "fixture-only", { mode: 0o600 });
      let observedAt = now;
      let discovered = true;

      const credentials = {
        files: [
          { provider: "OpenCode-Go", auth_index: "" },
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
            if (scenario === "timeout") {
              return new Promise<Response>(() => {});
            }

            if (!discovered) {
              return Response.json(discoveryResponse([]));
            }

            return Response.json(
              discoveryResponse([
                ...(scenario === "invalid ID"
                  ? [{ provider: "OpenCode-Go", display_name: "Invalid ID" }]
                  : []),
                { provider: "opencode-go", display_name: "OpenCode Go" },
              ]),
            );
          }

          if (path === "/v0/management/quota/fetch") {
            return Response.json(fetchResponse());
          }

          if (path === "/v8/management/requests/api-call") {
            return Response.json({
              status_code: 200,
              body: { five_hour: { utilization: 5 } },
            });
          }

          return new Response(null, { status: 404 });
        },
      });

      try {
        const reader = new QuotaReader(
          { baseURL: server.url.origin, managementKeyFile: key },
          () => observedAt,
          ["claude"],
        );

        const signal = new AbortController().signal;
        const snapshot = await reader.read(signal);
        expect(snapshot.status).toBe("ok");
        expect(snapshot.accounts[0]?.status).toBe("ok");

        if (scenario === "timeout") {
          expect(snapshot.pluginAccounts).toBeUndefined();

          return;
        }

        expect(snapshot.pluginAccounts).toHaveLength(1);
        expect(snapshot.pluginAccounts?.[0]?.provider).toBe("opencode-go");
        expect(snapshot.pluginAccounts?.[0]?.windows).toHaveLength(3);
        expect(formatQuota(snapshot, now).join("\n")).toContain(
          "other: 10% remaining",
        );

        const notices: string[] = [];

        const watcher = new QuotaWatch(
          {
            proxy: { baseURL: server.url.origin, managementKeyFile: key },
            providers: ["claude"],
            report: { bot: "captain", channel: "C123" },
            stateFile,
          },
          reader,
          async (notice) => {
            notices.push(notice);
          },
          { warn: () => {} },
          () => observedAt,
        );

        await watcher.tick(signal);
        expect(notices).toEqual([
          expect.stringContaining("OpenCode Go crew quota: 15% or less"),
        ]);

        const expected = {
          claude: { mode: "normal", observedAt: now / 1000 },
          "opencode-go": { mode: "paused", observedAt: now / 1000 },
        };

        expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(expected);

        discovered = false;
        observedAt += 120_000;
        await watcher.tick(signal);
        expect(notices).toHaveLength(1);
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
          ...expected,
          claude: { mode: "normal", observedAt: observedAt / 1000 },
        });
      } finally {
        await server.stop(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  12_000,
);
