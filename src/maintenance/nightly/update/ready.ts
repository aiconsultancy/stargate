import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { installationDirectory } from "../../../lib/installation-paths";
import { readMetadata } from "./release";

/**
 * Written by the gateway after every bot connected and workers started.
 * Maintenance waits for a record newer than its restart to confirm health.
 */
export const readySchema = z.strictObject({
  schema: z.literal("stargate.ready.v1"),
  pid: z.number().int().positive(),
  readyAt: z.number().int().positive(),
  /** Release version from `.stargate-release.json`, or null for a checkout. */
  version: z.string().nullable(),
  transportObservedAt: z.number().int().positive().optional(),
  transports: z
    .array(
      z.strictObject({
        kind: z.enum(["slack", "irc", "teams"]),
        id: z.string().min(1).max(256),
        state: z.enum([
          "connecting",
          "connected",
          "reconnecting",
          "failed",
          "closed",
        ]),
      }),
    )
    .max(1000)
    .optional(),
  updateNotices: z
    .array(
      z.strictObject({
        sessionID: z.string().min(1).max(256),
        status: z.enum(["queued", "mail", "unchanged", "uncertain"]),
      }),
    )
    .max(1000)
    .optional(),
});
export type Ready = z.infer<typeof readySchema>;

export const packageDirectory = installationDirectory;

export async function runningVersion(directory = packageDirectory) {
  return (await readMetadata(directory))?.version ?? null;
}

/**
 * Record that this process is ready. Returns the release version that it
 * runs, or null when its directory has no valid `.stargate-release.json`: then
 * maintenance cannot match the record with a release, and a readiness check
 * for a version never passes. The caller warns about null.
 */
export async function writeReady(
  dataDirectory: string,
  now = Date.now(),
  directory = packageDirectory,
  updateNotices: Ready["updateNotices"] = [],
  transports?: Ready["transports"],
) {
  const record: Ready = {
    schema: "stargate.ready.v1",
    pid: process.pid,
    readyAt: now,
    version: await runningVersion(directory),
    ...(transports ? { transports, transportObservedAt: Date.now() } : {}),
    ...(updateNotices.length ? { updateNotices } : {}),
  };
  const path = join(dataDirectory, "ready.json");
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temp, path);
  return record.version;
}

export async function readReady(dataDirectory: string) {
  try {
    return readySchema.parse(
      JSON.parse(await readFile(join(dataDirectory, "ready.json"), "utf8")),
    );
  } catch {
    return null;
  }
}

/** A live process wrote the record (same user: signal 0 succeeds). */
export function readyProcessAlive(record: Ready) {
  try {
    process.kill(record.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until the gateway writes a readiness record at or after `since`
 * (and, when given, for the expected release version).
 */
export async function waitReady(
  dataDirectory: string,
  since: number,
  version: string | undefined,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
) {
  const until = now() + timeoutMs;
  for (;;) {
    const record = await readReady(dataDirectory);
    if (
      record !== null &&
      record.readyAt >= since &&
      (!record.transports ||
        record.transports.some(
          (transport) => transport.state === "connected",
        )) &&
      (version === undefined || record.version === version)
    )
      return true;
    if (now() >= until) return false;
    await sleep(2000);
  }
}
