import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { AntigravityBackend } from "../src/backends/antigravity";
import { antigravityBackendSchema } from "../src/backends/config";
import {
  antigravityVersionSupported,
  parseAntigravityVersion,
  resolveAntigravityModel,
} from "../src/backends/antigravity/support";
import { createBackend } from "../src/backends/factory";
import { BackendFailure } from "../src/shared/request-failure";

const fixture = join(import.meta.dir, "acp-fixture.ts");
const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratchDir() {
  const dir = await mkdtemp(join(tmpdir(), "stargate-agy-test-"));
  cleanup.push(dir);

  return dir;
}

async function fakeAgyLauncher(
  root: string,
  extraEnv: Record<string, string> = {},
) {
  const script = join(root, "fake-agy.sh");

  const envExports = Object.entries(extraEnv)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");

  await writeFile(
    script,
    `#!/bin/sh\n${envExports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(script, 0o700);

  return script;
}

describe("Antigravity config and helpers", () => {
  test("validates auth variants and defaults sandbox, telemetry, and deny policy", () => {
    const decoded = Schema.decodeUnknownSync(antigravityBackendSchema)({
      type: "antigravity",
      directory: "/workspace",
      executable: "/usr/local/bin/agy",
      auth: { method: "gemini-api-key", apiKeyEnv: "STARGATE_GEMINI_KEY" },
    });

    expect(decoded.permissionPolicy).toBe("deny");
    expect(decoded.sandbox).toBe(true);
    expect(decoded.disableTelemetry).toBe(true);

    const invalid = Schema.decodeUnknownResult(antigravityBackendSchema)({
      type: "antigravity",
      directory: "/workspace",
      executable: "/usr/local/bin/agy",
      auth: { method: "agent-platform" },
    });

    expect(Result.isFailure(invalid)).toBe(true);
  });

  test("enforces minimum version 1.5.1 and maps legacy model families", () => {
    expect(parseAntigravityVersion("1.5.15")).toEqual([1, 5, 15]);
    expect(parseAntigravityVersion("agy_acp_server_1.5.1")).toEqual([1, 5, 1]);
    expect(antigravityVersionSupported("1.5.0")).toBe(false);
    expect(antigravityVersionSupported("1.5.1")).toBe(true);
    expect(antigravityVersionSupported("1.5.15")).toBe(true);

    expect(
      resolveAntigravityModel(
        [
          {
            id: "model",
            type: "select",
            options: [{ value: "gemini-3.8-flash" }],
          },
        ],
        "gemini-3.8-flash-high",
      ),
    ).toBe("gemini-3.8-flash");
  });
});

describe("Antigravity backend", () => {
  test("isolates GEMINI_HOME, strips ambient keys, passes flags and systemPrompt meta", async () => {
    const root = await scratchDir();
    const workspace = join(root, "work");
    const data = join(root, "data");
    const logPath = join(root, "agy.ndjson");
    await mkdir(workspace, { recursive: true });

    const executable = await fakeAgyLauncher(root, {
      STARGATE_ACP_FIXTURE_LOG: logPath,
    });

    process.env["STARGATE_TEST_GEMINI_KEY"] = "configured-key";
    process.env["GEMINI_API_KEY"] = "ambient-key-must-not-leak";
    process.env["GOOGLE_API_KEY"] = "ambient-google-key-must-not-leak";

    try {
      const cfg = Schema.decodeUnknownSync(antigravityBackendSchema)({
        type: "antigravity",
        directory: workspace,
        executable,
        model: "claude-sonnet-5-5",
        thinkingLevel: "high",
        systemPrompt: "Keep answers brief.",
        auth: {
          method: "gemini-api-key",
          apiKeyEnv: "STARGATE_TEST_GEMINI_KEY",
        },
      });

      const backend = await createBackend(cfg, { dataDirectory: data });

      const session = await backend.createSession({
        key: "k1",
        title: "t1",
        signal: new AbortController().signal,
      });

      const answer = await backend.prompt(
        session,
        "hello",
        new AbortController().signal,
      );

      expect(answer).toBe("Hello world!");

      const settingsRaw = await readFile(
        join(data, "antigravity", "antigravity-acp", "settings.json"),
        "utf8",
      );

      expect(JSON.parse(settingsRaw)).toEqual({
        auth: { type: "gemini-api-key" },
      });

      const entries = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const start = entries.find((entry) => entry["type"] === "start");
      const argv = (start?.["argv"] ?? []) as string[];
      expect(argv).toContain("acp");
      expect(argv).toContain("--sandbox");
      expect(argv).toContain("--disable-telemetry");
      expect(argv).toContain("--gemini-dir");

      const env = (start?.["env"] ?? {}) as Record<string, unknown>;
      expect(env["GEMINI_HOME"]).toBe(join(data, "antigravity"));
      expect(env["GEMINI_API_KEY"]).toBe("configured-key");
      expect(env["GOOGLE_API_KEY"]).toBeUndefined();
      expect(env["AGY_ACP_FORCE_FILE_STORAGE"]).toBe("1");
      expect(env["AGY_CLI_DISABLE_AUTO_UPDATE"]).toBe("true");
      expect(env["BROWSER"]).toBe("/bin/false");

      const newReq = entries.find(
        (entry) =>
          entry["type"] === "request" && entry["method"] === "session/new",
      );

      expect(
        (newReq?.["params"] as Record<string, unknown> | undefined)?.["_meta"],
      ).toEqual({
        antigravity: { systemPrompt: { append: "Keep answers brief." } },
      });

      await backend.close();
    } finally {
      delete process.env["STARGATE_TEST_GEMINI_KEY"];
      delete process.env["GEMINI_API_KEY"];
      delete process.env["GOOGLE_API_KEY"];
    }
  });

  test("rejects old agy versions and intercepts auth stdout prompts as auth BackendFailure", async () => {
    const root = await scratchDir();
    const workspace = join(root, "work");
    await mkdir(workspace, { recursive: true });

    const oldExec = await fakeAgyLauncher(root, {
      STARGATE_ACP_FIXTURE_VERSION: "1.4.9",
    });

    const oldBackend = await AntigravityBackend.open(
      Schema.decodeUnknownSync(antigravityBackendSchema)({
        type: "antigravity",
        directory: workspace,
        executable: oldExec,
        auth: { method: "oauth-personal" },
      }),
      { dataDirectory: join(root, "data-old") },
    );

    const s1 = await oldBackend.createSession({
      key: "k1",
      title: "t1",
      signal: new AbortController().signal,
    });

    await expect(
      oldBackend.prompt(s1, "hi", new AbortController().signal),
    ).rejects.toMatchObject({ kind: "provider", ran: false });
    await oldBackend.close();

    const authExec = await fakeAgyLauncher(root, {
      STARGATE_ACP_FIXTURE_SCENARIO: "auth-stdout",
    });

    const authBackend = await AntigravityBackend.open(
      Schema.decodeUnknownSync(antigravityBackendSchema)({
        type: "antigravity",
        directory: workspace,
        executable: authExec,
        auth: { method: "oauth-personal" },
      }),
      { dataDirectory: join(root, "data-auth") },
    );

    const s2 = await authBackend.createSession({
      key: "k2",
      title: "t2",
      signal: new AbortController().signal,
    });

    try {
      await authBackend.prompt(s2, "hi", new AbortController().signal);
      expect.unreachable("Expected auth failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BackendFailure);
      expect((error as BackendFailure).kind).toBe("auth");
      expect((error as BackendFailure).ran).toBe(false);
    } finally {
      await authBackend.close();
    }
  });

  test("verifies real agy binary version when installed on host", async () => {
    const hostAgy = "/home/jack/.local/bin/agy";

    if (!existsSync(hostAgy)) {
      return;
    }

    const proc = Bun.spawn([hostAgy, "--version"], { stdout: "pipe" });
    const output = (await new Response(proc.stdout).text()).trim();
    expect(antigravityVersionSupported(output)).toBe(true);
  });
});
