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
