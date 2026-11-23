import { packageManifest } from "../../../lib/installation-paths";
import {
  packageDirectory,
  runningVersion,
} from "../../../maintenance/nightly/update/ready";

const noop = () => {};

const releaseTag = /^v(\d+\.\d+\.\d+)$/;

/** The release tag at HEAD of a git checkout, without its `v`; else null. */
async function checkoutTagVersion(directory: string): Promise<string | null> {
  try {
    const child = Bun.spawn(
      ["git", "-C", directory, "tag", "--points-at", "HEAD"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );

    const timer = setTimeout(() => child.kill(), 2000);

    const [output, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);

    clearTimeout(timer);

    if (code !== 0) return null;

    const versions = output
      .split("\n")
      .map((tag) => releaseTag.exec(tag.trim())?.[1])
      .filter((version): version is string => version !== undefined);

    return versions.length === 1 ? (versions[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The version a fleet reports: the installed release's own record
 * (`.stargate-release.json`); else, in a git checkout of a release, the
 * single `vX.Y.Z` tag at HEAD; else the package version.
 */
export async function gatewayVersion(
  directory: string = packageDirectory,
): Promise<string> {
  return (
    (await runningVersion(directory)) ??
    (await checkoutTagVersion(directory)) ??
    packageManifest.version
  );
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

  let abort = noop;

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
