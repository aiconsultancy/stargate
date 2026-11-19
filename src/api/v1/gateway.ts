import packageManifest from "../../../package.json";
import { runningVersion } from "../../nightly/ready";

/**
 * The version a fleet reports: the installed release's own record
 * (`.stargate-release.json`), or the package version in a source checkout.
 */
export async function gatewayVersion(directory?: string): Promise<string> {
  return (await runningVersion(directory)) ?? packageManifest.version;
}

const versionCacheMs = 10 * 60_000;
const versionDeadlineMs = 1500;

export type OpenCodeVersionLookup = (
  signal: AbortSignal,
) => Promise<string | null>;

export function cacheOpenCodeVersion(
  lookup: OpenCodeVersionLookup,
  shutdown: AbortSignal,
) {
  let cached: Promise<string | null> | undefined;
  let expiresAt = 0;
  return () => {
    if (shutdown.aborted) return Promise.resolve(null);
    if (!cached || performance.now() >= expiresAt) {
      expiresAt = Infinity;
      cached = probeVersion(lookup, shutdown).finally(() => {
        expiresAt = performance.now() + versionCacheMs;
      });
    }
    return cached;
  };
}

async function probeVersion(
  lookup: OpenCodeVersionLookup,
  shutdown: AbortSignal,
) {
  const signal = AbortSignal.any([
    shutdown,
    AbortSignal.timeout(versionDeadlineMs),
  ]);
  let abort = () => {};
  try {
    const deadline = new Promise<null>((resolve) => {
      abort = () => resolve(null);
      signal.addEventListener("abort", abort, { once: true });
    });
    const version = await Promise.race([
      deadline,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return lookup(signal);
      }),
    ]);
    return version && /^[0-9][0-9A-Za-z.+-]{0,79}$/.test(version)
      ? version
      : null;
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
