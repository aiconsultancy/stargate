/** One-use offline conversion. Never imported by the gateway or updater. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionMoveInput, SessionUpdateInput } from "@opencode/client";
import { Schema } from "effect";
import { z } from "zod";
import { backendSchema } from "../src/config";
import { backendFingerprint } from "../src/gateway/routing";

const mapping = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
});
const localPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !path.split(/[\\/]/).includes("..") &&
      !path.includes("\0"),
  );
const edit = z.strictObject({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1),
  before: z.json(),
  after: z.json(),
});
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const migrationPlanSchema = z.strictObject({
  schema: z.literal("stargate.cutover.v1"),
  source: z.string().refine(isAbsolute),
  destination: z.string().refine(isAbsolute),
  gateway: localPath,
  cron: localPath.optional(),
  crew: z
    .array(
      z.strictObject({
        database: localPath,
        before: z.string(),
        after: z.string(),
      }),
    )
    .default([]),
  paths: z.array(mapping).default([]),
  botKeys: z.array(mapping).default([]),
  mesij: z
    .array(
      z.strictObject({
        database: localPath,
        crewDatabase: localPath,
        actors: z.array(mapping),
        projects: z.array(mapping).default([]),
      }),
    )
    .default([]),
  moves: z
    .array(z.strictObject({ from: localPath, to: localPath }))
    .default([]),
  jsonFiles: z
    .array(z.strictObject({ file: localPath, edits: z.array(edit).min(1) }))
    .default([]),
  // Exact native-store edits require an operator-verified storage schema.
  // They cannot select prompts or replace substrings: one cell, one expected value.
  cells: z
    .array(
      z.strictObject({
        database: localPath,
        table: identifier,
        column: identifier,
        keyColumn: identifier,
        key: z.union([z.string(), z.number().int()]),
        before: z.string(),
        after: z.string(),
      }),
    )
    .default([]),
});
export type MigrationPlan = z.input<typeof migrationPlanSchema>;
type Mapping = z.infer<typeof mapping>;

export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** `before` MUST be output of the installed old release's schema, not raw config. */
export function cutoverBotKey(key: string, before: unknown, after: unknown) {
  const parts = z.array(z.json()).parse(JSON.parse(key));
  if (
    !(
      (parts.length === 5 && typeof parts[0] === "string") ||
      (parts.length === 7 && parts[0] === "irc")
    )
  )
    throw new Error("Unsupported bot namespace shape.");
  const oldBackend = z.record(z.string(), z.unknown()).parse(before);
  if (oldBackend["type"] === "opencode") delete oldBackend["sessionID"];
  if (sha256(JSON.stringify(oldBackend)) !== parts.at(-1))
    throw new Error("Old normalized backend does not match stored namespace.");
  parts[parts.length - 1] = backendFingerprint({
    backend: Schema.decodeUnknownSync(backendSchema)(after),
  });
  const next = JSON.stringify(parts);
  return { from: key, to: next, fromHash: sha256(key), toHash: sha256(next) };
}

/** Pure V2 API plan. No discovery, model/agent switch, create, fork or prompt. */
export function cutoverSessionFields(
  before: {
    id: string;
    directory: string;
    metadata?: NonNullable<SessionUpdateInput["metadata"]>;
    permissions?: NonNullable<SessionUpdateInput["permissions"]>;
  },
  paths: readonly Mapping[],
) {
  let update: SessionUpdateInput = { sessionID: before.id };
  if (before.metadata && Object.hasOwn(before.metadata, "pogoCrew")) {
    if (Object.hasOwn(before.metadata, "stargateCrew"))
      throw new Error("Both native crew metadata keys exist.");
    const metadata = { ...before.metadata };
    const value = metadata["pogoCrew"];
    if (value === undefined) throw new Error("Invalid native crew metadata.");
    metadata["stargateCrew"] = value;
    delete metadata["pogoCrew"];
    update = { ...update, metadata };
  }
  const name = (value: string) => value.replace(/^pogo(?=[_.])/, "stargate");
  if (before.permissions) {
    const permissions = before.permissions.map((rule) => ({
      ...rule,
      action: name(rule.action),
      resource: migratedPath(name(rule.resource), paths),
    }));
    if (!isDeepStrictEqual(permissions, before.permissions))
      update = { ...update, permissions };
  }
  const directory = migratedPath(before.directory, paths);
  const move: SessionMoveInput | undefined =
    directory === before.directory
      ? undefined
      : { sessionID: before.id, directory };
  return { update, move };
}

/** Longest explicit path prefix wins; no arbitrary text replacement. */
export function migratedPath(value: string, paths: readonly Mapping[]) {
  const match = [...paths]
    .sort((a, b) => b.from.length - a.from.length)
    .find(({ from }) => value === from || value.startsWith(`${from}/`));
  return match ? match.to + value.slice(match.from.length) : value;
}

function uniqueMappings(mappings: readonly Mapping[]) {
  for (const field of ["from", "to"] as const)
    if (new Set(mappings.map((item) => item[field])).size !== mappings.length)
      throw new Error("Duplicate migration mapping.");
  if (mappings.some(({ from, to }) => from === to))
    throw new Error("Unchanged migration mapping.");
}

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function tables(db: Database) {
  return new Set(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
      .all()
      .map(({ name }) => name),
  );
}
function columns(db: Database, table: string) {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
      .all()
      .map(({ name }) => name),
  );
}

function convertDatabase(
  path: string,
  kind: "gateway" | "cron",
  keys: readonly Mapping[],
  paths: readonly Mapping[],
) {
  const db = new Database(path, { strict: true, create: false });
  try {
    db.transaction(() => {
      const names = tables(db);
      const required =
        kind === "gateway"
          ? ["jobs", "sessions"]
          : ["cron_schedules", "cron_runs"];
      if (!required.every((name) => names.has(name)))
        throw new Error("Wrong migration database kind.");
      if (kind === "gateway")
        for (const old of ["irc_pogo_dm", "irc_pogo_dm_cursor"]) {
          if (!names.has(old)) continue;
          const next = old.replace("pogo", "stargate");
          if (names.has(next))
            throw new Error("Both old and new DM tables exist.");
          db.exec(`ALTER TABLE "${old}" RENAME TO "${next}"`);
          names.delete(old);
          names.add(next);
        }
      if (kind === "gateway" && columns(db, "jobs").has("output_files"))
        for (const row of db
          .query<{ id: number; output_files: string }, []>(
            "SELECT id,output_files FROM jobs WHERE output_files IS NOT NULL",
          )
          .all()) {
          const files = z
            .array(z.record(z.string(), z.unknown()))
            .parse(JSON.parse(row.output_files));
          for (const file of files) {
            file["path"] = migratedPath(z.string().parse(file["path"]), paths);
            if (file["prepared"] !== undefined) {
              const prepared = record(file["prepared"]);
              prepared["path"] = migratedPath(
                z.string().parse(prepared["path"]),
                paths,
              );
              file["prepared"] = prepared;
            }
          }
          db.query("UPDATE jobs SET output_files=? WHERE id=?").run(
            JSON.stringify(files),
            row.id,
          );
        }
      const scoped = [
        "jobs",
        "ignored_events",
        "captain_cursors",
        "irc_cursors",
        "irc_stargate_dm_cursor",
        "cron_schedules",
        "cron_daily_reports",
      ];
      for (const table of scoped) {
        if (!names.has(table) || !columns(db, table).has("botKey")) continue;
        for (const { from, to } of keys) {
          if (
            db.query(`SELECT 1 FROM "${table}" WHERE botKey=? LIMIT 1`).get(to)
          )
            throw new Error("Destination bot namespace already exists.");
          db.query(`UPDATE "${table}" SET botKey=? WHERE botKey=?`).run(
            to,
            from,
          );
        }
      }
      for (const table of ["sessions", "jobs"]) {
        if (!names.has(table) || !columns(db, table).has("conversation"))
          continue;
        const conversations = db
          .query<{ conversation: string }, []>(
            `SELECT DISTINCT conversation FROM "${table}"`,
          )
          .all();
        for (const { conversation } of conversations) {
          const parts = z.array(z.unknown()).parse(JSON.parse(conversation));
          const mapped = keys.find(({ from }) => parts[0] === from);
          if (!mapped) continue;
          parts[0] = mapped.to;
          const next = JSON.stringify(parts);
          if (
            db
              .query(`SELECT 1 FROM "${table}" WHERE conversation=? LIMIT 1`)
              .get(next)
          )
            throw new Error("Destination conversation already exists.");
          db.query(
            `UPDATE "${table}" SET conversation=? WHERE conversation=?`,
          ).run(next, conversation);
        }
      }
      if (kind === "cron") {
        if (columns(db, "cron_schedules").has("source")) {
          for (const row of db
            .query<{ id: string; source: string }, []>(
              "SELECT id,source FROM cron_schedules WHERE source IS NOT NULL",
            )
            .all())
            db.query("UPDATE cron_schedules SET source=? WHERE id=?").run(
              migratedPath(row.source, paths),
              row.id,
            );
        }
        if (names.has("cron_runs") && columns(db, "cron_runs").has("snapshot"))
          for (const row of db
            .query<{ id: string; snapshot: string }, []>(
              "SELECT id,snapshot FROM cron_runs WHERE snapshot IS NOT NULL",
            )
            .all()) {
            const snapshot = record(JSON.parse(row.snapshot));
            snapshot["botKey"] =
              keys.find(({ from }) => snapshot["botKey"] === from)?.to ??
              snapshot["botKey"];
            if (typeof snapshot["source"] === "string")
              snapshot["source"] = migratedPath(snapshot["source"], paths);
            db.query("UPDATE cron_runs SET snapshot=? WHERE id=?").run(
              JSON.stringify(snapshot),
              row.id,
            );
          }
      }
      if (
        db
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get()?.integrity_check !== "ok"
      )
        throw new Error("SQLite integrity check failed.");
    }).immediate();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function applyEdits(value: unknown, edits: readonly z.infer<typeof edit>[]) {
  for (const edit of edits) {
    let parent: unknown = value;
    for (const part of edit.path.slice(0, -1)) {
      if (
        typeof parent !== "object" ||
        parent === null ||
        !Object.hasOwn(parent, part)
      )
        throw new Error("Missing JSON migration path.");
      parent = (parent as Record<string | number, unknown>)[part];
    }
    const key = edit.path.at(-1);
    if (
      key === undefined ||
      typeof parent !== "object" ||
      parent === null ||
      !Object.hasOwn(parent, key)
    )
      throw new Error("Missing JSON migration field.");
    const target = parent as Record<string | number, unknown>;
    if (!isDeepStrictEqual(target[key], edit.before))
      throw new Error("JSON migration precondition failed.");
    target[key] = edit.after;
  }
  return value;
}

/** Mesij v0.1.0 schema 4 only. Offline identity surgery, with guards restored. */
function convertMesij(
  path: string,
  crew: string,
  actors: readonly Mapping[],
  projects: readonly Mapping[],
  paths: readonly Mapping[],
) {
  uniqueMappings(actors);
  uniqueMappings(projects);
  for (const { from, to } of actors)
    if (
      !/^pogo:[a-f0-9]{64}:.+$/.test(from) ||
      to !== `stargate:${from.slice(5)}`
    )
      throw new Error("Mesij actor mappings must preserve namespace and role.");
  const db = new Database(path, { strict: true, create: false });
  try {
    if (
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version !== 4
    )
      throw new Error(
        "Unsupported Mesij schema; expected pinned v0.1.0 schema 4.",
      );
    const required: Record<string, string[]> = {
      events: [
        "sequence",
        "id",
        "project_id",
        "actor",
        "session_id",
        "recipient_session",
        "reply_to",
        "event_type",
        "payload",
        "worktree",
        "branch",
        "commit_sha",
        "host",
        "user_name",
        "ip",
        "idempotency_key",
        "created_at",
      ],
      agents: [
        "project_id",
        "session_id",
        "actor",
        "started_at",
        "last_seen_at",
      ],
      mentions: ["event_id", "actor"],
      idempotency_keys: ["project_id", "session_id", "key", "event_id"],
      active_work: [
        "project_id",
        "session_id",
        "work_id",
        "event_id",
        "projection",
      ],
      projection_errors: ["event_id", "project_id", "reason"],
    };
    for (const [table, expected] of Object.entries(required))
      if (!isDeepStrictEqual([...columns(db, table)].sort(), expected.sort()))
        throw new Error(
          "Mesij schema differs from the pinned migration contract.",
        );
    db.query("ATTACH DATABASE ? AS crew").run(crew);
    db.transaction(() => {
      const translate = (value: string, mappings: readonly Mapping[]) =>
        mappings.find(({ from }) => from === value)?.to ?? value;
      const triggers = [
        "events_immutable_update",
        ...(projects.length ? ["idempotency_keys_immutable_update"] : []),
      ].map((name) => {
        const trigger = db
          .query<{ sql: string }, [string]>(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
          )
          .get(name);
        if (!trigger?.sql) throw new Error("Mesij immutability guard missing.");
        return { name, sql: trigger.sql };
      });
      for (const { to } of actors)
        for (const table of ["events", "agents", "mentions"])
          if (db.query(`SELECT 1 FROM ${table} WHERE actor=? LIMIT 1`).get(to))
            throw new Error("Mesij target actor already exists.");
      for (const { to } of projects)
        if (db.query("SELECT 1 FROM events WHERE project_id=? LIMIT 1").get(to))
          throw new Error("Mesij target project already exists.");
      type Event = {
        id: string;
        actor: string;
        session_id: string;
        recipient_session: string;
        reply_to: string;
        event_type: string;
        payload: string;
        idempotency_key: string;
        worktree: string;
      };
      const events = db
        .query<Event, []>(
          "SELECT id,actor,session_id,recipient_session,reply_to,event_type,payload,idempotency_key,worktree FROM events",
        )
        .all();
      const fingerprints = events.flatMap((event) => {
        const actor = translate(event.actor, actors);
        if (actor === event.actor) return [];
        const parsed = z
          .record(z.string(), z.unknown())
          .safeParse(JSON.parse(event.payload));
        if (!parsed.success) return [];
        const payload = parsed.data;
        if (typeof payload["message"] !== "string") return [];
        const fingerprint = (identity: string) =>
          sha256(
            JSON.stringify([
              identity,
              event.session_id,
              event.recipient_session || undefined,
              event.event_type,
              payload["message"],
              event.reply_to || null,
            ]),
          );
        return [
          {
            event,
            before: fingerprint(event.actor),
            after: fingerprint(actor),
          },
        ];
      });
      if (
        db
          .query(
            "SELECT 1 FROM crew.sqlite_master WHERE type='table' AND name='mail_intents'",
          )
          .get()
      ) {
        const intents = db
          .query<
            {
              key: string;
              fingerprint: string;
              receiptID: string | null;
              sender: string;
              recipient: string;
            },
            []
          >(
            "SELECT key,fingerprint,receiptID,sender,recipient FROM crew.mail_intents",
          )
          .all();
        for (const intent of intents) {
          const match = fingerprints.find(
            ({ event }) =>
              event.idempotency_key === intent.key ||
              event.id === intent.receiptID,
          );
          if (!match) {
            if (intent.receiptID === null)
              throw new Error(
                "Unsent mail intent has no recoverable message preimage; resolve before cutover.",
              );
            continue;
          }
          if (
            intent.fingerprint !== match.before ||
            intent.sender !== match.event.session_id ||
            intent.recipient !== match.event.recipient_session ||
            (intent.receiptID !== null && intent.receiptID !== match.event.id)
          )
            throw new Error(
              "Mesij mail intent identity does not match retained event.",
            );
          db.query(
            "UPDATE crew.mail_intents SET fingerprint=? WHERE key=? AND fingerprint=?",
          ).run(match.after, intent.key, match.before);
        }
      }
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
      for (const { from, to } of actors)
        for (const table of ["events", "agents", "mentions"])
          db.query(`UPDATE ${table} SET actor=? WHERE actor=?`).run(to, from);
      for (const { from, to } of projects)
        for (const table of [
          "events",
          "agents",
          "idempotency_keys",
          "active_work",
          "projection_errors",
        ])
          db.query(`UPDATE ${table} SET project_id=? WHERE project_id=?`).run(
            to,
            from,
          );
      for (const event of events) {
        const parsed = z
          .record(z.string(), z.unknown())
          .safeParse(JSON.parse(event.payload));
        const payload = parsed.success ? parsed.data : {};
        if (Array.isArray(payload["mentions"])) {
          const before = z.array(z.string()).parse(payload["mentions"]);
          const after = before.map((actor) =>
            actor.startsWith("@")
              ? `@${translate(actor.slice(1), actors)}`
              : translate(actor, actors),
          );
          if (!isDeepStrictEqual(before, after)) {
            payload["mentions"] = after;
            db.query("UPDATE events SET payload=? WHERE id=?").run(
              JSON.stringify(payload),
              event.id,
            );
          }
        }
        const worktree = migratedPath(event.worktree, paths);
        if (worktree !== event.worktree)
          db.query("UPDATE events SET worktree=? WHERE id=?").run(
            worktree,
            event.id,
          );
      }
      // v0.1.0 active_work.projection has no actor identity field. Its `data`
      // and `message` are opaque payloads, not a place to replace product text.
      for (const trigger of triggers) db.exec(trigger.sql);
      for (const schema of ["main", "crew"])
        if (
          db
            .query<{ integrity_check: string }, []>(
              `PRAGMA ${schema}.integrity_check`,
            )
            .get()?.integrity_check !== "ok"
        )
          throw new Error("Mesij/crew integrity check failed.");
    }).immediate();
    db.exec(
      "PRAGMA main.wal_checkpoint(TRUNCATE); PRAGMA crew.wal_checkpoint(TRUNCATE)",
    );
  } finally {
    db.close();
  }
}

/** Reject links, sockets and live SQLite sidecars; use SQLite backups, not cp of a running DB. */
async function inspectTree(root: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await inspectTree(join(root, entry.name));
    else if (!entry.isFile() || /-(wal|shm|journal)$/.test(entry.name))
      throw new Error(
        "Snapshot contains a link, special file or SQLite sidecar.",
      );
  }
}

/** Resolve the actual existing ancestor, even when several parents are absent. */
async function physicalDestination(path: string) {
  let ancestor = dirname(path);
  const suffix = [basename(path)];
  for (;;) {
    const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info) {
      // Broken links and non-directory ancestors fail closed, not as absent paths.
      const physical = await realpath(ancestor);
      if (!(await lstat(physical)).isDirectory())
        throw new Error("Migration destination ancestor is not a directory.");
      return resolve(physical, ...suffix);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error("Cannot resolve migration destination.");
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
}

export async function migrateSnapshot(input: MigrationPlan) {
  const plan = migrationPlanSchema.parse(input);
  const requestedSource = resolve(plan.source);
  const info = await lstat(requestedSource);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error(
      "Source must be a private, owned offline snapshot directory.",
    );
  const source = await realpath(requestedSource);
  const destination = await physicalDestination(resolve(plan.destination));
  if (
    source === destination ||
    source.startsWith(`${destination}${sep}`) ||
    destination.startsWith(`${source}${sep}`)
  )
    throw new Error("Snapshot roots must be disjoint.");
  if (
    await lstat(destination).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new Error("Migration destination already exists.");
  if (
    (await readFile(join(source, ".stargate-offline-snapshot"), "utf8")) !==
    "pogo-to-stargate-v1\n"
  )
    throw new Error("Offline snapshot acknowledgement missing.");
  if (await Bun.file(join(source, ".stargate-cutover-complete.json")).exists())
    throw new Error("Snapshot has already been converted.");
  uniqueMappings(plan.paths);
  uniqueMappings(plan.botKeys);
  for (const { from, to } of plan.paths)
    if (
      ![from, to].every(
        (path) => isAbsolute(path) && resolve(path) === path && path !== "/",
      )
    )
      throw new Error(
        "Path mappings require canonical absolute non-root paths.",
      );
  for (const { from, to } of plan.botKeys) {
    const before = z.array(z.json()).min(2).parse(JSON.parse(from));
    const after = z.array(z.json()).min(2).parse(JSON.parse(to));
    if (
      !isDeepStrictEqual(before.slice(0, -1), after.slice(0, -1)) ||
      !z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .safeParse(after.at(-1)).success
    )
      throw new Error("Bot mapping may change only the backend fingerprint.");
  }
  await inspectTree(source);
  // No activation or live paths. A failed copy stays incomplete for inspection.
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source))
    await cp(join(source, entry), join(destination, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  const at = (path: string) => {
    const result = resolve(destination, path);
    if (relative(destination, result).startsWith(".."))
      throw new Error("Migration path escaped snapshot.");
    return result;
  };
  convertDatabase(at(plan.gateway), "gateway", plan.botKeys, plan.paths);
  if (plan.cron)
    convertDatabase(at(plan.cron), "cron", plan.botKeys, plan.paths);
  for (const crew of plan.crew) {
    const namespace = (text: string) => {
      const value: unknown = JSON.parse(text);
      return Array.isArray(value)
        ? z.string().parse(value[0])
        : z.string().parse(record(value)["namespace"]);
    };
    if (namespace(crew.before) !== namespace(crew.after))
      throw new Error("Crew namespace cannot change.");
    const db = new Database(at(crew.database), { strict: true, create: false });
    try {
      db.transaction(() => {
        const rows = db
          .query<{ value: string }, []>("SELECT value FROM identity")
          .all();
        if (rows.length !== 1 || rows[0]?.value !== crew.before)
          throw new Error("Crew identity precondition failed.");
        db.query("UPDATE identity SET value=? WHERE value=?").run(
          crew.after,
          crew.before,
        );
        if (tables(db).has("task_abandonments"))
          db.query(
            "UPDATE task_abandonments SET operationKey='stargate:cancel' WHERE operationKey='pogo:cancel'",
          ).run();
      }).immediate();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }
  for (const mesij of plan.mesij) {
    if (!(await Bun.file(at(mesij.crewDatabase)).exists()))
      throw new Error("Mesij crew database missing.");
    convertMesij(
      at(mesij.database),
      at(mesij.crewDatabase),
      mesij.actors,
      mesij.projects,
      plan.paths,
    );
  }
  for (const item of plan.cells) {
    const db = new Database(at(item.database), { strict: true, create: false });
    try {
      db.transaction(() => {
        const rows = db
          .query<Record<string, unknown>, [string | number]>(
            `SELECT "${item.column}" AS value FROM "${item.table}" WHERE "${item.keyColumn}"=?`,
          )
          .all(item.key);
        if (rows.length !== 1 || rows[0]?.["value"] !== item.before)
          throw new Error("Native cell migration precondition failed.");
        if (
          db
            .query(
              `UPDATE "${item.table}" SET "${item.column}"=? WHERE "${item.keyColumn}"=? AND "${item.column}"=?`,
            )
            .run(item.after, item.key, item.before).changes !== 1
        )
          throw new Error("Native cell migration refused.");
      }).immediate();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }
  for (const file of plan.jsonFiles) {
    const value: unknown = JSON.parse(await readFile(at(file.file), "utf8"));
    await writeFile(
      at(file.file),
      `${JSON.stringify(applyEdits(value, file.edits), null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  for (const move of plan.moves) {
    if (
      await lstat(at(move.to)).then(
        () => true,
        () => false,
      )
    )
      throw new Error("Move destination already exists.");
    await mkdir(dirname(at(move.to)), { recursive: true, mode: 0o700 });
    await rename(at(move.from), at(move.to));
  }
  await writeFile(
    join(destination, ".stargate-cutover-complete.json"),
    `${JSON.stringify({ schema: "stargate.cutover.complete.v1", plan: sha256(JSON.stringify(plan)) })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return destination;
}

if (import.meta.main) {
  try {
    const [path, extra] = process.argv.slice(2);
    if (!path || extra) throw new Error("Expected one private plan file.");
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new Error("Plan file must be private and owned.");
    const input: unknown = JSON.parse(await readFile(path, "utf8"));
    await migrateSnapshot(migrationPlanSchema.parse(input));
    console.log(
      "Offline Stargate snapshot converted. No live files or services changed.",
    );
  } catch {
    console.error(
      "Cutover conversion failed; output is incomplete. Source is unchanged. Check the private plan against docs/hard-cutover.md; no raw data logged.",
    );
    process.exitCode = 1;
  }
}
