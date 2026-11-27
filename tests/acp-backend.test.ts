import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { AcpBackend, acpPromptBlocks } from "../src/backends/acp";
import { acpBackendSchema } from "../src/backends/config";
import { evaluateAcpPermission } from "../src/backends/acp/policy";
import type {
  ActivityItem,
  TurnActivityRecorder,
} from "../src/backends/backend";
import { createBackend } from "../src/backends/factory";
import {
  AttachmentInputUnavailable,
  BackendFailure,
} from "../src/shared/request-failure";

const fixture = join(import.meta.dir, "acp-fixture.ts");
const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratchDir() {
  const dir = await mkdtemp(join(tmpdir(), "stargate-acp-test-"));
  cleanup.push(dir);

  return dir;
}

function makeConfig(directory: string, extra: Record<string, unknown> = {}) {
  return Schema.decodeUnknownSync(acpBackendSchema)({
    type: "acp",
    directory,
    command: process.execPath,
    args: [fixture],
    ...extra,
  });
}

describe("ACP permission policy", () => {
  const options = [
    { optionId: "allow-once", kind: "allow_once", name: "Allow" },
    { optionId: "reject-once", kind: "reject_once", name: "Reject" },
  ];

  test("deny fails closed on every tool call", async () => {
    const dir = await scratchDir();

    const outcome = evaluateAcpPermission("deny", dir, [], {
      sessionId: "s1",
      toolCall: {
        toolCallId: "t1",
        kind: "read",
        locations: [{ path: "a.txt" }],
      },
      options,
    });

    expect(outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  test("workspace-write allows contained edits and blocks symlink escape and execute", async () => {
    const root = await scratchDir();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(workspace, "inside.txt"), "ok");
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(outside, join(workspace, "escape"));

    expect(
      evaluateAcpPermission("workspace-write", workspace, [], {
        sessionId: "s1",
        toolCall: {
          toolCallId: "t1",
          kind: "edit",
          locations: [{ path: "inside.txt" }],
        },
        options,
      }),
    ).toEqual({ outcome: "selected", optionId: "allow-once" });

    expect(
      evaluateAcpPermission("workspace-write", workspace, [], {
        sessionId: "s1",
        toolCall: {
          toolCallId: "t2",
          kind: "edit",
          locations: [{ path: "escape/secret.txt" }],
        },
        options,
      }),
    ).toEqual({ outcome: "selected", optionId: "reject-once" });

    expect(
      evaluateAcpPermission("workspace-write", workspace, [], {
        sessionId: "s1",
        toolCall: {
          toolCallId: "t3",
          kind: "execute",
          rawInput: { command: "rm -rf /" },
        },
        options,
      }),
    ).toEqual({ outcome: "selected", optionId: "reject-once" });
  });
});

describe("ACP backend", () => {
  test("streams visible text without reasoning, records activity, isolates env, and resumes sessions", async () => {
    const root = await scratchDir();
    const workspace = join(root, "work");
    const data = join(root, "data");
    const logPath = join(root, "fixture.ndjson");
    await mkdir(workspace, { recursive: true });

    process.env["STARGATE_ACP_TEST_SECRET"] = "top-secret-value";
    process.env["HOST_SECRET"] = "must-not-leak";

    try {
      const cfg = makeConfig(workspace, {
        model: "claude-sonnet-5-5",
        reasoningEffort: "high",
        mode: "default",
        env: { STARGATE_ACP_FIXTURE_LOG: logPath },
        secretEnv: { SECRET_FROM_ENV: "STARGATE_ACP_TEST_SECRET" },
      });

      const recorded: ActivityItem[] = [];
      let endedOutcome: string | undefined;

      const activity: TurnActivityRecorder = {
        begin: () => ({
          update: (_key, _at, create, change) => {
            const item = create();
            change?.(item);
            recorded.push(item);
          },
          reconnected: () => {},
          end: (outcome) => {
            endedOutcome = outcome;
          },
        }),
      };

      const backend = await createBackend(cfg, {
        dataDirectory: data,
        activity,
      });

      const session = await backend.createSession({
        key: "k1",
        title: "t1",
        signal: new AbortController().signal,
      });

      const previews: string[] = [];

      const answer1 = await backend.prompt(
        session,
        "hi",
        new AbortController().signal,
        (text) => previews.push(text),
      );

      expect(answer1).toBe("Hello world!");
      expect(previews).toEqual(["Hello ", "Hello world!"]);
      expect(endedOutcome).toBe("completed");
      expect(recorded.some((item) => item.kind === "reasoning")).toBe(true);
      expect(recorded.some((item) => item.kind === "text")).toBe(true);

      // Second turn resumes the persisted native session and suppresses replay text.
      const answer2 = await backend.prompt(
        session,
        "follow up",
        new AbortController().signal,
      );

      expect(answer2).toBe("Hello world!");

      const entries = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const firstStart = entries.find((entry) => entry["type"] === "start");
      const env = (firstStart?.["env"] ?? {}) as Record<string, unknown>;
      expect(env["SECRET_FROM_ENV"]).toBe("top-secret-value");
      expect(env["HOST_SECRET"]).toBeUndefined();
      expect(
        entries.some(
          (entry) =>
            entry["type"] === "request" && entry["method"] === "session/load",
        ),
      ).toBe(true);

      await backend.close();
    } finally {
      delete process.env["STARGATE_ACP_TEST_SECRET"];
      delete process.env["HOST_SECRET"];
    }
  });

  test("handles session/load replay stall without leaking replayed text", async () => {
    const root = await scratchDir();
    const workspace = join(root, "work");
    const data = join(root, "data");
    await mkdir(workspace, { recursive: true });

    const cfg = makeConfig(workspace, {
      env: { STARGATE_ACP_FIXTURE_SCENARIO: "replay-stall" },
    });

    const backend = await AcpBackend.open(
      cfg,
      { dataDirectory: data },
      { replayIdleMs: 80, startupTimeoutMs: 5000 },
    );

    const session = await backend.createSession({
      key: "k1",
      title: "t1",
      signal: new AbortController().signal,
    });

    await backend.prompt(session, "first", new AbortController().signal);

    const second = await backend.prompt(
      session,
      "second",
      new AbortController().signal,
    );

    expect(second).toBe("Hello world!");
    await backend.close();
  });

  test("enforces permissionPolicy over live session/request_permission", async () => {
    const root = await scratchDir();
    const workspace = join(root, "work");
    const data = join(root, "data");
    await mkdir(workspace, { recursive: true });

    const denyBackend = await AcpBackend.open(
      makeConfig(workspace, {
        permissionPolicy: "deny",
        env: {
          STARGATE_ACP_FIXTURE_SCENARIO: "permission-check",
          STARGATE_ACP_TEST_TARGET_PATH: "ok.txt",
        },
      }),
      { dataDirectory: data },
    );

    const s1 = await denyBackend.createSession({
      key: "k1",
      title: "t1",
      signal: new AbortController().signal,
    });

    expect(
      await denyBackend.prompt(s1, "edit", new AbortController().signal),
    ).toBe("decision:reject-once");
    await denyBackend.close();

    const writeBackend = await AcpBackend.open(
      makeConfig(workspace, {
        permissionPolicy: "workspace-write",
        env: {
          STARGATE_ACP_FIXTURE_SCENARIO: "permission-check",
          STARGATE_ACP_TEST_TARGET_PATH: "ok.txt",
        },
      }),
      { dataDirectory: join(root, "data2") },
    );

    const s2 = await writeBackend.createSession({
      key: "k2",
      title: "t2",
      signal: new AbortController().signal,
    });

    expect(
      await writeBackend.prompt(s2, "edit", new AbortController().signal),
    ).toBe("decision:allow-once");
    await writeBackend.close();
  });

  test("cancels active turn via session/cancel on AbortSignal", async () => {
    const root = await scratchDir();
    const workspace = join(root, "work");
    const data = join(root, "data");
    const logPath = join(root, "cancel.ndjson");
    await mkdir(workspace, { recursive: true });

    const backend = await AcpBackend.open(
      makeConfig(workspace, {
        env: {
          STARGATE_ACP_FIXTURE_SCENARIO: "slow-cancel",
          STARGATE_ACP_FIXTURE_LOG: logPath,
        },
      }),
      { dataDirectory: data },
      { graceMs: 1000 },
    );

    const session = await backend.createSession({
      key: "k1",
      title: "t1",
      signal: new AbortController().signal,
    });

    const controller = new AbortController();

    const pending = backend.prompt(session, "run", controller.signal, () => {
      controller.abort();
    });

    await expect(pending).rejects.toThrow();
    const logText = await readFile(logPath, "utf8");
    expect(logText).toContain("session/cancel");
    await backend.close();
  });

  test("copilot flavor filters subagent deltas and clears lost sessions", async () => {
    const root = await scratchDir();
    const workspace = join(root, "work");
    const data = join(root, "data");
    await mkdir(workspace, { recursive: true });

    const subBackend = await AcpBackend.open(
      makeConfig(workspace, {
        flavor: "copilot",
        env: { STARGATE_ACP_FIXTURE_SCENARIO: "copilot-subagent" },
      }),
      { dataDirectory: data },
    );

    const s1 = await subBackend.createSession({
      key: "k1",
      title: "t1",
      signal: new AbortController().signal,
    });

    expect(
      await subBackend.prompt(s1, "go", new AbortController().signal),
    ).toBe("Hello world!");
    await subBackend.close();

    const lostBackend = await AcpBackend.open(
      makeConfig(workspace, {
        flavor: "copilot",
        env: { STARGATE_ACP_FIXTURE_SCENARIO: "copilot-lost-session" },
      }),
      { dataDirectory: join(root, "data2") },
    );

    const s2 = await lostBackend.createSession({
      key: "k2",
      title: "t2",
      signal: new AbortController().signal,
    });

    await expect(
      lostBackend.prompt(s2, "go", new AbortController().signal),
    ).rejects.toBeInstanceOf(BackendFailure);
    await lostBackend.close();
  });

  test("encodes image and text attachments and rejects unsupported binaries", () => {
    const blocks = acpPromptBlocks("check this", [
      {
        name: "note.txt",
        mime: "text/plain",
        data: Buffer.from("hello"),
      },
      {
        name: "pic.png",
        mime: "image/png",
        data: Buffer.from([1, 2, 3]),
      },
    ]);

    expect(blocks).toEqual([
      { type: "text", text: "Attachment: note.txt\nhello" },
      {
        type: "image",
        data: Buffer.from([1, 2, 3]).toString("base64"),
        mimeType: "image/png",
      },
      { type: "text", text: "check this" },
    ]);

    expect(() =>
      acpPromptBlocks("bad", [
        {
          name: "archive.zip",
          mime: "application/zip",
          data: Buffer.from([1]),
        },
      ]),
    ).toThrow(AttachmentInputUnavailable);
  });
});
