import { spawn } from "node:child_process";

/** Reads are bounded. A write is never killed by a timer: SIGKILL mid-write
 * can leave index.lock or a partial result. Only an explicit caller signal
 * stops it; ambiguous writes are reported, never retried or rolled back.
 */
export function gitProcessOptions(write: boolean, signal?: AbortSignal) {
  return {
    ...(signal && { signal }),
    ...(!write && { timeout: 60_000 }),
    killSignal: "SIGKILL" as const,
  };
}

export function spawnGit(
  directory: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
    write?: boolean;
  },
): Promise<{ stdout: string; code: number | null; truncated: boolean }> {
  const limit = options.limit ?? 1024 * 1024;

  return new Promise((resolve) => {
    const child = spawn("git", ["-C", directory, ...args], {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      ...gitProcessOptions(!!options.write, options.signal),
    });

    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    let failed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) {
        return;
      }

      if (length + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - length));
        truncated = true;
        child.kill("SIGKILL");

        return;
      }

      chunks.push(chunk);
      length += chunk.length;
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        code: failed ? null : code,
        truncated,
      });
    });
  });
}

/**
 * A bounded read whose output goes to `onData` as it arrives, with optional
 * standard input. `onData` returning false stops Git; the code is then null.
 */
export function streamGit(
  directory: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    signal: AbortSignal;
    onData: (chunk: Buffer) => boolean;
    input?: string | undefined;
  },
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", directory, ...args], {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      ...gitProcessOptions(false, options.signal),
    });

    let failed = false;
    let thrown: { error: unknown } | undefined;

    // A reader that stops early closes the pipe: ignore the broken write.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) {
        return;
      }

      let more = false;

      try {
        more = options.onData(chunk);
      } catch (error) {
        thrown = { error };
      }

      if (!more) {
        failed = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      if (thrown) {
        reject(thrown.error);
      } else {
        resolve(failed ? null : code);
      }
    });
  });
}
