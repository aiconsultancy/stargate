import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { ClaudeBackend } from "../src/backends/claude";
import { claudeBackendSchema } from "../src/backends/claude/config";
import { claudeCLI } from "../src/backends/claude/executable";

const apiKeyEnv = "STARGATE_CLAUDE_UPGRADE_TEST_KEY";
const fixture = join(import.meta.dir, "claude-fixture.ts");
const cleanup: string[] = [];

afterEach(async () => {
  delete process.env[apiKeyEnv];

  for (const dir of cleanup.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function openFixtureBackend() {
  process.env[apiKeyEnv] = "test-proxy-key";
  const root = await mkdtemp(join(tmpdir(), "stargate-claude-upg-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  await mkdir(workspace, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(join(workspace, "fixture-version"), claudeCLI().version);
  const executable = join(root, "fake-claude");
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { mode: 0o755 },
  );

  const cfg = Schema.decodeUnknownSync(claudeBackendSchema)({
    type: "claude",
    directory: workspace,
    model: "claude-sonnet-5-5",
    provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv },
  });

  const backend = await ClaudeBackend.open(
    cfg,
    { dataDirectory: data },
    { executable, graceMs: 300 },
  );

  return { root, workspace, data, backend };
}

async function until(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Condition timed out");
    }

    await delay(25);
  }
}

describe("Claude backend upgrades", () => {
  test("sends graceful SDK interrupt control request before SIGTERM on abort and interrupt()", async () => {
    const { backend, data } = await openFixtureBackend();

    const s1 = await backend.createSession({
      key: "k1",
      title: "abort test",
      signal: AbortSignal.timeout(20_000),
    });

    const previews1: string[] = [];
    const controller = new AbortController();

    const running1 = backend.prompt(
      s1,
      "wait-interrupt",
      controller.signal,
      (text) => previews1.push(text),
    );

    await until(() => previews1.includes("Waiting"));
    controller.abort();
    await expect(running1).rejects.toThrow();

    const s2 = await backend.createSession({
      key: "k2",
      title: "interrupt test",
      signal: AbortSignal.timeout(20_000),
    });

    const previews2: string[] = [];

    const running2 = backend.prompt(
      s2,
      "wait-interrupt",
      AbortSignal.timeout(20_000),
      (text) => previews2.push(text),
    );

    await until(() => previews2.includes("Waiting"));
    await backend.interrupt(s2, AbortSignal.timeout(5000));
    await expect(running2).rejects.toThrow();

    const log = await readFile(join(data, "claude", "fixture.jsonl"), "utf8");

    const interrupts = log
      .trim()
      .split("\n")
      .filter((line) => line.includes('"subtype":"interrupt"'));

    expect(interrupts.length).toBeGreaterThanOrEqual(2);
    await backend.close();
  });

  test("exposes read-only SessionHistory with custom title, merged tool results, queued commands, and stable UUID cursors", async () => {
    const { backend, data } = await openFixtureBackend();

    const session = await backend.createSession({
      key: "k3",
      title: "history test",
      signal: AbortSignal.timeout(20_000),
    });

    const dir = join(data, "claude", "projects", "proj-a");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${session}.jsonl`);
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "custom-title",
          customTitle: "Incident triage",
        }),
        JSON.stringify({
          type: "user",
          uuid: "u-1",
          timestamp: "2026-11-27T10:00:00.000Z",
          message: { role: "user", content: "hello claude" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a-1",
          timestamp: "2026-11-27T10:00:01.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5-5",
            content: [
              { type: "thinking", thinking: "secret thought" },
              {
                type: "tool_use",
                id: "call_1",
                name: "Read",
                input: { file: "a.ts" },
              },
              { type: "text", text: "hi back" },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u-tool",
          timestamp: "2026-11-27T10:00:02.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: "file contents",
                is_error: false,
              },
            ],
          },
        }),
        JSON.stringify({
          type: "attachment",
          uuid: "att-1",
          timestamp: "2026-11-27T10:00:03.000Z",
          attachment: { type: "queued_command", prompt: "also check b.ts" },
        }),
      ].join("\n") + "\n",
    );

    const described = await backend.history.describe(
      [session, crypto.randomUUID()],
      AbortSignal.timeout(5000),
    );

    expect(described).toHaveLength(1);
    expect(described[0]?.id).toBe(session);
    expect(described[0]?.harness).toBe("claude");
    expect(described[0]?.title).toBe("Incident triage");
    expect(described[0]?.model).toBe("claude-opus-5-5");

    const full = await backend.history.entries(
      { sessionID: session, limit: 10, order: "asc", detail: "full" },
      AbortSignal.timeout(5000),
    );

    expect(full.entries.map((entry) => entry.id)).toEqual([
      "u-1",
      "a-1",
      "att-1",
    ]);
    expect(full.entries[1]?.parts[1]).toEqual({
      type: "tool",
      name: "Read",
      status: "completed",
      input: '{"file":"a.ts"}',
      output: "file contents",
    });
    expect(full.entries[2]).toMatchObject({
      id: "att-1",
      role: "user",
      parts: [{ type: "text", text: "also check b.ts" }],
    });

    // Stable UUID cursor in desc order does not repeat entries when new lines append.
    const page1 = await backend.history.entries(
      { sessionID: session, limit: 1, order: "desc", detail: "summary" },
      AbortSignal.timeout(5000),
    );

    expect(page1.entries.map((entry) => entry.id)).toEqual(["att-1"]);
    expect(page1.cursor).toBeDefined();

    await appendFile(
      file,
      `${JSON.stringify({
        type: "assistant",
        uuid: "a-2",
        timestamp: "2026-11-27T10:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "later reply" }],
        },
      })}\n`,
    );

    const page2 = await backend.history.entries(
      {
        sessionID: session,
        cursor: page1.cursor,
        limit: 2,
        order: "desc",
        detail: "summary",
      },
      AbortSignal.timeout(5000),
    );

    expect(page2.entries.map((entry) => entry.id)).toEqual(["a-1", "u-1"]);
    expect(page2.entries[0]?.parts[0]).toEqual({ type: "reasoning" });
    expect(page2.entries[0]?.parts[1]).toEqual({
      type: "tool",
      name: "Read",
      status: "completed",
    });

    await backend.close();
  });
});
