import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const channelSchema = z
  .string()
  .max(64)
  .regex(/^[CG][A-Z0-9]+$/);
const threadSchema = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const reasonSchema = z.string().max(200);
const expirySchema = z.iso
  .datetime({ offset: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(value).toISOString());
const channelTargetSchema = z.strictObject({
  scope: z.literal("channel"),
  channel: channelSchema,
});
const threadTargetSchema = z.strictObject({
  scope: z.literal("thread"),
  channel: channelSchema,
  thread_ts: threadSchema,
});
const targetSchema = z.union([channelTargetSchema, threadTargetSchema]);
export type NotificationTarget = z.infer<typeof targetSchema>;

/** Explicit Slack targets only. Identity and authority come from the host. */
export const notificationInputSchema = z.union([
  channelTargetSchema.extend({
    op: z.literal("mute"),
    mute_until: expirySchema.optional(),
    reason: reasonSchema.optional(),
  }),
  threadTargetSchema.extend({
    op: z.literal("mute"),
    mute_until: expirySchema.optional(),
    reason: reasonSchema.optional(),
  }),
  channelTargetSchema.extend({
    op: z.literal("unmute"),
    reason: reasonSchema.optional(),
  }),
  threadTargetSchema.extend({
    op: z.literal("unmute"),
    reason: reasonSchema.optional(),
  }),
  channelTargetSchema.extend({ op: z.literal("status") }),
  threadTargetSchema.extend({ op: z.literal("status") }),
  z.strictObject({
    op: z.literal("clear_all"),
    reason: reasonSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("list"),
    cursor: z.string().min(1).max(1024).optional(),
  }),
]);
export type NotificationInput = z.infer<typeof notificationInputSchema>;

const settingSchema = z.strictObject({
  state: z.enum(["absent", "active", "expired"]),
  mute_until: expirySchema.nullable(),
  reason: reasonSchema.optional(),
});
export type NotificationSetting = z.infer<typeof settingSchema>;
const snapshotSchema = z.strictObject({
  mode: z.enum(["normal", "addressed-only"]),
  channel: settingSchema,
  thread: settingSchema,
});
export type NotificationSnapshot = z.infer<typeof snapshotSchema>;

const countsSchema = z.strictObject({
  thread: z.number().int().nonnegative(),
  channel: z.number().int().nonnegative(),
});
const identity = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim() !== "" && !value.includes("\0"));
const registrationSchema = identity(2048);
const contextSchema = z.object({ id: identity(255), caller: identity(256) });
const receiptSchema = z.strictObject({
  id: identity(255),
  action: z.enum(["mute", "unmute", "clear_all"]),
  caller: identity(256),
  at: z.number().int(),
  reason: reasonSchema.nullable(),
  target: targetSchema.nullable(),
  changed: z.boolean(),
  cleared: countsSchema.optional(),
  snapshot: snapshotSchema.optional(),
});
export type NotificationReceipt = z.infer<typeof receiptSchema>;
export type NotificationPage = {
  settings: { target: NotificationTarget; setting: NotificationSetting }[];
  cursor: string | null;
  counts: z.infer<typeof countsSchema>;
};
export type NotificationResult =
  | { op: "status"; target: NotificationTarget; current: NotificationSnapshot }
  | ({ op: "list" } & NotificationPage)
  | {
      op: "mute" | "unmute";
      target: NotificationTarget;
      current: NotificationSnapshot;
      changed: boolean;
      receipt: NotificationReceipt;
      replay: boolean;
    }
  | {
      op: "clear_all";
      cleared: z.infer<typeof countsSchema>;
      current: NotificationPage;
      changed: boolean;
      receipt: NotificationReceipt;
      replay: boolean;
    };

const savedSchema = z.strictObject({
  channel: channelSchema,
  thread: z.union([z.literal(""), threadSchema]),
  mute_until: expirySchema.nullable(),
  reason: reasonSchema.nullable(),
});
type SavedSetting = z.infer<typeof savedSchema>;
const cursorSchema = z.strictObject({
  version: z.literal(1),
  registration: z.string().regex(/^[a-f0-9]{64}$/),
  channel: channelSchema,
  thread: z.union([z.literal(""), threadSchema]),
});
const pageSize = 50;

/** Only these fixed messages may cross the control boundary. */
class NotificationStoreError extends Error {}
function safe<T>(
  operation: () => T,
  message = "Notification store operation failed.",
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NotificationStoreError) throw error;
    throw new NotificationStoreError(message);
  }
}
function invalid(): never {
  throw new NotificationStoreError("Invalid notification request.");
}
function checkRead(registration: string, now: number) {
  if (
    !registrationSchema.safeParse(registration).success ||
    !Number.isSafeInteger(now) ||
    !Number.isFinite(new Date(now).getTime())
  )
    invalid();
}
function registrationHash(registration: string) {
  return createHash("sha256").update(registration).digest("hex");
}
function readCursor(cursor: string | undefined, registration: string) {
  if (cursor === undefined) return { channel: "", thread: "" };
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) invalid();
    const parsed = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (parsed.registration !== registrationHash(registration)) invalid();
    return parsed;
  } catch {
    return invalid();
  }
}
function targetOf(row: SavedSetting): NotificationTarget {
  return row.thread
    ? { scope: "thread", channel: row.channel, thread_ts: row.thread }
    : { scope: "channel", channel: row.channel };
}
function settingOf(
  row: SavedSetting | undefined,
  now: number,
): NotificationSetting {
  if (!row) return { state: "absent", mute_until: null };
  return {
    state:
      row.mute_until === null || now < Date.parse(row.mute_until)
        ? "active"
        : "expired",
    mute_until: row.mute_until,
    ...(row.reason === null ? {} : { reason: row.reason }),
  };
}

/** Dedicated preferences database; never opens the gateway queue database. */
export class NotificationStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = safe(() => {
      if (path !== ":memory:") {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        // Establish privacy before SQLite creates WAL/SHM; refuse final symlinks.
        const fd = openSync(
          path,
          constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          if (!fstatSync(fd).isFile()) throw new Error();
          fchmodSync(fd, 0o600);
        } finally {
          closeSync(fd);
        }
      }
      const db = new Database(path, { create: true, strict: true });
      try {
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          CREATE TABLE IF NOT EXISTS notification_settings (
            registration TEXT NOT NULL, channel TEXT NOT NULL,
            thread TEXT NOT NULL, mute_until TEXT, reason TEXT,
            PRIMARY KEY (registration,channel,thread)
          );
          CREATE TABLE IF NOT EXISTS notification_receipts (
            registration TEXT NOT NULL, id TEXT NOT NULL,
            input TEXT NOT NULL, action TEXT NOT NULL, caller TEXT NOT NULL,
            at INTEGER NOT NULL, reason TEXT, receipt TEXT NOT NULL,
            PRIMARY KEY (registration,id)
          );
        `);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    }, "Notification store unavailable.");
  }

  close() {
    safe(() => this.db.close());
  }

  status(
    registration: string,
    channel: string,
    thread?: string,
    now = Date.now(),
  ): NotificationSnapshot {
    return safe(() => {
      checkRead(registration, now);
      if (
        !channelSchema.safeParse(channel).success ||
        (thread !== undefined && !threadSchema.safeParse(thread).success)
      )
        invalid();
      // A single SELECT keeps overlapping scopes in the same SQLite snapshot.
      const rows = this.db
        .query<SavedSetting, [string, string, string]>(`
        SELECT channel,thread,mute_until,reason FROM notification_settings
        WHERE registration=? AND channel=? AND thread IN ('',?)
      `)
        .all(registration, channel, thread ?? "")
        .map((row) => savedSchema.parse(row));
      const channelSetting = settingOf(
        rows.find((row) => row.thread === ""),
        now,
      );
      const threadSetting = settingOf(
        rows.find((row) => row.thread !== ""),
        now,
      );
      return {
        mode:
          channelSetting.state === "active" || threadSetting.state === "active"
            ? "addressed-only"
            : "normal",
        channel: channelSetting,
        thread: threadSetting,
      };
    });
  }

  operate(
    registration: string,
    raw: NotificationInput,
    context: { id: string; caller: string; now: number | (() => number) },
  ): NotificationResult {
    return safe(() => {
      const readTime = () => {
        const now =
          typeof context.now === "function" ? context.now() : context.now;
        checkRead(registration, now);
        return now;
      };
      const parsed = notificationInputSchema.safeParse(raw);
      if (!parsed.success) invalid();
      const input = parsed.data;
      if (input.op === "list") {
        return this.db
          .transaction(() => {
            const now = readTime();
            return {
              op: "list" as const,
              ...this.list(registration, now, input.cursor),
            };
          })
          .deferred();
      }
      const target =
        "scope" in input
          ? targetSchema.parse({
              scope: input.scope,
              channel: input.channel,
              ...(input.scope === "thread"
                ? { thread_ts: input.thread_ts }
                : {}),
            })
          : null;
      if (input.op === "status" && target)
        return {
          op: "status",
          target,
          current: this.status(
            registration,
            target.channel,
            target.scope === "thread" ? target.thread_ts : undefined,
            readTime(),
          ),
        };
      if (input.op === "status" || !contextSchema.safeParse(context).success)
        invalid();
      return this.db
        .transaction(() => {
          // Read the host clock after BEGIN IMMEDIATE acquires the write lock.
          const now = readTime();
          const canonical = JSON.stringify(input);
          const existing = this.db
            .query<
              {
                input: string;
                caller: string;
                receipt: string;
              },
              [string, string]
            >(`
          SELECT input,caller,receipt FROM notification_receipts
          WHERE registration=? AND id=?
        `)
            .get(registration, context.id);
          let receipt: NotificationReceipt;
          if (existing) {
            if (
              existing.input !== canonical ||
              existing.caller !== context.caller
            )
              throw new NotificationStoreError(
                "Notification operation identity conflict.",
              );
            receipt = receiptSchema.parse(JSON.parse(existing.receipt));
          } else {
            // Check elapsed time only after receipt lookup, inside the write lock.
            if (
              input.op === "mute" &&
              input.mute_until !== undefined &&
              Date.parse(input.mute_until) <= now
            )
              throw new NotificationStoreError(
                "Notification mute expiry has elapsed.",
              );
            let changed: boolean;
            let cleared: z.infer<typeof countsSchema> | undefined;
            if (input.op === "clear_all") {
              cleared = this.counts(registration);
              changed =
                this.db
                  .query(
                    "DELETE FROM notification_settings WHERE registration=?",
                  )
                  .run(registration).changes > 0;
            } else {
              if (!target) invalid();
              const thread = target.scope === "thread" ? target.thread_ts : "";
              if (input.op === "unmute") {
                changed =
                  this.db
                    .query(`DELETE FROM notification_settings
                WHERE registration=? AND channel=? AND thread=?`)
                    .run(registration, target.channel, thread).changes > 0;
              } else {
                changed =
                  this.db
                    .query(`INSERT INTO notification_settings
                (registration,channel,thread,mute_until,reason) VALUES (?,?,?,?,?)
                ON CONFLICT(registration,channel,thread) DO UPDATE SET
                  mute_until=excluded.mute_until,reason=excluded.reason
                WHERE mute_until IS NOT excluded.mute_until OR reason IS NOT excluded.reason`)
                    .run(
                      registration,
                      target.channel,
                      thread,
                      input.mute_until ?? null,
                      input.reason ?? null,
                    ).changes > 0;
              }
            }
            receipt = {
              id: context.id,
              action: input.op,
              caller: context.caller,
              at: now,
              reason: input.reason ?? null,
              target,
              changed,
              ...(cleared ? { cleared } : {}),
              ...(target
                ? {
                    snapshot: this.status(
                      registration,
                      target.channel,
                      target.scope === "thread" ? target.thread_ts : undefined,
                      now,
                    ),
                  }
                : {}),
            };
            this.db
              .query(`INSERT INTO notification_receipts
            (registration,id,input,action,caller,at,reason,receipt) VALUES (?,?,?,?,?,?,?,?)`)
              .run(
                registration,
                context.id,
                canonical,
                input.op,
                context.caller,
                now,
                input.reason ?? null,
                JSON.stringify(receipt),
              );
          }
          if (input.op === "clear_all") {
            if (!receipt.cleared) throw new Error();
            return {
              op: input.op,
              changed: receipt.changed,
              cleared: receipt.cleared,
              receipt,
              replay: existing !== null,
              current: this.list(registration, now),
            };
          }
          if (!target) invalid();
          return {
            op: input.op,
            target,
            changed: receipt.changed,
            receipt,
            replay: existing !== null,
            current: this.status(
              registration,
              target.channel,
              target.scope === "thread" ? target.thread_ts : undefined,
              now,
            ),
          };
        })
        .immediate();
    });
  }

  private counts(registration: string) {
    return countsSchema.parse(
      this.db
        .query<
          {
            thread: number;
            channel: number;
          },
          [string]
        >(`SELECT count(CASE WHEN thread<>'' THEN 1 END) AS thread,
      count(CASE WHEN thread='' THEN 1 END) AS channel
      FROM notification_settings WHERE registration=?`)
        .get(registration),
    );
  }

  private list(
    registration: string,
    now: number,
    cursor?: string,
  ): NotificationPage {
    const after = readCursor(cursor, registration);
    const rows = this.db
      .query<SavedSetting, [string, string, string]>(`
      SELECT channel,thread,mute_until,reason FROM notification_settings
      WHERE registration=? AND (channel,thread)>(?,?)
      ORDER BY channel,thread LIMIT ${pageSize + 1}
    `)
      .all(registration, after.channel, after.thread)
      .map((row) => savedSchema.parse(row));
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      settings: page.map((row) => ({
        target: targetOf(row),
        setting: settingOf(row, now),
      })),
      cursor:
        rows.length > pageSize && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                registration: registrationHash(registration),
                channel: last.channel,
                thread: last.thread,
              }),
            ).toString("base64url")
          : null,
      counts: this.counts(registration),
    };
  }
}
