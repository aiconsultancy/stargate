import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import {
  parseQuotaWindows,
  QuotaReader,
  quotaConfigSchema,
} from "../src/quota/quota";

const now = Date.parse("2026-11-09T20:00:00Z");
const reset = "2026-11-10T00:00:00Z";

test("Claude quotas preserve used semantics, unknowns and inactive model scopes", () => {
  const windows = parseQuotaWindows("claude", {
    seven_day: { utilization: 57, resets_at: reset },
    five_hour: { utilization: null, resets_at: null },
    limits: [
      {
        kind: "weekly_scoped",
        percent: 3,
        resets_at: reset,
        is_active: false,
        scope: { model: { display_name: "Fable" } },
      },
    ],
    email: "private@example.com",
    access_token: "secret",
  });

  expect(windows).toContainEqual({
    window: "weekly",
    scope: "subscription",
    usedPercent: 57,
    remainingPercent: 43,
    resetAt: Date.parse(reset),
    active: null,
  });
  expect(windows).toContainEqual({
    window: "5h",
    scope: "subscription",
    usedPercent: null,
    remainingPercent: null,
    resetAt: null,
    active: null,
  });
  expect(windows.find((w) => w.scope === "fable")).toMatchObject({
    remainingPercent: 97,
    active: false,
  });
  expect(JSON.stringify(windows)).not.toMatch(/secret|private@example/);
  expect(() =>
    parseQuotaWindows("claude", { seven_day: { utilization: "57" } }),
  ).toThrow();
});

test("collector blocks redirects, oversized data, key symlinks and caller cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-quota-boundary-"));
  const key = join(directory, "management.key");
  const link = join(directory, "link.key");
  await writeFile(key, "fixture-only", { mode: 0o600 });
  await symlink(key, link);
  let mode = "redirect";
  let requests = 0;
  let followed = false;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;

      if (new URL(request.url).pathname === "/unexpected") followed = true;

      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "/unexpected" },
        });

      if (mode === "large") return new Response("x".repeat(1024 * 1024 + 1));
      started.resolve();

      return release.promise;
    },
  });

  const read = (
    managementKeyFile = key,
    signal = new AbortController().signal,
  ) =>
    new QuotaReader(
      { baseURL: server.url.origin, managementKeyFile },
      () => now,
    ).read(signal);

  try {
    expect(await read()).toMatchObject({ status: "unavailable", accounts: [] });
    expect(followed).toBe(false);
    mode = "large";
    expect(await read()).toMatchObject({ status: "unavailable", accounts: [] });
    const before = requests;
    expect(await read(link)).toMatchObject({
      status: "unavailable",
      accounts: [],
    });
    expect(requests).toBe(before);
    mode = "blocked";
    const controller = new AbortController();
    const pending = read(key, controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
  } finally {
    release.resolve(Response.json({ files: [] }));
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex reports actual window duration, review scope, and over-limit remaining zero", () => {
  expect(
    parseQuotaWindows("codex", {
      rate_limit: {
        primary_window: {
          used_percent: 29,
          reset_at: Date.parse(reset) / 1000,
          limit_window_seconds: 604_800,
        },
      },
      code_review_rate_limit: {
        secondary_window: {
          used_percent: 110,
          reset_at: null,
          limit_window_seconds: 18_000,
        },
      },
    }),
  ).toEqual([
    {
      window: "weekly",
      scope: "subscription",
      usedPercent: 29,
      remainingPercent: 71,
      resetAt: Date.parse(reset),
      active: null,
    },
    {
      window: "5h",
      scope: "code-review",
      usedPercent: 110,
      remainingPercent: 0,
      resetAt: null,
      active: null,
    },
  ]);
  expect(() => parseQuotaWindows("codex", {})).toThrow();
});

test("quota configuration permits loopback only and never accepts inline credentials", () => {
  for (const baseURL of [
    "https://example.com",
    "http://localhost:8317",
    "http://127.0.0.1:8317/x",
    "http://user:secret@127.0.0.1:8317",
    "http://127.0.0.1:8317/?key=x",
  ]) {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(quotaConfigSchema)({
          baseURL,
          managementKeyFile: "/private/key",
        }),
      ),
    ).toBe(false);
  }

  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(quotaConfigSchema)({
        baseURL: "http://127.0.0.1:8317",
        managementKeyFile: "/private/key",
        key: "secret",
      }),
    ),
  ).toBe(false);
});

test("collector uses fixed read endpoints, strips secrets, caches then fails closed per account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-quota-"));
  const managementKeyFile = join(directory, "management.key");
  await writeFile(managementKeyFile, "fixture-management-key\n", {
    mode: 0o600,
  });
  const calls: { path: string; body: unknown }[] = [];
  let failure = false;
  let clock = now;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer fixture-management-key",
      );
      const path = new URL(request.url).pathname;

      if (path === "/v8/management/credentials") {
        calls.push({ path, body: null });

        return Response.json({
          files: [
            {
              provider: "claude",
              auth_index: "private-claude",
              email: "secret@example.com",
            },
            {
              provider: "codex",
              auth_index: "private-codex",
              account_id: "private-account",
            },
            { provider: "claude", auth_index: "disabled", disabled: true },
          ],
        });
      }

      const body = await request.json();
      calls.push({ path, body });
      const codex = body.auth_index === "private-codex";

      return Response.json({
        status_code: failure && codex ? 401 : 200,
        body: JSON.stringify(
          failure && codex
            ? { error: "private access_token=secret" }
            : codex
              ? {
                  rate_limit: {
                    primary_window: {
                      used_percent: 29,
                      reset_at: Date.parse(reset) / 1000,
                      limit_window_seconds: 604_800,
                    },
                  },
                }
              : { seven_day: { utilization: 57, resets_at: reset } },
        ),
      });
    },
  });

  try {
    const reader = new QuotaReader(
      { baseURL: server.url.origin, managementKeyFile },
      () => clock,
    );

    const first = await reader.read(new AbortController().signal);
    expect(first.status).toBe("ok");
    expect(first.accounts.map((a) => a.account)).toEqual([
      "claude-1",
      "codex-1",
    ]);
    expect(JSON.stringify(first)).not.toMatch(
      /secret|private-|fixture-management/,
    );
    expect(calls.map((c) => c.path)).toEqual([
      "/v8/management/credentials",
      "/v8/management/requests/api-call",
      "/v8/management/requests/api-call",
    ]);
    expect(calls[1]?.body).toMatchObject({
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      header: { Authorization: "Bearer $TOKEN$" },
    });
    expect(calls[2]?.body).toMatchObject({
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header: { "Chatgpt-Account-Id": "private-account" },
    });
    clock += 1000;
    expect(await reader.read(new AbortController().signal)).toMatchObject({
      cached: true,
      observedAt: now,
    });
    expect(calls).toHaveLength(3);
    failure = true;
    clock += 60_000;
    const partial = await reader.read(new AbortController().signal);
    expect(partial.status).toBe("partial");
    expect(partial.accounts[1]).toMatchObject({
      status: "unavailable",
      observedAt: null,
      windows: [],
    });
    expect(JSON.stringify(partial)).not.toContain("secret");
    await chmod(managementKeyFile, 0o644);
    clock += 60_000;
    expect(await reader.read(new AbortController().signal)).toMatchObject({
      status: "unavailable",
      accounts: [],
    });
    expect(calls).toHaveLength(6);
    // A reserved Claude login never becomes the crew login by list position.
    await chmod(managementKeyFile, 0o600);

    const selected = await new QuotaReader(
      {
        baseURL: server.url.origin,
        managementKeyFile,
        accounts: { claude: ["crew@example.com"] },
      },
      () => clock,
    ).read(new AbortController().signal);

    expect(
      selected.accounts.find((row) => row.provider === "claude"),
    ).toMatchObject({
      account: "claude-1",
      status: "unavailable",
      windows: [],
    });
    expect(calls.slice(6)).toHaveLength(2);
    expect(calls[7]?.body).toMatchObject({ auth_index: "private-codex" });
    expect(JSON.stringify(selected)).not.toContain("crew@example");

    const claudeOnly = await new QuotaReader(
      { baseURL: server.url.origin, managementKeyFile },
      () => clock,
      ["claude"],
    ).read(new AbortController().signal);

    expect(claudeOnly.status).toBe("ok");
    expect(claudeOnly.accounts.map(({ account }) => account)).toEqual([
      "claude-1",
    ]);
    expect(calls.slice(8)).toHaveLength(2);
    expect(calls[9]?.body).toMatchObject({ auth_index: "private-claude" });
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read(controller.signal)).rejects.toThrow();
    expect(
      await new QuotaReader().read(new AbortController().signal),
    ).toMatchObject({ status: "not-configured", accounts: [] });
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
