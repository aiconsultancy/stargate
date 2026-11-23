import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Result, Schema } from "effect";
import { settingsStruct } from "../../config/settings-schema";
import {
  type Accepted,
  Audience,
  Destination,
  DisplayPayload,
  Id,
  type Limits,
  NotificationInput,
  Source,
  StoreUnavailable,
  audienceAllowed,
  notificationLimits,
  physicalKey,
  sourceScope,
} from "./model";
import { signature } from "./signature";
import type { DeliveryDestination, SinkOutcome } from "./sink";

const persistedInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

const persistedScope = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const decoded = Schema.decodeUnknownResult(Schema.Tuple([Id, Id]))(
        JSON.parse(value),
      );

      return (
        Result.isSuccess(decoded) && JSON.stringify(decoded.success) === value
      );
    } catch {
      return false;
    }
  }),
);

const DedupRow = settingsStruct({
  scope: persistedScope,
  signature: Schema.String.check(Schema.isPattern(/^v1:[a-f0-9]{64}$/)),
  admittedAt: persistedInteger,
});

const StoredRow = settingsStruct({
  ...DedupRow.fields,
  id: persistedInteger.check(Schema.isGreaterThan(0)),
  destinationKey: Schema.String.check(Schema.isMaxLength(300)),
  destination: Schema.String.check(Schema.isMaxLength(4096)),
  sourceAudience: Audience,
  payload: Schema.String.check(Schema.isMaxLength(65_536)),
  state: Schema.Literals(["pending", "leased"]),
  attempts: persistedInteger,
  nextAt: persistedInteger,
  leaseEnd: Schema.NullOr(persistedInteger),
}).check(
  Schema.makeFilter(
    (row) => (row.state === "pending") === (row.leaseEnd === null),
  ),
);

type StoredRow = typeof StoredRow.Type;

export interface Claim extends Omit<StoredRow, "payload" | "destination"> {
  readonly destination: DeliveryDestination;
  readonly payload: DisplayPayload;
}

export interface NotificationCounters {
  accepted: number;
  duplicate: number;
  sent: number;
  refused: number;
  replayed: number;
  dropped: number;
}

function checkTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new StoreUnavailable();
}

function privateFile(path: string, create: boolean) {
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0),
    0o600,
  );

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1)
      throw new StoreUnavailable();
    fchmodSync(fd, 0o600);

    return stat;
  } finally {
    closeSync(fd);
  }
}

function readClaim(row: StoredRow): Claim {
  if (Result.isFailure(Schema.decodeUnknownResult(StoredRow)(row)))
    throw new StoreUnavailable();

  const destination = Schema.decodeUnknownResult(Destination)(
    JSON.parse(row.destination),
  );

  const payload = Schema.decodeUnknownResult(DisplayPayload)(
    JSON.parse(row.payload),
  );

  if (
    Result.isFailure(destination) ||
    Result.isFailure(payload) ||
    !audienceAllowed(row.sourceAudience, destination.success.audience) ||
    physicalKey(destination.success) !== row.destinationKey
  )
    throw new StoreUnavailable();

  return {
    ...row,
    destination: { ...destination.success, sourceAudience: row.sourceAudience },
    payload: payload.success,
  };
}

/** Sole process owner must hold the runtime instance lock before acquisition.
 * No transaction spans an await. No store operation calls a provider.
 */
export class NotifyStore {
  private readonly db: Database;
  public readonly limits: Limits;
  public readonly counters: NotificationCounters = {
    accepted: 0,
    duplicate: 0,
    sent: 0,
    refused: 0,
    replayed: 0,
    dropped: 0,
  };
  private readonly active = new Map<number, string>();
  private readonly gates = new Map<string, number>();
  private closed = false;

  public constructor(
    path: string,
    limits: Partial<Limits> = {},
    /** Narrow transaction fault/crash seam. Never used by the runtime. */
    private readonly beforeAdmissionCommit?: () => void,
  ) {
    this.limits = notificationLimits(limits);
    let database: Database | undefined;

    try {
      if (path === ":memory:") throw new StoreUnavailable();
      const absolute = resolve(path);
      const directory = dirname(absolute);
      mkdirSync(directory, { recursive: true, mode: 0o700 });

      if (realpathSync(directory) !== directory) throw new StoreUnavailable();

      const directoryFd = openSync(
        directory,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );

      try {
        const stat = fstatSync(directoryFd);

        if (stat.uid !== process.getuid?.()) throw new StoreUnavailable();
        fchmodSync(directoryFd, 0o700);
      } finally {
        closeSync(directoryFd);
      }

      const original = privateFile(absolute, true);

      // Refuse hostile sidecar paths before SQLite can follow them.
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try {
          lstatSync(absolute + suffix);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            continue;
          throw error;
        }

        privateFile(absolute + suffix, false);
      }

      if (original.size > 0) {
        const probe = new Database(absolute, { readonly: true, strict: true });

        try {
          if (
            probe.query<{ quick_check: string }, []>("PRAGMA quick_check").get()
              ?.quick_check !== "ok" ||
            probe
              .query<{ user_version: number }, []>("PRAGMA user_version")
              .get()?.user_version !== 1
          )
            throw new StoreUnavailable();
          probe
            .query(
              "SELECT scope,signature,admittedAt FROM notify_dedup LIMIT 0",
            )
            .all();
          probe
            .query(
              "SELECT id,scope,signature,destinationKey,destination,sourceAudience,payload,admittedAt,state,attempts,nextAt,leaseEnd FROM notify_outbox LIMIT 0",
            )
            .all();

          if (probe.query("PRAGMA foreign_key_check").get() !== null)
            throw new StoreUnavailable();

          for (const row of probe
            .query("SELECT * FROM notify_dedup")
            .iterate()) {
            if (Result.isFailure(Schema.decodeUnknownResult(DedupRow)(row)))
              throw new StoreUnavailable();
          }

          for (const row of probe
            .query<StoredRow, []>("SELECT * FROM notify_outbox")
            .iterate())
            readClaim(row);
        } finally {
          probe.close();
        }
      }

      const current = lstatSync(absolute);

      if (
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        current.isSymbolicLink()
      )
        throw new StoreUnavailable();
      database = new Database(absolute, { create: true, strict: true });
      database.run(
        "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
      );

      if (original.size === 0)
        database
          .transaction(() => {
            database?.run(`
          CREATE TABLE notify_dedup (
            scope TEXT NOT NULL, signature TEXT NOT NULL, admittedAt INTEGER NOT NULL,
            PRIMARY KEY(scope,signature)
          );
          CREATE TABLE notify_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL, signature TEXT NOT NULL, destinationKey TEXT NOT NULL,
            destination TEXT NOT NULL, sourceAudience TEXT NOT NULL CHECK(sourceAudience IN ('internal','public')),
            payload TEXT NOT NULL, admittedAt INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','leased')),
            attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), nextAt INTEGER NOT NULL,
            leaseEnd INTEGER,
            UNIQUE(scope,signature,destinationKey),
            FOREIGN KEY(scope,signature) REFERENCES notify_dedup(scope,signature),
            CHECK((state='pending' AND leaseEnd IS NULL) OR (state='leased' AND leaseEnd IS NOT NULL))
          );
          CREATE INDEX notify_due ON notify_outbox(state,nextAt,id);
          CREATE INDEX notify_destination ON notify_outbox(destinationKey,id);
          CREATE UNIQUE INDEX notify_one_lease ON notify_outbox(destinationKey) WHERE state='leased';
          PRAGMA user_version = 1;
        `);
          })
          .immediate();
      this.db = database;
    } catch {
      database?.close();
      throw new StoreUnavailable();
    }
  }

  private transaction<A>(run: () => A): A {
    if (this.closed) throw new StoreUnavailable();

    try {
      return this.db.transaction(run).immediate();
    } catch {
      throw new StoreUnavailable();
    }
  }

  private count(table: "notify_outbox" | "notify_dedup"): number {
    return (
      this.db
        .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
        .get()?.n ?? 0
    );
  }

  private pruneCompleted(now: number, capacity: boolean) {
    this.db
      .query(`DELETE FROM notify_dedup WHERE admittedAt <= ? AND NOT EXISTS (
      SELECT 1 FROM notify_outbox o WHERE o.scope=notify_dedup.scope AND o.signature=notify_dedup.signature
    )`)
      .run(now - this.limits.dedupMs);

    if (capacity) {
      const remove = this.count("notify_dedup") - this.limits.dedupRecords + 1;

      if (remove > 0)
        this.db
          .query(`DELETE FROM notify_dedup WHERE rowid IN (
        SELECT d.rowid FROM notify_dedup d WHERE NOT EXISTS (
          SELECT 1 FROM notify_outbox o WHERE o.scope=d.scope AND o.signature=d.signature
        ) ORDER BY d.admittedAt,d.rowid LIMIT ?
      )`)
          .run(remove);
    }
  }

  /** Resolver runs only for a new event, after dedup, inside the transaction. */
  public admit(
    source: Source,
    input: NotificationInput,
    destinations: () => readonly Destination[],
    now: number,
  ): Accepted {
    checkTime(now);
    const checkedSource = Schema.decodeUnknownResult(Source)(source);
    const checkedInput = Schema.decodeUnknownResult(NotificationInput)(input);

    if (Result.isFailure(checkedSource) || Result.isFailure(checkedInput))
      throw new StoreUnavailable();
    const scope = sourceScope(checkedSource.success);
    const sig = signature(checkedSource.success, checkedInput.success);

    const result = this.transaction(() => {
      if (
        this.db
          .query("SELECT 1 FROM notify_dedup WHERE scope=? AND signature=?")
          .get(scope, sig) !== null
      )
        return { duplicate: true, evicted: 0 };
      const selected = new Map<string, Destination>();

      for (const raw of destinations()) {
        const decoded = Schema.decodeUnknownResult(Destination)(raw);

        if (
          Result.isFailure(decoded) ||
          !audienceAllowed(source.audience, decoded.success.audience)
        )
          throw new StoreUnavailable();
        const destination = decoded.success;
        const key = physicalKey(destination);
        const existing = selected.get(key);

        if (
          existing &&
          (existing.registrationId !== destination.registrationId ||
            existing.audience !== destination.audience)
        )
          throw new StoreUnavailable();
        selected.set(key, destination);
      }

      if (selected.size > 128) throw new StoreUnavailable();
      let evicted = 0;

      for (const key of selected.keys()) {
        const count =
          this.db
            .query<{ n: number }, [string]>(
              "SELECT count(*) AS n FROM notify_outbox WHERE destinationKey=?",
            )
            .get(key)?.n ?? 0;

        const remove = Math.max(0, count - this.limits.perDestination + 1);

        if (remove) {
          const victims = this.db
            .query<{ id: number }, [string, number]>(
              "SELECT id FROM notify_outbox WHERE destinationKey=? AND state='pending' ORDER BY admittedAt,id LIMIT ?",
            )
            .all(key, remove);

          if (victims.length !== remove) throw new StoreUnavailable();

          for (const victim of victims)
            this.db
              .query("DELETE FROM notify_outbox WHERE id=? AND state='pending'")
              .run(victim.id);
          evicted += remove;
        }
      }

      this.pruneCompleted(now, true);

      if (
        this.count("notify_outbox") + selected.size > this.limits.outboxRows ||
        this.count("notify_dedup") >= this.limits.dedupRecords
      )
        throw new StoreUnavailable();
      this.db
        .query(
          "INSERT INTO notify_dedup(scope,signature,admittedAt) VALUES(?,?,?)",
        )
        .run(scope, sig, now);

      for (const [key, destination] of selected) {
        const persistedGate =
          this.db
            .query<{ gate: number | null }, [string]>(
              "SELECT max(nextAt) AS gate FROM notify_outbox WHERE destinationKey=?",
            )
            .get(key)?.gate ?? now;

        this.db
          .query(`INSERT INTO notify_outbox(scope,signature,destinationKey,destination,sourceAudience,payload,admittedAt,state,attempts,nextAt)
          VALUES(?,?,?,?,?,?,?,'pending',0,?)`)
          .run(
            scope,
            sig,
            key,
            JSON.stringify(destination),
            source.audience,
            JSON.stringify(checkedInput.success.payload),
            now,
            Math.max(now, persistedGate, this.gates.get(key) ?? 0),
          );
      }

      this.beforeAdmissionCommit?.();

      return { duplicate: false, evicted };
    });

    if (result.duplicate) this.counters.duplicate++;
    else {
      this.counters.accepted++;
      this.counters.dropped += result.evicted;
    }

    return { signature: sig, duplicate: result.duplicate };
  }

  /** Startup only, under sole ownership. Live leases are never reclaimed. */
  public recover(now: number) {
    checkTime(now);

    if (this.active.size > 0) throw new StoreUnavailable();

    const recovered = this.transaction(() => {
      const dropped = this.db
        .query(
          "DELETE FROM notify_outbox WHERE attempts >= ? OR admittedAt <= ?",
        )
        .run(this.limits.sendAttempts, now - this.limits.maxAgeMs).changes;

      const replayed = this.db
        .query(
          "UPDATE notify_outbox SET state='pending',leaseEnd=NULL,nextAt=? WHERE state='leased'",
        )
        .run(now).changes;

      this.pruneCompleted(now, false);

      return { dropped, replayed };
    });

    this.counters.dropped += recovered.dropped;
    this.counters.replayed += recovered.replayed;
  }

  public claim(now: number): Claim | undefined {
    checkTime(now);

    const result = this.transaction(() => {
      const dropped = this.db
        .query(
          "DELETE FROM notify_outbox WHERE state='pending' AND (attempts >= ? OR admittedAt <= ?)",
        )
        .run(this.limits.sendAttempts, now - this.limits.maxAgeMs).changes;

      this.pruneCompleted(now, false);

      if (this.active.size >= this.limits.concurrency)
        return { dropped, claim: undefined };

      const row = this.db
        .query<
          StoredRow,
          [number]
        >(`SELECT * FROM notify_outbox o WHERE state='pending' AND nextAt <= ?
        AND NOT EXISTS (SELECT 1 FROM notify_outbox l WHERE l.destinationKey=o.destinationKey AND l.state='leased')
        ORDER BY nextAt,id LIMIT 1`)
        .get(now);

      if (!row) return { dropped, claim: undefined };

      const claim = readClaim({
        ...row,
        state: "leased",
        attempts: row.attempts + 1,
        leaseEnd: now + this.limits.leaseMs,
      });

      this.db
        .query(
          "UPDATE notify_outbox SET state='leased',attempts=attempts+1,leaseEnd=? WHERE id=?",
        )
        .run(claim.leaseEnd, row.id);
      this.db
        .query(
          "UPDATE notify_outbox SET nextAt=max(nextAt,?) WHERE destinationKey=?",
        )
        .run(now + this.limits.spacingMs, row.destinationKey);

      return { dropped, claim };
    });

    this.counters.dropped += result.dropped;

    if (result.claim) {
      this.active.set(result.claim.id, result.claim.destinationKey);
      this.gates.set(result.claim.destinationKey, now + this.limits.spacingMs);
    }

    // Gates have only configured destination keys and expire when not needed.
    for (const [key, gate] of this.gates)
      if (gate <= now && ![...this.active.values()].includes(key))
        this.gates.delete(key);

    return result.claim;
  }

  public settle(claim: Claim, outcome: SinkOutcome, now: number) {
    checkTime(now);

    if (this.active.get(claim.id) !== claim.destinationKey)
      throw new StoreUnavailable();

    try {
      const terminal =
        outcome.state === "sent" ||
        (outcome.state === "refused" && !outcome.retryable);

      const dropped =
        !terminal &&
        (claim.attempts >= this.limits.sendAttempts ||
          now - claim.admittedAt >= this.limits.maxAgeMs);

      const backoff = Math.min(
        60_000,
        1000 * 2 ** Math.min(claim.attempts - 1, 16),
      );

      const retryAfter =
        outcome.state === "refused" &&
        outcome.retryAfterMs !== undefined &&
        Number.isFinite(outcome.retryAfterMs) &&
        outcome.retryAfterMs > 0
          ? Math.min(
              Math.ceil(outcome.retryAfterMs),
              Number.MAX_SAFE_INTEGER - now,
            )
          : 0;

      const nextAt = Math.max(
        this.gates.get(claim.destinationKey) ?? 0,
        now + backoff,
        now + retryAfter,
      );

      this.transaction(() => {
        if (terminal || dropped)
          this.db
            .query("DELETE FROM notify_outbox WHERE id=? AND state='leased'")
            .run(claim.id);
        else
          this.db
            .query(
              "UPDATE notify_outbox SET state='pending',leaseEnd=NULL,nextAt=? WHERE id=? AND state='leased'",
            )
            .run(nextAt, claim.id);

        // Rate limiting and ambiguity gate the physical channel, not only this row.
        if (!terminal)
          this.db
            .query(
              "UPDATE notify_outbox SET nextAt=max(nextAt,?) WHERE destinationKey=?",
            )
            .run(nextAt, claim.destinationKey);
      });

      if (!terminal) this.gates.set(claim.destinationKey, nextAt);

      if (outcome.state === "sent") this.counters.sent++;
      else if (outcome.state === "refused" && !outcome.retryable) {
        this.counters.refused++;
        this.counters.dropped++;
      } else if (dropped) this.counters.dropped++;
      else if (outcome.state === "unknown") this.counters.replayed++;
    } finally {
      this.active.delete(claim.id);
    }
  }

  public close() {
    if (this.active.size > 0) throw new StoreUnavailable();

    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
