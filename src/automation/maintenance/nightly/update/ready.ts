import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { settingsStruct } from "../../../../config/settings-schema";
import { installationDirectory } from "../../../../lib/installation-paths";
import { readMetadata } from "./release-record";

// Zod counted code points for string bounds; keep that unit.
const id = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(256),
);

const positive = Schema.Int.check(Schema.isGreaterThan(0));

const list = <S extends Schema.Top>(item: S) =>
  Schema.mutable(Schema.Array(item)).check(Schema.isMaxLength(1000));

const transport = settingsStruct({
  kind: Schema.Literals(["slack", "irc", "teams"]),
  id,
  state: Schema.Literals([
    "connecting",
    "connected",
    "reconnecting",
    "failed",
    "closed",
  ]),
});

const updateNotice = settingsStruct({
  sessionID: id,
  status: Schema.Literals(["queued", "mail", "unchanged", "uncertain"]),
});

/**
 * Written by the gateway after every bot connected and workers started.
 * Maintenance waits for a record newer than its restart to confirm health.
 */
export const readySchema = settingsStruct({
  schema: Schema.Literal("stargate.ready.v1"),
  pid: positive,
  readyAt: positive,
  /** Release version from `.stargate-release.json`, or null for a checkout. */
  version: Schema.NullOr(Schema.String),
  transportObservedAt: Schema.optional(positive),
  transports: Schema.optional(list(transport)),
  updateNotices: Schema.optional(list(updateNotice)),
});

export type Ready = typeof readySchema.Type;

const decodeReady = Schema.decodeUnknownOption(readySchema);

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
    ...(transports && { transports, transportObservedAt: Date.now() }),
    ...(updateNotices.length > 0 && { updateNotices }),
  };

  const path = join(dataDirectory, "ready.json");
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temp, path);

  return record.version;
}

export async function readReady(dataDirectory: string) {
  try {
    return Option.getOrNull(
      decodeReady(
        JSON.parse(await readFile(join(dataDirectory, "ready.json"), "utf8")),
      ),
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

function readyForRun(
  record: Ready,
  since: number,
  version: string | undefined,
) {
  return (
    record.readyAt >= since &&
    (!record.transports ||
      record.transports.some((transport) => transport.state === "connected")) &&
    (version === undefined || record.version === version)
  );
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

    if (record !== null && readyForRun(record, since, version)) return true;

    if (now() >= until) return false;
    await sleep(2000);
  }
}
