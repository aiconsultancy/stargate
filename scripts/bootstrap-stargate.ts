/** Explicit one-time entry point for an updater that cannot read the new format. */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../src/config";
import { processRunner } from "../src/nightly/exec";
import {
  githubHeaders,
  githubToken,
  namedRelease,
  stageRelease,
  switchCurrent,
  verifyOrigin,
} from "../src/nightly/release";
import { loadEnvironment } from "../src/runtime";

export async function bootstrapRelease(
  input: Parameters<typeof stageRelease>[0] & { commit: string },
) {
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(input.commit);
  for (const link of ["current", "previous"]) {
    const exists = await lstat(join(input.config.root, link)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists)
      throw new Error(
        "Bootstrap requires a root without current or previous links.",
      );
  }
  if (!input.config.requireTreeCheck || !input.config.checkout)
    throw new Error("Bootstrap requires a local checkout tree comparison.");
  if (
    (await verifyOrigin(input.config, input.release, input.headers)) !==
    input.commit
  )
    throw new Error("Bootstrap tag does not match the operator-pinned commit.");
  const staged = await stageRelease(input);
  if (
    staged.metadata.commit !== input.commit ||
    staged.metadata.tree !== "equal"
  )
    throw new Error(
      "Bootstrap staged release does not match the pinned source.",
    );
  await switchCurrent(input.config.root, input.release.version);
  return staged;
}

if (import.meta.main) {
  try {
    const [configPath, version, commit, extra] = process.argv.slice(2);
    if (!configPath || !version || !commit || extra)
      throw new Error("Expected config path, version and full commit.");
    await loadEnvironment(configPath);
    const config = await loadConfig(configPath);
    const settings = config.maintenance?.stargate;
    if (!settings)
      throw new Error("Configure maintenance.stargate before bootstrap.");
    const headers = githubHeaders(
      await githubToken(settings.tokenEnv, processRunner),
    );
    const release = await namedRelease(settings, headers, version);
    await bootstrapRelease({
      config: settings,
      release,
      headers,
      commit,
      runner: processRunner,
      runID: crypto.randomUUID(),
      remaining: () => 45 * 60_000,
      signal: AbortSignal.timeout(45 * 60_000),
    });
    console.log(
      "Verified Stargate release installed. No service was started; complete the offline state cutover before activation.",
    );
  } catch {
    console.error(
      "Stargate bootstrap failed. No service was started. Check the pinned release, private config and empty managed root; raw details withheld.",
    );
    process.exitCode = 1;
  }
}
