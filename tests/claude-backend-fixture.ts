import { afterEach, beforeEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Predicate, Schema, SchemaTransformation } from "effect";
import type { TurnActivityRecorder } from "../src/backends/backend";
import { ClaudeBackend, type ClaudeRuntime } from "../src/backends/claude";
import { claudeBackendSchema } from "../src/config";
import { zodStringRecord } from "./fixtures/zod-string-record";

export const apiKeyEnv = "STARGATE_CLAUDE_TEST_PROXY_KEY";
export const key = "local-proxy-test-only";
const fixture = join(import.meta.dir, "claude-fixture.ts");

// Host secrets that must never reach the Claude Code child.
export const hostSecrets = {
  ANTHROPIC_API_KEY: "native-key-must-not-be-sent",
  ANTHROPIC_AUTH_TOKEN: "native-token-must-not-be-sent",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1/native",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-must-not-be-sent",
  CLAUDE_CONFIG_DIR: "/host/.claude",
  OPENAI_API_KEY: "openai-must-not-be-sent",
  CLIPROXYAPI_API_KEY: "proxy-key-only-by-reference",
  STARGATE_TEST_BOT_TOKEN: "xoxb-must-not-be-sent",
  HTTPS_PROXY: "http://127.0.0.1:2",
  NODE_OPTIONS: "--require /host/hook.js",
};

export function config(
  extra: Record<string, unknown> = {},
  directory = "/workspace",
) {
  return Schema.decodeUnknownSync(claudeBackendSchema)({
    type: "claude",
    directory,
    model: "claude-sonnet-5-5",
    provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv },
    ...extra,
  });
}

// Loose objects accept instances with a valid `type` and keep enumerable
// String extras (including inherited ones), except __proto__.
const looseLogInput = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transform({
      decode: (input) => {
        if (!Predicate.isObject(input)) {
          return input;
        }

        const copy: Record<string, unknown> = { type: input["type"] };

        for (const key in input) {
          if (key !== "type" && key !== "__proto__") {
            copy[key] = input[key];
          }
        }

        return copy;
      },
      encode: (input) => input,
    }),
  ),
  Schema.decodeTo(
    Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
);

const decodeLogEntry = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({
      pid: Schema.Finite,
      argv: Schema.Array(Schema.String),
      env: zodStringRecord(Schema.String),
      cwd: Schema.String,
    }),
    Schema.Struct({ input: looseLogInput }),
    Schema.Struct({ grandchild: Schema.Finite }),
  ]),
);

export function claudeBackendFixture() {
  const saved = new Map<string, string | undefined>();
  const cleanup: (() => Promise<unknown>)[] = [];

  beforeEach(() => {
    for (const name of [apiKeyEnv, ...Object.keys(hostSecrets)]) {
      saved.set(name, process.env[name]);
    }

    Object.assign(process.env, hostSecrets, { [apiKeyEnv]: key });
  });

  afterEach(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    for (const step of cleanup.splice(0).reverse()) {
      await step();
    }
  });

  async function open(
    extra: Record<string, unknown> = {},
    version = "2.1.327 (Claude Code)",
    runtime: Pick<ClaudeRuntime, "versionTimeoutMs"> = {},
    activity?: TurnActivityRecorder,
  ) {
    const root = await mkdtemp(join(tmpdir(), "stargate-claude-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, "claude");
    await writeFile(join(root, "fixture-version"), version);
    await writeFile(
      executable,
      `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
      { mode: 0o755 },
    );
    const dataDirectory = join(root, "data");
    await mkdir(dataDirectory);

    const backend = await ClaudeBackend.open(
      config(extra, root),
      { dataDirectory, ...(activity && { activity }) },
      { executable, graceMs: 200, ...runtime },
    );

    cleanup.push(() => backend.close());

    const log = async () =>
      (await readFile(join(dataDirectory, "claude", "fixture.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => decodeLogEntry(JSON.parse(line)));

    const runs = async () =>
      (await log()).flatMap((entry) => ("argv" in entry ? [entry] : []));

    return { root, dataDirectory, executable, backend, log, runs };
  }

  return { open, cleanup };
}

export const signal = () => AbortSignal.timeout(20_000);

export const session = (backend: ClaudeBackend) =>
  backend.createSession({ key: "k", title: "Stargate test", signal: signal() });

export function alive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

export async function until(
  check: () => Promise<boolean> | boolean,
  ms = 10_000,
) {
  const deadline = Date.now() + ms;

  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Condition not reached");
    }

    await delay(25);
  }
}
