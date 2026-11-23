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
import { Option, Schema } from "effect";
import type { Config } from "../../config";
import { globalCatalogPath } from "./update/catalog";
import { discoverCrews } from "./crews";
import { type CommandRunner, type Reason, StepError } from "./exec";
import { atomicWrite, readOptional, replaceLink } from "./files";
import {
  agentCliInstall,
  agentCliVerify,
  binaryPath,
  proxyModels,
} from "./update/host";
import type { IdleResult, IdleScope } from "./schedule/idle";
import { agentFile, managedFolder } from "./update/models";
import type { OpenCodeControl } from "./update/opencode";
import { maintenanceDirectory } from "./paths";
import {
  type BackupEntry,
  type Fields,
  type SessionItem,
  backupEntry,
  fields,
  journalV1,
  legacyMarker,
  runIDSchema,
  v1,
} from "./journal-records";
import { readReady, readyProcessAlive, waitReady } from "./update/ready";
import { linkedRelease, readMetadata, restoreCurrent } from "./update/release";
import { type ModelRef, formatRef } from "./update/versions";

/**
 * Undo journal. Every live change is recorded here *before* it happens and
 * removed once it is verified and committed. A run that ends abnormally
 * (exception, SIGTERM, timeout, reboot) leaves the remaining entries, and
 * the run's own cleanup and `stargate maintenance recover` apply the same undo.
 *
 * The journal is data, never instructions: unit names, commands, paths,
 * package lists and endpoints all come from the configuration. The journal
 * may only name configured packages, strict versions, managed release
 * names, session IDs and model references, and it must be a private file
 * owned by this user. Anything else is "corrupt" and nothing is undone.
 */
export const journalSchemaID = "stargate.maintenance.journal.v2";

const isRunID = Schema.is(runIDSchema);

export type JournalEntry = keyof typeof fields;

const sessionRef = ({ from }: SessionItem): ModelRef => ({
  providerID: from.providerID,
  id: from.id,
  ...(from.variant && { variant: from.variant }),
});

export const journalPath = (dataDirectory: string) =>
  join(maintenanceDirectory(dataDirectory), "journal.json");

/** Written by the first version of maintenance; still honoured. */
const legacyPath = (dataDirectory: string) =>
  join(maintenanceDirectory(dataDirectory), "gateway-stopped.json");

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

type ReadResult =
  | { kind: "none" }
  | { kind: "ok"; journal: Journal }
  | { kind: "corrupt" };

export class Journal {
  private constructor(
    private readonly dataDirectory: string,
    public readonly runID: string,
    private data: Fields,
    private readonly legacy = false,
  ) {}

  public static create(dataDirectory: string, runID: string) {
    if (!isRunID(runID)) throw new StepError("unknown");

    return new Journal(dataDirectory, runID, {});
  }

  /**
   * `none` only when no journal exists (ENOENT). A journal that is not a
   * private file owned by this user, has unknown keys, or names anything
   * outside the configuration is `corrupt`.
   */
  public static async read(config: Config): Promise<ReadResult> {
    const data = config.dataDirectory;
    let source = journalPath(data);
    let content: string | null;

    try {
      content = await readOptional(source);

      if (content === null) {
        source = legacyPath(data);
        content = await readOptional(source);
      }
    } catch {
      return { kind: "corrupt" };
    }

    if (content === null) return { kind: "none" };

    if (
      !(await privatePath(maintenanceDirectory(data), "directory")) ||
      !(await privatePath(source, "file"))
    )
      return { kind: "corrupt" };
    let raw: unknown;

    try {
      raw = JSON.parse(content);
    } catch {
      return { kind: "corrupt" };
    }

    const parsed = parseJournal(raw, source === legacyPath(data), config);

    if (!parsed) return { kind: "corrupt" };

    return {
      kind: "ok",
      journal: new Journal(
        data,
        parsed.runID,
        parsed.data,
        source === legacyPath(data),
      ),
    };
  }

  public get<K extends JournalEntry>(key: K): Fields[K] {
    return this.data[key];
  }

  public get empty() {
    return Object.values(this.data).every((value) => value === undefined);
  }

  public async set<K extends JournalEntry>(
    key: K,
    value: NonNullable<Fields[K]>,
  ) {
    this.data[key] = Schema.decodeUnknownSync(fields[key])(value) as Fields[K];
    await this.save();
  }

  public async clear(key: JournalEntry) {
    if (this.data[key] === undefined) return;
    // The rest keeps the other entries in their order, as delete did.
    const { [key]: _removed, ...rest } = this.data;
    this.data = rest;
    await this.save();
  }

  private async save() {
    if (this.empty) {
      await unlink(journalPath(this.dataDirectory)).catch(() => {});

      if (this.legacy)
        await unlink(legacyPath(this.dataDirectory)).catch(() => {});

      return;
    }

    await mkdir(maintenanceDirectory(this.dataDirectory), {
      recursive: true,
      mode: 0o700,
    });
    await atomicWrite(
      journalPath(this.dataDirectory),
      `${JSON.stringify({ schema: journalSchemaID, runID: this.runID, ...this.data }, null, 2)}\n`,
      0o600,
    );

    if (this.legacy)
      await unlink(legacyPath(this.dataDirectory)).catch(() => {});
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Shape and configuration checks; null means corrupt. */
function parseJournal(
  raw: unknown,
  legacy: boolean,
  config: Config,
): { runID: string; data: Fields } | null {
  const m = config.maintenance;

  if (!m || typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const data: Fields = {};
  let runID: string;

  if (legacy) {
    const marker = Schema.decodeUnknownOption(legacyMarker)(raw);

    if (Option.isNone(marker) || marker.value.unit !== m.services.gateway)
      return null;
    const { stargateRoot, previousRelease } = marker.value;

    if (
      stargateRoot !== null &&
      stargateRoot !== undefined &&
      stargateRoot !== m.stargate?.root
    )
      return null;
    runID = "legacy";
    data.gateway = { restartPending: false };

    if (previousRelease) {
      if (stargateRoot === null || stargateRoot === undefined) return null;
      data.release = { previous: previousRelease, version: "0.0.0" };
    }
  } else if ((raw as Record<string, unknown>)["schema"] === journalV1) {
    const old = Schema.decodeUnknownOption(v1)(raw);

    if (Option.isNone(old)) return null;
    const j = old.value;
    runID = j.runID;

    // Its commands and paths must be exactly the configured ones; only the
    // Data is kept, and recovery takes everything else from the config.

    const cpa = m.cliproxyapi;
    const npm = m.agentClis;

    if (
      (j.gateway && j.gateway.unit !== m.services.gateway) ||
      (j.cliproxyapi &&
        (!cpa ||
          j.cliproxyapi.unit !== cpa.unit ||
          j.cliproxyapi.link !== cpa.link ||
          resolve(j.cliproxyapi.previousTarget) !==
            binaryPath(cpa, j.cliproxyapi.version) ||
          j.cliproxyapi.url !== m.proxy?.url ||
          j.cliproxyapi.clientKeyFile !== m.proxy?.clientKeyFile)) ||
      (j.clis &&
        (!npm ||
          !same(j.clis.npm, npm.npm) ||
          j.clis.prefix !== npm.prefix ||
          j.clis.registry !== npm.registry ||
          !same(j.clis.allowScripts, npm.allowScripts) ||
          j.clis.lockFile !== npm.lockFile ||
          j.clis.packages.some(
            (p) =>
              npm.packages.find((c) => c.name === p.name)?.command !==
              p.command,
          ))) ||
      (j.openCode && !same(j.openCode.restart, m.services.openCodeRestart))
    )
      return null;

    if (j.gateway) data.gateway = { restartPending: false };

    if (j.cliproxyapi)
      data.cliproxyapi = { previousVersion: j.cliproxyapi.version };

    if (j.release) {
      if (j.release.root !== m.stargate?.root) return null;
      data.release = {
        previous: j.release.previous,
        version: j.release.version,
      };
    }

    if (j.files) {
      if (
        resolve(j.files.backup) !== backupDirectory(config.dataDirectory, runID)
      )
        return null;
      data.files = {};
    }

    if (j.clis)
      data.clis = {
        packages: j.clis.packages.map(({ name, before, cutoff }) => ({
          name,
          before,
          cutoff,
        })),
      };

    if (j.sessions) data.sessions = j.sessions;

    if (j.openCode)
      data.openCode = {
        restarted: j.openCode.restarted,
        restartPending: false,
      };
  } else {
    const record = raw as Record<string, unknown>;
    const allowed = new Set(["schema", "runID", ...Object.keys(fields)]);

    if (record["schema"] !== journalSchemaID) return null;

    if (Object.keys(record).some((key) => !allowed.has(key))) return null;
    const id = Schema.decodeUnknownOption(runIDSchema)(record["runID"]);

    if (Option.isNone(id)) return null;
    runID = id.value;

    for (const key of Object.keys(fields) as JournalEntry[]) {
      if (record[key] === undefined) continue;
      const parsed = Schema.decodeUnknownOption(fields[key])(record[key]);

      if (Option.isNone(parsed)) return null;
      (data as Record<string, unknown>)[key] = parsed.value;
    }
  }

  // Every entry must refer to configured components only.
  if (data.cliproxyapi && (!m.cliproxyapi || !m.proxy)) return null;

  if (data.release && !m.stargate) return null;

  if (data.files && runID === "legacy") return null;

  if (data.clis) {
    const allowed = new Set((m.agentClis?.packages ?? []).map((p) => p.name));

    if (data.clis.packages.some((p) => !allowed.has(p.name))) return null;
  }

  if (data.sessions) {
    const providers = m.models?.providers ?? ["openai-proxy", "claude-proxy"];

    if (data.sessions.some((s) => !providers.includes(s.from.providerID)))
      return null;
  }

  return { runID, data };
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

    if (expected !== undefined && old !== expected)
      throw new StepError("external-change");
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

  if (m?.models?.updateGlobalCatalog)
    files.add(resolve(globalCatalogPath(m.models)));

  for (const crew of await discoverCrews(config).catch(() => []))
    for (const root of crew.roots) files.add(resolve(root.configPath));

  const profiles = m?.models?.agentProfiles
    ? resolve(m.models.agentProfiles)
    : undefined;

  return {
    file(path: string) {
      const target = resolve(path);

      if (target !== path) return false;

      if (files.has(target)) return true;

      if (!profiles) return false;
      const parts = relative(profiles, target).split(sep);
      const name = parts[1] ?? "";

      return (
        parts.length === 2 &&
        managedFolder.test(parts[0] ?? "") &&
        (name === "routes.json" || name === "PROFILE" || agentFile.test(name))
      );
    },
    link(path: string, target: string) {
      if (!profiles || resolve(path) !== path) return false;
      const name = basename(path);

      return (
        dirname(path) === join(dirname(profiles), "agents") &&
        agentFile.test(name) &&
        target === `../agent-profiles/current/${name}`
      );
    },
  };
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

  if (names.length > 0 && !(await privatePath(backup, "directory")))
    throw new StepError("unknown");
  const managed = await managedTargets(config);
  const entries: BackupEntry[] = [];

  for (const name of names) {
    const path = join(backup, name);

    if (!(await privatePath(path, "file"))) throw new StepError("unknown");
    const entry = decodeBackupEntry(JSON.parse(await readFile(path, "utf8")));

    if (
      entry.kind === "link"
        ? !managed.link(entry.path, entry.target)
        : !managed.file(entry.path)
    )
      throw new StepError("unknown");
    entries.push(entry);
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

    if (!info) return "previous";

    return info.isSymbolicLink() &&
      (await readlink(entry.path)) === entry.target
      ? "written"
      : "changed";
  }

  const current = await readOptional(entry.path);

  if (current === entry.old) return "previous";

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
  const states = [];

  for (const entry of entries) states.push(await backupState(entry));

  if (states.includes("changed")) throw new StepError("external-change");
  let changing = false;

  for (const [index, entry] of entries.entries()) {
    if (states[index] === "previous") continue;

    if (!changing) await beforeChange();
    changing = true;

    if (entry.kind === "link" || entry.old === null) await unlink(entry.path);
    else await atomicWrite(entry.path, entry.old);
  }
}

const link = (path: string) =>
  readlink(path).then(
    (target) => `${path} -> ${target}`,
    () => `${path} (missing)`,
  );

/**
 * What an entry still covers, one line per path or item, for an operator
 * who decides to keep the current state (`recover --accept-current`).
 */
export async function describeEntry(
  config: Config,
  journal: Journal,
  entry: JournalEntry,
): Promise<string[]> {
  const m = config.maintenance;

  switch (entry) {
    case "files": {
      const backup = backupDirectory(config.dataDirectory, journal.runID);

      try {
        const labels = {
          written: "holds what maintenance wrote; recovery restores it",
          previous: "already restored",
          changed: "changed by someone else; recovery keeps it",
        };

        const lines = [`backup ${backup}`];

        for (const item of await readBackup(config, journal.runID))
          lines.push(
            `${item.kind} ${item.path}: ${labels[await backupState(item)]}`,
          );

        return lines;
      } catch {
        return [`backup ${backup}: not private or names an unmanaged path`];
      }
    }

    case "release": {
      const release = journal.get("release");

      if (!release || !m?.stargate) return [];

      return [
        `${await link(join(m.stargate.root, "current"))}; recovery points it back to releases/${release.previous}`,
      ];
    }

    case "clis":
      return (journal.get("clis")?.packages ?? []).map(
        (item) =>
          `npm ${item.name} under ${m?.agentClis?.prefix}: recovery reinstalls ${item.before} (cutoff ${item.cutoff})`,
      );
    case "cliproxyapi": {
      const proxy = journal.get("cliproxyapi");

      if (!proxy || !m?.cliproxyapi) return [];

      return [
        `${await link(m.cliproxyapi.link)}; recovery points it back to ${binaryPath(m.cliproxyapi, proxy.previousVersion)}`,
      ];
    }

    case "sessions":
      return (journal.get("sessions") ?? []).map(
        (item) =>
          `session ${item.id}: recovery switches it back to ${formatRef(sessionRef(item))}`,
      );
    case "gateway":
      return [
        `unit ${m?.services.gateway}: recovery ${journal.get("gateway")?.restartPending ? "restarts it" : "starts it unless the current release is ready"}`,
      ];
    case "openCode":
      return [
        `OpenCode: a restart is ${journal.get("openCode")?.restartPending ? "owed" : "not owed"}`,
      ];
  }
}

/** The journal files that may exist: current schema and the first version's marker. */
export const journalFiles = (dataDirectory: string) => [
  journalPath(dataDirectory),
  legacyPath(dataDirectory),
];

export const journalEntries = Object.keys(fields) as JournalEntry[];

/** `systemctl is-active` states that mean the unit runs or is starting. */
export const runningStates = new Set([
  "active",
  "activating",
  "reloading",
  "refreshing",
  "deactivating",
]);

export async function unitRunning(runner: CommandRunner, unit: string) {
  const result = await runner.run(["systemctl", "--user", "is-active", unit], {
    timeoutMs: 15_000,
  });

  return runningStates.has(result.stdout.trim());
}

export type UndoEvent =
  | {
      kind: "rollback";
      component: string;
      from: string;
      to: string;
      ok: boolean;
      reason?: Reason;
    }
  | {
      kind: "restart";
      service: "gateway" | "opencode" | "cliproxyapi";
      ok: boolean;
    }
  /** The idle gate before `step` was busy: the undo stopped there. */
  | { kind: "deferred"; step: UndoStep; reason: Reason };

/** Undo steps that change live state, each gated when `UndoContext.gate` is set. */
export type UndoStep =
  | "sessions"
  | "files"
  | "clis"
  | "cliproxyapi"
  | "opencode"
  | "gateway";

/** Only a gateway restart leaves crew work and OpenCode alone. */
export const undoStepScope = (step: UndoStep): IdleScope =>
  step === "gateway" ? "gateway" : "stargate";

/**
 * The idle scope before any undo of this journal. A journal that holds only
 * the release link and the gateway (a gateway-only update, or a full update
 * that stopped before OpenCode restarted) never touches OpenCode.
 */
export function journalScope(journal: Journal): IdleScope {
  const entries: JournalEntry[] = [
    "clis",
    "cliproxyapi",
    "files",
    "sessions",
    "openCode",
  ];

  return entries.some((entry) => journal.get(entry) !== undefined)
    ? "stargate"
    : "gateway";
}

export type UndoContext = {
  config: Config;
  runner: CommandRunner;
  connect: () => Promise<OpenCodeControl>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  record?: (event: UndoEvent) => void;
  /**
   * Idle check immediately before each step that changes live state: the
   * session switch-back, the config restore, the CLI reinstall, and every
   * restart of a running service. A busy answer stops the undo there; the
   * remaining entries (and owed restarts) stay for the next idle boundary.
   * Unset: the undo never waits (in-run rollback, operator recover).
   */
  gate?: (step: UndoStep) => Promise<IdleResult>;
};

/** Per-entry undo bounds (ms); the timer's TimeoutStopSec is derived from them. */
export const undoBounds = {
  sessions: 5 * 60_000,
  files: 60_000,
  npmPerPackage: 5 * 60_000,
  proxy: 2 * 60_000,
  openCode: 4 * 60_000,
  gateway: 3 * 60_000,
};

export function recoveryBudgetMs(config: Config["maintenance"]) {
  const packages = config?.agentClis?.packages.length ?? 0;

  return (
    undoBounds.sessions +
    undoBounds.files +
    packages * undoBounds.npmPerPackage +
    undoBounds.proxy +
    undoBounds.openCode +
    undoBounds.gateway
  );
}

/** The release version `current` points to, when Stargate releases are managed. */
export async function currentVersion(config: Config) {
  const root = config.maintenance?.stargate?.root;

  return root
    ? (await linkedRelease(root, "current"))?.metadata.version
    : undefined;
}

/**
 * Undo every remaining journal entry. Each entry is removed only after its
 * undo is verified. A restart that an undo makes necessary is persisted as
 * `restartPending` before the entry that caused it is removed, so an
 * interrupted recovery still restarts on its next pass.
 */
const signal = () => AbortSignal.timeout(30_000);

export async function undoJournal(
  journal: Journal,
  ctx: UndoContext,
  /** Undo only these entries (default: all). */
  only?: readonly JournalEntry[],
) {
  const m = ctx.config.maintenance;
  const wanted = (entry: JournalEntry) => !only || only.includes(entry);
  const record = ctx.record ?? (() => {});
  const restarted = journal.get("openCode")?.restarted ?? false;

  const oweOpenCode = async () => {
    const current = journal.get("openCode");
    await journal.set("openCode", {
      restarted: current?.restarted ?? false,
      restartPending: true,
    });
  };

  const oweGateway = async () => {
    if (journal.get("gateway"))
      await journal.set("gateway", { restartPending: true });
  };

  const idle = async (step: UndoStep) => {
    const result = await ctx.gate?.(step);

    if (!result || result.idle) return true;
    record({ kind: "deferred", step, reason: result.reason });

    return false;
  };

  const sessions = wanted("sessions") ? journal.get("sessions") : undefined;

  if (sessions?.length && !(await idle("sessions"))) return false;

  if (sessions?.length) {
    const left: SessionItem[] = [...sessions];
    const control = await ctx.connect().catch(() => {});
    const until = ctx.now() + undoBounds.sessions;

    for (const item of sessions.toReversed()) {
      if (!control || ctx.now() >= until) break;
      const from = sessionRef(item);
      let ok = false;

      try {
        await control.switchModel(item.id, from, signal());
        const after = await control.sessionModel(item.id, signal());
        ok = after !== null && formatRef(after) === formatRef(from);
      } catch {
        // A failed switch or read leaves ok false; the item stays journaled.
      }

      record({
        kind: "rollback",
        component: `session:${item.id}`,
        from: "upgraded",
        to: formatRef(from),
        ok,
      });

      if (ok) left.splice(left.indexOf(item), 1);
    }

    if (left.length > 0) await journal.set("sessions", left);
    else await journal.clear("sessions");
  } else if (wanted("sessions")) await journal.clear("sessions");

  if (wanted("files") && journal.get("files")) {
    if (!(await idle("files"))) return false;
    let reason: Reason | undefined;

    try {
      // The restart is owed from the first restored file on.
      await restoreBackup(ctx.config, journal.runID, oweOpenCode);
      await journal.clear("files");
    } catch (error) {
      reason = error instanceof StepError ? error.reason : "unknown";
    }

    record({
      kind: "rollback",
      component: "models",
      from: "upgraded",
      to: "previous",
      ok: reason === undefined,
      ...(reason && { reason }),
    });
  }

  const release = wanted("release") ? journal.get("release") : undefined;

  if (release && m?.stargate) {
    let ok = true;

    try {
      const managed = await readMetadata(
        join(m.stargate.root, "releases", release.previous),
      );

      if (!managed) throw new StepError("switch-failed");
      await restoreCurrent(m.stargate.root, release.previous);

      if (restarted) await oweOpenCode();
      await oweGateway();
      await journal.clear("release");
    } catch {
      ok = false;
    }

    record({
      kind: "rollback",
      component: "stargate",
      from: release.version,
      to: release.previous,
      ok,
    });
  }

  const clis = wanted("clis") ? journal.get("clis") : undefined;

  if (clis && m?.agentClis) {
    if (!(await idle("clis"))) return false;
    const settings = m.agentClis;
    const left = [];

    for (const item of clis.packages) {
      const configured = settings.packages.find((p) => p.name === item.name);
      let ok = false;

      try {
        if (!configured) throw new StepError("not-configured");
        // The cutoff that produced the previous install: no newer dependency.
        await agentCliInstall(
          settings,
          [{ name: configured.name, version: item.before }],
          item.cutoff,
          ctx.runner,
          undoBounds.npmPerPackage - 30_000,
        );
        ok = await agentCliVerify(
          settings,
          configured,
          item.before,
          ctx.runner,
        );
      } catch {
        // A failed reinstall leaves ok false; the package stays journaled.
      }

      record({
        kind: "rollback",
        component: `npm:${item.name}`,
        from: "updated",
        to: item.before,
        ok,
      });

      if (!ok) left.push(item);
    }

    if (restarted && left.length < clis.packages.length) await oweOpenCode();

    if (left.length > 0) await journal.set("clis", { packages: left });
    else await journal.clear("clis");
  }

  const proxy = wanted("cliproxyapi") ? journal.get("cliproxyapi") : undefined;

  if (proxy && m?.cliproxyapi && m.proxy) {
    const settings = m.cliproxyapi;
    const endpoint = m.proxy;
    const target = binaryPath(settings, proxy.previousVersion);

    const healthy = () =>
      proxyModels(endpoint, signal()).then(
        () => true,
        () => false,
      );

    let ok = false;

    try {
      const linked = await readlink(settings.link)
        .then((link) => resolve(dirname(settings.link), link))
        .catch(() => null);

      // Already back on the previous binary and answering: nothing to redo.
      if (linked === target && (await healthy())) ok = true;
      else {
        const binary = await lstat(target).catch(() => null);

        if (!binary?.isFile()) throw new StepError("not-found");

        if (!(await idle("cliproxyapi"))) return false;
        await replaceLink(settings.link, target);

        const restartedProxy = await ctx.runner.run(
          ["systemctl", "--user", "restart", settings.unit],
          {
            timeoutMs: 60_000,
          },
        );

        const until = ctx.now() + 60_000;

        while (restartedProxy.code === 0 && !ok) {
          ok = await healthy();

          if (ok || ctx.now() >= until) break;
          await ctx.sleep(3000);
        }

        record({ kind: "restart", service: "cliproxyapi", ok });
      }
    } catch {
      // A failed restore leaves ok false; the entry stays journaled.
    }

    record({
      kind: "rollback",
      component: "cliproxyapi",
      from: "switched",
      to: proxy.previousVersion,
      ok,
    });

    if (ok) await journal.clear("cliproxyapi");
  }

  // Restart OpenCode while a restart is owed; the flag survives interruption.
  let openCodeOK = true;

  if (wanted("openCode") && journal.get("openCode")?.restartPending && m) {
    if (!(await idle("opencode"))) return false;

    const result = await ctx.runner.run(m.services.openCodeRestart, {
      timeoutMs: 120_000,
    });

    openCodeOK = false;
    const until = ctx.now() + 90_000;

    while (result.code === 0 && !openCodeOK) {
      openCodeOK = await ctx.connect().then(
        () => true,
        () => false,
      );

      if (openCodeOK || ctx.now() >= until) break;
      await ctx.sleep(3000);
    }

    record({ kind: "restart", service: "opencode", ok: openCodeOK });

    if (openCodeOK)
      await journal.set("openCode", {
        restarted: journal.get("openCode")?.restarted ?? false,
        restartPending: false,
      });
  }

  if (!only && openCodeOK) await journal.clear("openCode");

  const gateway = wanted("gateway") ? journal.get("gateway") : undefined;

  if (gateway && m) {
    const unit = m.services.gateway;
    const expected = await currentVersion(ctx.config);
    let ok = false;
    // Running means a ready process of the current release, not a unit that
    // Is crash-looping or still serving the release that was undone.
    const ready = await readReady(ctx.config.dataDirectory);

    const state = (
      await ctx.runner.run(["systemctl", "--user", "is-active", unit], {
        timeoutMs: 15_000,
      })
    ).stdout.trim();

    if (
      !gateway.restartPending &&
      state === "active" &&
      ready &&
      readyProcessAlive(ready) &&
      (expected === undefined || ready.version === expected)
    )
      ok = true;
    else {
      // Starting a stopped gateway interrupts nothing; restarting a running
      // (or unknown) one does.
      if (
        state !== "inactive" &&
        state !== "failed" &&
        !(await idle("gateway"))
      )
        return false;
      const since = ctx.now();

      const started = await ctx.runner.run(
        ["systemctl", "--user", "restart", unit],
        {
          timeoutMs: 60_000,
        },
      );

      ok =
        started.code === 0 &&
        (await waitReady(
          ctx.config.dataDirectory,
          since,
          expected,
          120_000,
          ctx.sleep,
          ctx.now,
        ));
      record({ kind: "restart", service: "gateway", ok });
    }

    if (ok) await journal.clear("gateway");
  }

  return only
    ? openCodeOK &&
        only.every(
          (entry) => entry === "openCode" || journal.get(entry) === undefined,
        )
    : journal.empty;
}

/** For tests and diagnostics: the journal on disk, if any. */
export async function readJournalFile(dataDirectory: string) {
  return readOptional(journalPath(dataDirectory));
}
