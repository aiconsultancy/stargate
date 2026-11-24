import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import type { Config } from "../../../config";
import { globalCatalogPath } from "./update/catalog";
import { discoverCrews } from "./crews";
import { StepError } from "./exec";
import { atomicWrite, readOptional } from "./files";
import { type BackupEntry, backupEntry } from "./journal-records";
import { maintenanceDirectory } from "./paths";
import { agentFile, managedFolder } from "./update/models";

export const backupDirectory = (dataDirectory: string, runID: string) =>
  join(maintenanceDirectory(dataDirectory), "backups", runID);

/** A regular file or directory owned by this user, closed to others. */
export async function privatePath(path: string, kind: "file" | "directory") {
  const info = await lstat(path).catch(() => null);

  return (
    info !== null &&
    !info.isSymbolicLink() &&
    (kind === "file" ? info.isFile() : info.isDirectory()) &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o077) === 0
  );
}

/**
 * Configuration changes, each recorded in a private backup manifest before
 * it happens, so an interrupted run can restore exactly what it changed.
 */
export class FileChanges {
  public constructor(public readonly backup: string) {}

  private async record(entry: Record<string, unknown>) {
    await mkdir(this.backup, { recursive: true, mode: 0o700 });

    const index = (await readdir(this.backup)).filter((name) =>
      /^\d+\.json$/.test(name),
    ).length;

    await writeFile(
      join(this.backup, `${index}.json`),
      `${JSON.stringify(entry)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }

  public async write(path: string, content: string, expected?: string) {
    const old = await readOptional(path);

    if (expected !== undefined && old !== expected) {
      throw new StepError("external-change");
    }

    await this.record({ kind: "file", path, old, written: sha256(content) });
    await atomicWrite(path, content);
  }

  public async link(path: string, target: string) {
    await this.record({ kind: "link", path, target });
    await symlink(target, path);
  }
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const decodeBackupEntry = Schema.decodeUnknownSync(backupEntry);

/**
 * The only files and links maintenance may restore: configured team files,
 * discovered captain/crew profiles, files in managed agent-profile folders,
 * and additive agent links into the selected profile.
 */
async function managedTargets(config: Config) {
  const m = config.maintenance;

  const files = new Set(
    (m?.models?.teamFiles ?? []).map((path) => resolve(path)),
  );

  if (m?.models?.updateGlobalCatalog) {
    files.add(resolve(globalCatalogPath(m.models)));
  }

  for (const crew of await discoverCrews(config).catch(() => [])) {
    for (const root of crew.roots) {
      files.add(resolve(root.configPath));
    }
  }

  const profiles = m?.models?.agentProfiles
    ? resolve(m.models.agentProfiles)
    : undefined;

  return {
    file(path: string) {
      const target = resolve(path);

      if (target !== path) {
        return false;
      }

      if (files.has(target)) {
        return true;
      }

      if (!profiles) {
        return false;
      }

      const parts = relative(profiles, target).split(sep);
      const name = parts[1] ?? "";

      return (
        parts.length === 2 &&
        managedFolder.test(parts[0] ?? "") &&
        (name === "routes.json" || name === "PROFILE" || agentFile.test(name))
      );
    },
    link(path: string, target: string) {
      if (!profiles || resolve(path) !== path) {
        return false;
      }

      const name = basename(path);

      return (
        dirname(path) === join(dirname(profiles), "agents") &&
        agentFile.test(name) &&
        target === `../agent-profiles/current/${name}`
      );
    },
  };
}

async function readBackupEntry(
  path: string,
  managed: Awaited<ReturnType<typeof managedTargets>>,
) {
  if (!(await privatePath(path, "file"))) {
    throw new StepError("unknown");
  }

  const entry = decodeBackupEntry(JSON.parse(await readFile(path, "utf8")));

  if (
    entry.kind === "link"
      ? !managed.link(entry.path, entry.target)
      : !managed.file(entry.path)
  ) {
    throw new StepError("unknown");
  }

  return entry;
}

/**
 * A backup manifest, newest entry first. The directory and every entry must
 * be private, and every path must be in the managed set; otherwise nothing
 * is returned.
 */
async function readBackup(config: Config, runID: string) {
  const backup = backupDirectory(config.dataDirectory, runID);

  const names = (await readdir(backup).catch(() => [] as string[]))
    .filter((name) => /^\d+\.json$/.test(name))
    .toSorted((a, b) => Number(b.slice(0, -5)) - Number(a.slice(0, -5)));

  if (names.length > 0 && !(await privatePath(backup, "directory"))) {
    throw new StepError("unknown");
  }

  const managed = await managedTargets(config);
  const entries: BackupEntry[] = [];

  for (const name of names) {
    entries.push(await readBackupEntry(join(backup, name), managed));
  }

  return entries;
}

/**
 * `written`: still what maintenance wrote. `previous`: already back to the
 * state before maintenance. `changed`: someone else changed it since.
 */
async function backupState(entry: BackupEntry) {
  if (entry.kind === "link") {
    const info = await lstat(entry.path).catch(() => null);

    if (!info) {
      return "previous";
    }

    return info.isSymbolicLink() &&
      (await readlink(entry.path)) === entry.target
      ? "written"
      : "changed";
  }

  const current = await readOptional(entry.path);

  if (current === entry.old) {
    return "previous";
  }

  return current !== null && sha256(current) === entry.written
    ? "written"
    : "changed";
}

/**
 * Restore a backup manifest in reverse order. A file is restored only when
 * it still holds exactly what maintenance wrote; a link is removed only when
 * it still points where maintenance pointed it. Anything else was changed by
 * someone else: the entry is kept and the undo reports failure. Idempotent.
 */
export async function restoreBackup(
  config: Config,
  runID: string,
  /** Called once, before the first change. */
  beforeChange: () => Promise<void> = async () => {},
) {
  // Every entry is checked before anything is restored: one external change
  // Stops the whole restore, never half of it.
  const entries = await readBackup(config, runID);
  const checked = [];

  for (const entry of entries) {
    checked.push({ entry, state: await backupState(entry) });
  }

  if (checked.some(({ state }) => state === "changed")) {
    throw new StepError("external-change");
  }

  let changing = false;

  for (const { entry, state } of checked) {
    if (state === "previous") {
      continue;
    }

    if (!changing) {
      await beforeChange();
    }

    changing = true;

    if (entry.kind === "link" || entry.old === null) {
      await unlink(entry.path);
    } else {
      await atomicWrite(entry.path, entry.old);
    }
  }
}

export async function describeBackup(
  config: Config,
  runID: string,
): Promise<string[]> {
  const backup = backupDirectory(config.dataDirectory, runID);

  try {
    const labels = {
      written: "holds what maintenance wrote; recovery restores it",
      previous: "already restored",
      changed: "changed by someone else; recovery keeps it",
    };

    const lines = [`backup ${backup}`];

    for (const item of await readBackup(config, runID)) {
      lines.push(
        `${item.kind} ${item.path}: ${labels[await backupState(item)]}`,
      );
    }

    return lines;
  } catch {
    return [`backup ${backup}: not private or names an unmanaged path`];
  }
}
