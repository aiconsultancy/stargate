/**
 * Antigravity ACP protocol and profile helpers. Adapted from T3 Code
 * `apps/server/src/provider/acp/AntigravityAcpSupport.ts` and
 * `apps/server/src/provider/antigravityAuthSupport.ts`
 * (MIT License, Copyright 2026 T3 Tools Inc.).
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Predicate } from "effect";
import { secret } from "../../lib/credentials";
import { BackendFailure } from "../../shared/request-failure";
import { inherited } from "../cli-agent";
import {
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpModeState,
  AcpRpcError,
  asRecord,
} from "../acp/protocol";
import type {
  AntigravityAuthConfig,
  AntigravityBackendConfig,
} from "../config";

/** `agy acp` 1.5.1+ exposes every account model to any ACP client. */
export const OPEN_MODEL_ACCESS_RELEASE = [1, 5, 1] as const;

export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  "Open the following link to authenticate the ACP server: ";

const NATIVE_CLI_NO_BROWSER_PREFIX = "No browser available";

export function parseAntigravityVersion(
  raw: string | null | undefined,
): readonly [number, number, number] | undefined {
  const match = /^(?:v|agy_acp_server_)?(\d+)\.(\d+)\.(\d+)/.exec(
    raw?.trim() ?? "",
  );

  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

export function antigravityVersionSupported(raw: string): boolean {
  const parsed = parseAntigravityVersion(raw);

  if (parsed === undefined) {
    return false;
  }

  for (let index = 0; index < 3; index++) {
    const left = parsed[index] ?? 0;
    const right = OPEN_MODEL_ACCESS_RELEASE[index] ?? 0;

    if (left !== right) {
      return left > right;
    }
  }

  return true;
}

export function antigravityAppendsSystemPrompt(
  init: AcpInitializeResult,
): boolean {
  const ext = asRecord(init.agentCapabilities?._meta?.["antigravity"]);
  const prompt = asRecord(ext?.["systemPrompt"]);

  return Predicate.isObject(prompt) && prompt["append"] === true;
}

export function antigravitySessionMeta(
  init: AcpInitializeResult,
  systemPrompt?: string,
): Record<string, unknown> | undefined {
  return systemPrompt !== undefined && antigravityAppendsSystemPrompt(init)
    ? { antigravity: { systemPrompt: { append: systemPrompt } } }
    : undefined;
}

/**
 * Always run Antigravity in `default` session mode so `agy` asks before every
 * tool action and Stargate's fail-closed `clientPolicy` decides live.
 */
export function antigravitySessionMode(
  _modeId: string,
  _state: AcpModeState | undefined,
): string {
  return "default";
}

export function antigravityModelChoices(
  options: readonly AcpConfigOption[],
): string[] {
  const model = options.find((option) => option.id === "model");

  if (model?.type !== "select") {
    return [];
  }

  const values: string[] = [];

  for (const entry of model.options ?? []) {
    if ("value" in entry) {
      values.push(entry.value);
    } else {
      for (const nested of entry.options) {
        values.push(nested.value);
      }
    }
  }

  return values;
}

export function resolveAntigravityModel(
  options: readonly AcpConfigOption[],
  requested: string | undefined,
): string | undefined {
  if (requested === undefined) {
    return undefined;
  }

  const choices = antigravityModelChoices(options);

  if (choices.length === 0 || choices.includes(requested)) {
    return requested;
  }

  // Legacy 1.3-style `family-level` IDs still map to their family prefix.
  const prefix = choices
    .filter((family) => requested.startsWith(`${family}-`))
    .toSorted((left, right) => right.length - left.length)[0];

  return prefix ?? requested;
}

export function isAntigravitySignInRequiredError(error: unknown): boolean {
  return (
    error instanceof AcpRpcError &&
    (error.code === -32_000 ||
      (error.code === -32_603 &&
        error.errorMessage.startsWith(NATIVE_CLI_NO_BROWSER_PREFIX)))
  );
}

export function antigravityProfileSettings(
  auth: AntigravityAuthConfig,
): string {
  const settings: Record<string, unknown> = {
    auth: { type: auth.method },
  };

  if (auth.method === "oauth-business" || auth.method === "agent-platform") {
    const gcp: Record<string, string> = {};

    if (auth.gcpProject) {
      gcp["project"] = auth.gcpProject;
    }

    if (auth.gcpLocation) {
      gcp["location"] = auth.gcpLocation;
    }

    if (Object.keys(gcp).length > 0) {
      settings["gcp"] = gcp;
    }
  }

  return `${JSON.stringify(settings)}\n`;
}

export type AntigravityProfile = {
  readonly geminiHome: string;
  readonly acpDirectory: string;
  readonly tempDirectory: string;
};

export async function prepareAntigravityProfile(
  root: string,
  auth: AntigravityAuthConfig,
): Promise<AntigravityProfile> {
  const geminiHome = join(root, "antigravity");
  const acpDirectory = join(geminiHome, "antigravity-acp");
  const tempDirectory = join(acpDirectory, "tmp");

  for (const directory of [geminiHome, acpDirectory, tempDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  await writeFile(
    join(acpDirectory, "settings.json"),
    antigravityProfileSettings(auth),
    { mode: 0o600 },
  );

  return { geminiHome, acpDirectory, tempDirectory };
}

/**
 * Minimal child environment for `agy acp`: inherits only the non-secret base
 * allowlist from `inherited()` (ambient `GEMINI_API_KEY` and `GOOGLE_*`
 * variables are excluded automatically), pins private `GEMINI_HOME` and
 * `TMPDIR`, disables auto-update and suppresses interactive browser launches.
 */
export function antigravityEnvironment(
  config: AntigravityBackendConfig,
  profile: AntigravityProfile,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    ...inherited(parent),
  };

  if (config.auth.method === "gemini-api-key") {
    env["GEMINI_API_KEY"] = secret(config.auth.apiKeyEnv, parent);
  } else if (config.auth.method === "agent-platform") {
    if (config.auth.apiKeyEnv !== undefined) {
      env["GEMINI_API_KEY"] = secret(config.auth.apiKeyEnv, parent);
    }

    if (config.auth.gcpProject !== undefined) {
      env["GOOGLE_CLOUD_PROJECT"] = config.auth.gcpProject;
    }

    if (config.auth.gcpLocation !== undefined) {
      env["GOOGLE_CLOUD_LOCATION"] = config.auth.gcpLocation;
    }
  } else if (config.auth.method === "oauth-business") {
    env["GOOGLE_CLOUD_PROJECT"] = config.auth.gcpProject;
    env["GOOGLE_CLOUD_LOCATION"] = config.auth.gcpLocation;
  }

  env["HOME"] = profile.geminiHome;
  env["XDG_CONFIG_HOME"] = join(profile.geminiHome, ".config");
  env["XDG_DATA_HOME"] = join(profile.geminiHome, ".local", "share");
  env["XDG_CACHE_HOME"] = join(profile.geminiHome, ".cache");
  env["GEMINI_HOME"] = profile.geminiHome;
  env["AGY_ACP_FORCE_FILE_STORAGE"] = "1";
  env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true";
  env["PYTHONUNBUFFERED"] = "1";
  env["TMPDIR"] = profile.tempDirectory;
  env["BROWSER"] = "/bin/false";

  return env;
}

export function antigravitySpawnArgs(
  config: AntigravityBackendConfig,
  profile: AntigravityProfile,
): string[] {
  return [
    "acp",
    "--gemini-dir",
    profile.geminiHome,
    "--app-data-dir",
    "antigravity-acp",
    ...(config.sandbox ? ["--sandbox"] : []),
    ...(config.disableTelemetry ? ["--disable-telemetry"] : []),
  ];
}

export function verifyAntigravityExecutable(
  executable: string,
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      {
        cwd,
        env,
        signal,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      },
      (error, stdout) => {
        if (error) {
          reject(new BackendFailure("provider", { ran: false }));

          return;
        }

        const version = stdout.trim();

        if (!antigravityVersionSupported(version)) {
          reject(new BackendFailure("provider", { ran: false }));

          return;
        }

        resolve(version);
      },
    );
  });
}
