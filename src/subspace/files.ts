import { randomBytes } from "node:crypto";
import { type Stats, constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Result, Schema } from "effect";
import type { SubspaceAgentsConfig } from "../config/composition";
import {
  type AgentKey,
  type AgentKeyAlgorithm,
  BundleError,
  bundleText,
  generateAgentKey,
  parseBundle,
} from "./certificate";

export type SubspaceOfficer = SubspaceAgentsConfig["officers"][number];

/**
 * A refusal about the gateway's own files. Messages name the officer, never
 * a file's content; paths are left out because they can carry secrets.
 */
export class SubspaceFileError extends Error {}

function uid() {
  if (typeof process.getuid !== "function") {
    throw new SubspaceFileError("Subspace agent keys need a POSIX platform");
  }

  return process.getuid();
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}

/**
 * Whoever can write a directory above a key can swap it, so every ancestor
 * must be a real directory owned by root or the gateway user and writable by
 * neither group nor others, unless sticky (as `/tmp` is).
 */
export function checkAncestors(directory: string) {
  let current = directory;

  while (current !== dirname(current)) {
    current = dirname(current);
    let stats: Stats;

    try {
      stats = lstatSync(current);
    } catch {
      throw new SubspaceFileError(
        "A directory above the Subspace agent keys is missing or unreadable",
      );
    }

    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (stats.uid !== 0 && stats.uid !== uid()) ||
      (stats.mode & 0o022 && !(stats.mode & 0o1000))
    ) {
      throw new SubspaceFileError(
        "A directory above the Subspace agent keys is a link, or is owned or writable by another user",
      );
    }
  }
}

/** The state directory: created 0700 when absent, refused unless private. */
export async function privateStateDirectory(directory: string) {
  if (!(await lstatOrUndefined(directory))) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  checkAncestors(directory);
  const stats = await lstat(directory);

  if (
    !stats.isDirectory() ||
    stats.uid !== uid() ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new SubspaceFileError(
      "The Subspace agent state directory must be owned by the gateway user and private to it (mode 0700)",
    );
  }
}

/** An explicitly placed bundle's directory: the gateway's, and only it may write. */
async function bundleDirectory(directory: string, officer: string) {
  checkAncestors(directory);
  const stats = await lstatOrUndefined(directory);

  if (
    !stats?.isDirectory() ||
    stats.uid !== uid() ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new SubspaceFileError(
      `The directory of ${officer}'s Subspace bundle must exist, be owned by the gateway user and be writable by it alone`,
    );
  }
}

/**
 * A private file's text, or undefined when it does not exist. It must be a
 * regular file (never followed through a link), owned by the gateway user,
 * with no group or other access, and at most `maxBytes`.
 */
export async function readPrivateFile(
  path: string,
  maxBytes: number,
  what: string,
): Promise<string | undefined> {
  let file;

  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw new SubspaceFileError(`${what} is unreadable or a link`);
  }

  try {
    const stats = await file.stat();

    if (
      !stats.isFile() ||
      stats.uid !== uid() ||
      (stats.mode & 0o077) !== 0 ||
      stats.size > maxBytes
    ) {
      throw new SubspaceFileError(
        `${what} must be a regular file owned by the gateway user, readable by it alone (mode 0600), of at most ${maxBytes} bytes`,
      );
    }

    return await file.readFile({ encoding: "utf8" });
  } finally {
    await file.close();
  }
}

/** Write private text by rename, so a reader never sees half a file. */
export async function writePrivateFile(path: string, text: string) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );

  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );

  try {
    await file.writeFile(text, { encoding: "utf8" });
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const maxBundleBytes = 64 * 1024;

export type OfficerFiles = { bundle: string; record: string };

export function defaultStateDirectory(dataDirectory: string) {
  return join(dataDirectory, "subspace-agents");
}

/** Where an officer's bundle and enrolment record live. */
export function officerFiles(
  officer: SubspaceOfficer,
  stateDirectory: string,
): OfficerFiles {
  const bundle =
    officer.bundlePath ?? join(stateDirectory, `${officer.name}.pem`);

  return { bundle, record: `${bundle}.enrolment.json` };
}

/** The officer's key from its private bundle; undefined when there is none. */
export async function readOfficerKey(
  officer: SubspaceOfficer,
  files: OfficerFiles,
): Promise<AgentKey | undefined> {
  if (officer.bundlePath) {
    await bundleDirectory(dirname(files.bundle), officer.name);
  }

  const text = await readPrivateFile(
    files.bundle,
    maxBundleBytes,
    `${officer.name}'s Subspace bundle`,
  );

  if (text === undefined) {
    return;
  }

  try {
    return parseBundle(text);
  } catch (error) {
    throw new SubspaceFileError(
      `${officer.name}'s Subspace bundle: ${error instanceof BundleError ? error.message : "unreadable"}`,
    );
  }
}

/** A new key for the officer, written privately in place of any bundle. */
export async function writeOfficerKey(
  officer: SubspaceOfficer,
  files: OfficerFiles,
  algorithm: AgentKeyAlgorithm,
  key = generateAgentKey(officer.name, algorithm),
) {
  if (officer.bundlePath) {
    await bundleDirectory(dirname(files.bundle), officer.name);
  }

  await writePrivateFile(files.bundle, bundleText(key));

  return key;
}

/**
 * The API allows a certificate for one agent only, so two officers never
 * share one, even as copies in separate files.
 */
export class DistinctCertificates {
  private readonly holders = new Map<string, string>();

  public add(officer: string, key: AgentKey) {
    const other = this.holders.get(key.fingerprint);

    if (other !== undefined && other !== officer) {
      throw new SubspaceFileError(
        `${other} and ${officer} have the same certificate; each officer needs its own`,
      );
    }

    this.holders.set(key.fingerprint, officer);
  }
}

const recordSchema = Schema.Struct({
  fingerprint: Schema.String,
  agentId: Schema.String,
  credentialId: Schema.String,
  audience: Schema.String,
  enrolledAt: Schema.String,
});

export type EnrolmentRecord = typeof recordSchema.Type;

/** The officer's last enrolment, or undefined when absent or unreadable. */
export async function readEnrolmentRecord(
  officer: SubspaceOfficer,
  files: OfficerFiles,
): Promise<EnrolmentRecord | undefined> {
  const text = await readPrivateFile(
    files.record,
    maxBundleBytes,
    `${officer.name}'s Subspace enrolment record`,
  );

  if (text === undefined) {
    return;
  }

  const decoded = Schema.decodeUnknownResult(
    Schema.fromJsonString(recordSchema),
  )(text);

  return Result.isSuccess(decoded) ? decoded.success : undefined;
}

export async function writeEnrolmentRecord(
  files: OfficerFiles,
  record: EnrolmentRecord,
) {
  await writePrivateFile(files.record, `${JSON.stringify(record, null, 2)}\n`);
}
