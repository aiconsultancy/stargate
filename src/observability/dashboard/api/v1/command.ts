const outputLimit = 1024 * 1024;

/** Run a read-only command without retaining diagnostic output. */
export async function readCommand(
  command: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    signal?: AbortSignal;
  },
): Promise<{ code: number; stdout: string } | null> {
  try {
    const child = Bun.spawn(command, {
      ...options,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      killSignal: "SIGKILL",
    });

    const decoder = new TextDecoder();
    let bytes = 0;
    let stdout = "";

    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength;

      if (bytes > outputLimit) {
        child.kill("SIGKILL");
        await child.exited;

        return null;
      }

      stdout += decoder.decode(chunk, { stream: true });
    }

    const code = await child.exited;

    return { code, stdout: stdout + decoder.decode() };
  } catch {
    return null;
  }
}
