import { isLocalhost } from "../../lib/loopback";

/**
 * Every external command in maintenance goes through this runner, so tests
 * can replace it. Output is returned to the caller only; never log stderr:
 * installers and SDKs can echo tokens or private paths.
 */
export type CommandResult = { code: number; stdout: string; stderr: string };

export type CommandOptions = {
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** False: the child gets only `env` (for untrusted release code). */
  inheritEnv?: boolean;
};

export interface CommandRunner {
  run(
    command: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult>;
}

const limit = 1024 * 1024;

async function capped(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of stream) {
    if (text.length < limit) text += decoder.decode(chunk, { stream: true });
  }

  return text.slice(0, limit);
}

export const processRunner: CommandRunner = {
  async run(command, options) {
    try {
      const child = Bun.spawn([...command], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env:
          options.inheritEnv === false
            ? { ...options.env }
            : { ...process.env, ...options.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: options.timeoutMs,
        killSignal: "SIGTERM",
      });

      const [stdout, stderr, code] = await Promise.all([
        capped(child.stdout),
        capped(child.stderr),
        child.exited,
      ]);

      return { code, stdout, stderr };
    } catch {
      // Missing executable: a failure like any other, without raw details.
      return { code: 127, stdout: "", stderr: "" };
    }
  },
};

/** A safe, fixed-reason failure. Messages never contain command output. */
export class StepError extends Error {
  public constructor(public readonly reason: Reason) {
    super(reason);
  }
}

export const reasons = [
  "outside-window",
  "window-too-short",
  "deadline",
  "locked",
  "busy-gateway",
  "busy-cron",
  "busy-crew",
  "busy-pi",
  "busy-opencode",
  "pending-input",
  "idle-unknown",
  "network",
  "not-found",
  "cool-off",
  "credentials-unavailable",
  "checksum-mismatch",
  "author-mismatch",
  "tag-not-on-branch",
  "tree-mismatch",
  "archive-invalid",
  "install-failed",
  "tests-failed",
  "switch-failed",
  "restart-failed",
  "readiness-failed",
  "health-failed",
  "plugins-failed",
  "version-mismatch",
  "migration-required",
  "probe-failed",
  "catalog-missing",
  "new-product",
  "config-format",
  "session-switch-failed",
  "command-failed",
  "timeout",
  "not-configured",
  "aborted",
  "recovery-required",
  "known-bad",
  "external-change",
  "unknown",
] as const;

export type Reason = (typeof reasons)[number];

export function reasonOf(error: unknown): Reason {
  return error instanceof StepError ? error.reason : "unknown";
}

/** Runs a command; non-zero exit becomes the given safe reason. */
export async function must(
  runner: CommandRunner,
  command: readonly string[],
  options: CommandOptions,
  reason: Reason = "command-failed",
) {
  const result = await runner.run(command, options);

  if (result.code !== 0) throw new StepError(reason);

  return result;
}

export type RequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const loopback = (url: URL) =>
  url.protocol === "http:" && isLocalhost(url.hostname);

/**
 * HTTP with manual redirects. Credentials (`authorization`, `x-api-key`)
 * are sent only to the first origin and dropped on any cross-origin hop.
 * Redirect targets must be HTTPS, or HTTP on loopback (local fixtures).
 * Non-GET requests never follow a redirect.
 */
export async function request(url: string, options: RequestOptions = {}) {
  const { timeoutMs = 30_000 } = options;

  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let target = new URL(url);
  let headers = { ...options.headers };

  for (let hop = 0; hop < 6; hop++) {
    let response: Response;

    try {
      response = await fetch(target, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        redirect: "manual",
        signal,
      });
    } catch {
      throw new StepError("network");
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");

    if ((options.method ?? "GET") !== "GET" || !location)
      throw new StepError("network");
    const next = new URL(location, target);

    if (next.protocol !== "https:" && !loopback(next))
      throw new StepError("network");

    if (next.origin !== target.origin) {
      const { authorization: _a, "x-api-key": _k, ...rest } = headers;
      headers = rest;
    }

    target = next;
  }

  throw new StepError("network");
}

/** JSON over HTTP with a timeout; failures map to safe reasons. */
export async function fetchJSON(
  url: string,
  init: RequestOptions = {},
): Promise<unknown> {
  const response = await fetchOK(url, init);

  try {
    return await response.json();
  } catch {
    throw new StepError("network");
  }
}

export async function fetchOK(url: string, init: RequestOptions = {}) {
  const response = await request(url, init);

  if (response.status === 404) throw new StepError("not-found");

  if (!response.ok) throw new StepError("network");

  return response;
}
