import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import type { UpdateReceipt } from "./update-notice";

/**
 * Host-wide maintenance drain. One same-user directory holds a singleton run
 * marker and one private metadata file per live gateway. It is a control
 * barrier and a participant list only: queued work stays in the existing
 * gateway jobs, crew `pending_tasks` and Mesij mail.
 */
const int = Schema.Finite.check(Schema.isInt());
const positive = int.check(Schema.isGreaterThan(0));

const text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
);

export const maintenanceDrainSchema = Schema.Struct({
  schema: Schema.Literal("stargate.maintenance.drain.v1"),
  runID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:@+-]{1,100}$/)),
  pid: positive,
  job: Schema.Literals(["nightly", "outside-window", "operator-update"]),
  services: Schema.mutable(
    Schema.Array(Schema.Literals(["gateway", "opencode", "cliproxyapi"])),
  ).check(Schema.isMaxLength(3)),
  startedAt: positive,
  deadlineAt: positive,
  phase: Schema.Literals(["draining", "restarting", "completed", "aborted"]),
  stragglers: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          taskID: Schema.optional(text),
          sessionID: Schema.optional(text),
          reason: text,
        }),
      ),
    ).check(Schema.isMaxLength(1000)),
  ),
});

export type MaintenanceDrain = typeof maintenanceDrainSchema.Type;

const crewSchema = Schema.Struct({
  namespace: Schema.String,
  captainDirectory: Schema.String,
  stateDirectory: Schema.String,
  roots: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        directory: Schema.String,
        configPath: Schema.String,
        pluginPackage: Schema.String,
      }),
    ),
  ),
  worktreeDirectories: Schema.optional(
    Schema.mutable(Schema.Array(Schema.String)),
  ),
  piMembers: Schema.mutable(Schema.Array(Schema.String)),
  captainSessionID: Schema.optional(Schema.String),
});

type Crew = {
  namespace: string;
  captainDirectory: string;
  stateDirectory: string;
  roots: {
    directory: string;
    configPath: string;
    pluginPackage: string;
  }[];
  worktreeDirectories?: string[];
  piMembers: string[];
  captainSessionID?: string;
};

const participantSchema = Schema.Struct({
  pid: positive,
  dataDirectory: Schema.String,
  crews: Schema.mutable(Schema.Array(crewSchema)),
  pinnedSessions: Schema.mutable(Schema.Array(Schema.String)),
  unknown: Schema.optional(Schema.Literal(true)),
  noticeRunID: Schema.optional(Schema.String),
  noticePhase: Schema.optional(
    Schema.Literals(["draining", "completed", "aborted"]),
  ),
  noticeStatus: Schema.optional(Schema.Literals(["queued", "uncertain"])),
});

const participantFile = Schema.Struct({
  schema: Schema.Literal("stargate.maintenance.participant.v1"),
  registeredAt: positive,
  participant: participantSchema,
});

/** Private runtime metadata. `unknown` means crew discovery failed: treat as busy. */
export type DrainParticipant = {
  pid: number;
  dataDirectory: string;
  crews: Crew[];
  pinnedSessions: string[];
  /** Crew discovery failed: the list may be stale; treat the host as busy. */
  unknown?: true;
  noticeRunID?: string;
  noticePhase?: "draining" | "completed" | "aborted";
  noticeStatus?: "queued" | "uncertain";
};

const decodeDrain = Schema.decodeUnknownResult(maintenanceDrainSchema);
const decodeParticipant = Schema.decodeUnknownResult(participantFile);
const markerName = "drain.json";
const lockName = "drain.lock.sqlite";

const activePhases = new Set<MaintenanceDrain["phase"]>([
  "draining",
  "restarting",
]);

export const drainActivePhase = (phase: MaintenanceDrain["phase"]) =>
  activePhases.has(phase);

/**
 * One fixed same-user path. It deliberately ignores XDG_STATE_HOME: gateway,
 * OpenCode and maintenance services can set different values, and a barrier
 * that differs per process would silently not hold.
 */
export function maintenanceDrainDirectory() {
  return join(homedir(), ".local", "state", "stargate", "maintenance-drain");
}

/** Process start time (ms), Linux only; null when unreadable. */
function processStart(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    const boot = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));

    if (!Number.isFinite(ticks) || !boot?.[1]) return null;

    return Number(boot[1]) * 1000 + (ticks / 100) * 1000;
  } catch {
    return null;
  }
}

/** A live process that did not start after its record: no PID-reuse match. */
function alive(pid: number, since?: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }

  const started = since === undefined ? null : processStart(pid);

  return started === null || since === undefined || started <= since + 5000;
}

export type DrainState =
  | { state: "none" }
  | { state: "unknown" }
  | { state: "active"; record: MaintenanceDrain }
  | { state: "inactive"; record: MaintenanceDrain };

/** A malformed marker has no provable owner, so it can never hold the host. */
export function drainState(
  directory = maintenanceDrainDirectory(),
): DrainState {
  let raw: string;

  try {
    raw = readFileSync(join(directory, markerName), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "none" }
      : { state: "unknown" };
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return { state: "unknown" };
  }

  const parsed = decodeDrain(value);

  if (Result.isFailure(parsed)) return { state: "unknown" };
  const record = parsed.success;

  return drainActivePhase(record.phase) && alive(record.pid, record.startedAt)
    ? { state: "active", record }
    : { state: "inactive", record };
}

export function readMaintenanceDrain(
  directory = maintenanceDrainDirectory(),
): MaintenanceDrain | null {
  const state = drainState(directory);

  return "record" in state ? state.record : null;
}

/** The record while it holds the host: active phase and a live owner. */
export function activeMaintenanceDrain(
  directory = maintenanceDrainDirectory(),
): MaintenanceDrain | null {
  const state = drainState(directory);

  return state.state === "active" ? state.record : null;
}

/** Deadline alone never releases: only a terminal phase or a dead owner does. */
export function maintenanceDraining(
  directory = maintenanceDrainDirectory(),
): boolean {
  return drainState(directory).state === "active";
}

async function atomic(path: string, value: unknown) {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function locked<T>(directory: string, work: () => Promise<T>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, lockName);
  // As with the nightly run lock, SQLite owns exclusion and crash recovery.
  // Never unlink a lock: another process may already hold its replacement.
  await (await open(path, "a", 0o600)).close();
  const lock = new Database(path, { create: true });

  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch {
    lock.close();
    throw new Error("Maintenance drain control is busy");
  }

  try {
    return await work();
  } finally {
    lock.close();
  }
}

function validated(record: MaintenanceDrain) {
  const parsed = decodeDrain(record);

  if (Result.isFailure(parsed))
    throw new Error("Invalid maintenance drain record");

  return parsed.success;
}

function conflicts(state: DrainState, record: MaintenanceDrain) {
  return (
    state.state === "active" &&
    (state.record.pid !== record.pid || state.record.runID !== record.runID)
  );
}

/** Host singleton: refused while a different live owner holds an active run. */
export async function claimMaintenanceDrain(
  record: MaintenanceDrain,
  directory = maintenanceDrainDirectory(),
): Promise<void> {
  const next = validated(record);

  if (!drainActivePhase(next.phase))
    throw new Error("A maintenance drain claim needs an active phase");
  await locked(directory, async () => {
    if (conflicts(drainState(directory), next))
      throw new Error("Another maintenance run owns the drain");
    await atomic(join(directory, markerName), next);
  });
}

/** Owned phase transition. A finished run cannot become active again. */
export async function writeMaintenanceDrain(
  record: MaintenanceDrain,
  directory = maintenanceDrainDirectory(),
): Promise<void> {
  const next = validated(record);
  await locked(directory, async () => {
    const state = drainState(directory);

    if (conflicts(state, next))
      throw new Error("Another maintenance run owns the drain");

    if (
      state.state === "inactive" &&
      state.record.runID === next.runID &&
      !drainActivePhase(state.record.phase) &&
      drainActivePhase(next.phase)
    )
      throw new Error("A finished maintenance run cannot be resumed");
    await atomic(join(directory, markerName), next);
  });
}

// --- participants -----------------------------------------------------------

const participantPath = (directory: string, dataDirectory: string) =>
  join(
    directory,
    "participants",
    `${createHash("sha256").update(dataDirectory).digest("hex").slice(0, 32)}.json`,
  );

export type ParticipantHandle = {
  update(patch: {
    [K in keyof Omit<DrainParticipant, "pid" | "dataDirectory">]?:
      | DrainParticipant[K]
      | undefined;
  }): Promise<void>;
  close(): Promise<void>;
};

/** Writes this live runtime's private metadata; the handle removes it on exit. */
export async function registerDrainParticipant(
  initial: Omit<DrainParticipant, "pid">,
  directory = maintenanceDrainDirectory(),
): Promise<ParticipantHandle> {
  await mkdir(join(directory, "participants"), {
    recursive: true,
    mode: 0o700,
  });
  const path = participantPath(directory, initial.dataDirectory);
  const registeredAt = Date.now();
  let current: DrainParticipant = { ...initial, pid: process.pid };
  let chain: Promise<void> = Promise.resolve();

  const write = () =>
    (chain = chain.then(() =>
      atomic(path, {
        schema: "stargate.maintenance.participant.v1",
        registeredAt,
        participant: current,
      }),
    ));

  await write();

  return {
    update(patch) {
      const next: Record<string, unknown> = { ...current };

      for (const [key, value] of Object.entries(patch))
        if (value === undefined) delete next[key];
        else next[key] = value;
      current = next as DrainParticipant;

      return write();
    },
    async close() {
      await chain.catch(() => {});

      try {
        const file = decodeParticipant(
          JSON.parse(await readFile(path, "utf8")),
        );

        if (
          Result.isSuccess(file) &&
          file.success.participant.pid === process.pid
        )
          await unlink(path);
      } catch {
        // Already gone or replaced by a restart; nothing of ours remains.
      }
    },
  };
}

/** Live participants only, newest per data directory; includes unacknowledged ones. */
export function readDrainParticipants(
  directory = maintenanceDrainDirectory(),
): DrainParticipant[] {
  const folder = join(directory, "participants");
  let names: string[];

  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }

  const newest = new Map<string, { at: number; value: DrainParticipant }>();

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(folder, name);

    try {
      const parsed = decodeParticipant(JSON.parse(readFileSync(path, "utf8")));

      if (Result.isFailure(parsed)) continue;
      const { registeredAt, participant } = parsed.success;

      if (!alive(participant.pid, registeredAt)) {
        try {
          unlinkSync(path);
        } catch {
          // A concurrent reader removed it.
        }

        continue;
      }

      const seen = newest.get(participant.dataDirectory);

      if (!seen || seen.at < registeredAt)
        newest.set(participant.dataDirectory, {
          at: registeredAt,
          value: participant as unknown as DrainParticipant,
        });
    } catch {
      // Unreadable metadata is not a participant; it carries no secret to report.
    }
  }

  return [...newest.values()].map(({ value }) => value);
}

// --- notices ---------------------------------------------------------------

export const drainNoticePhase = (record: MaintenanceDrain) =>
  record.phase === "restarting" ? "draining" : record.phase;

/** Same ID for every producer, so a session receives each phase once. */
export const drainNoticeID = (
  runID: string,
  phase: "draining" | "completed" | "aborted",
  sessionID: string,
) =>
  `drain_${createHash("sha256")
    .update(`${runID}\0${phase}\0${sessionID}`)
    .digest("hex")
    .slice(0, 40)}`;

export const drainNoticeScope = /^drain_/;

export function drainNoticeText(record: MaintenanceDrain) {
  const phase = drainNoticePhase(record);
  const head = `Stargate maintenance notice (run ${record.runID}, ${record.job}; ${record.services.join(", ") || "no services"}).`;

  if (phase === "draining")
    return `${head} Maintenance is draining. Restart is planned by ${new Date(record.deadlineAt).toISOString()}, or sooner when all sessions are idle. New Stargate turns and crew dispatches are held: accepted messages stay queued and crew assignments queue durably. Running work finishes normally until that deadline. Held crew assignments resume automatically under their original captain after maintenance completes. This is information only: it asks for no acknowledgement and grants no permission.`;

  return `${head} ${phase === "completed" ? "Restart complete" : "Restart ended without completing"}. New turns and crew dispatches are released, and held crew assignments resume automatically under their original captain. This replaces any earlier maintenance notice for this run. It is information only and asks for no acknowledgement.`;
}

// --- runtime control -------------------------------------------------------

export type DrainHandler = {
  broadcast(
    record: MaintenanceDrain,
    signal: AbortSignal,
  ): Promise<UpdateReceipt[]>;
  /** Pump this backend's held crew queue; `remaining` counts tasks still held. */
  resume?(signal: AbortSignal): Promise<{ remaining: number }>;
};

/** What a gateway uses: the existing poll is the only pump. */
export type DrainControl = {
  held(): boolean;
  tick(): void;
  attach(handler: DrainHandler): void;
};

const terminal = (phase: MaintenanceDrain["phase"]) => !drainActivePhase(phase);
const noticeMs = 10_000;

/**
 * One per runtime process. Gateways call `tick` from their normal poll; the
 * controller observes the shared marker, queues each phase's passive notice
 * once, acknowledges it in the participant file, and only then releases new
 * starts and pumps drain-queued crew tasks.
 */
export class DrainRuntime implements DrainControl {
  private readonly handlers: DrainHandler[] = [];
  private handle: ParticipantHandle | undefined;
  private armed: MaintenanceDrain | undefined;
  private readonly done = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private resumeDue = true;
  private nextAt = 0;
  private refreshedAt = 0;
  private running: Promise<void> | undefined;
  private crews: Crew[] = [];
  private unknown = false;
  private closed = false;
  private readonly now: () => number;
  private readonly directory: string;

  public constructor(
    private readonly options: {
      dataDirectory: string;
      pinnedSessions: () => string[];
      discover: () => Promise<Crew[]>;
      warn: (message: string) => void;
      directory?: string;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.directory = options.directory ?? maintenanceDrainDirectory();
  }

  public attach(handler: DrainHandler) {
    this.handlers.push(handler);
  }

  /** Register before any worker starts so a run can never miss this runtime. */
  public async start() {
    await this.discover();
    this.handle = await registerDrainParticipant(
      {
        dataDirectory: this.options.dataDirectory,
        crews: this.crews,
        pinnedSessions: this.options.pinnedSessions(),
        ...(this.unknown ? { unknown: true as const } : {}),
      },
      this.directory,
    );
    this.refreshedAt = this.now();
  }

  public async close() {
    this.closed = true;
    await this.running?.catch(() => {});
    await this.handle?.close();
  }

  /** Re-read at the admission boundary; a prior poll must not hide a new drain. */
  public held() {
    const state = drainState(this.directory);

    return (
      state.state === "active" ||
      this.armed !== undefined ||
      (state.state === "inactive" && this.endDue(state.record))
    );
  }

  private endDue(record: MaintenanceDrain) {
    const phase = terminal(record.phase) ? record.phase : "aborted";

    return (
      this.now() <= Math.max(record.deadlineAt, record.startedAt) + 600_000 &&
      !this.done.has(`${record.runID}:${phase}`)
    );
  }

  public tick() {
    if (this.closed || this.running || this.now() < this.nextAt) return;
    this.nextAt = this.now() + 1000;
    this.running = this.step()
      .catch(() => this.options.warn("Maintenance drain observation failed"))
      .finally(() => {
        this.running = undefined;
      });
  }

  private async discover() {
    try {
      this.crews = await this.options.discover();
      this.unknown = false;
    } catch {
      // Keep the last known list and say so: the host gate treats it as busy.
      this.unknown = true;
    }
  }

  private async step() {
    if (this.now() - this.refreshedAt >= 30_000) {
      this.refreshedAt = this.now();
      await this.discover();
      await this.handle?.update({
        crews: this.crews,
        pinnedSessions: this.options.pinnedSessions(),
        ...(this.unknown ? { unknown: true as const } : { unknown: undefined }),
      });
    }

    const state = drainState(this.directory);

    if (state.state === "active") {
      this.armed = state.record;
      this.resumeDue = false;
      await this.notify(state.record);

      return;
    }

    const recorded = "record" in state ? state.record : undefined;
    let end: MaintenanceDrain | undefined;

    if (this.armed) {
      end =
        recorded?.runID === this.armed.runID && terminal(recorded.phase)
          ? recorded
          : { ...this.armed, phase: "aborted" };
    } else if (recorded && this.endDue(recorded))
      end = terminal(recorded.phase)
        ? recorded
        : { ...recorded, phase: "aborted" };

    if (end) {
      if (await this.notify(end)) {
        this.armed = undefined;
        this.resumeDue = true;
      }

      return;
    }

    if (this.resumeDue) await this.pump();
  }

  /** True once the phase's notice is queued, or its attempts are exhausted. */
  private async notify(record: MaintenanceDrain) {
    const phase = drainNoticePhase(record);
    const key = `${record.runID}:${phase}`;

    if (this.done.has(key)) return true;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    let ok = true;

    for (const handler of this.handlers) {
      try {
        const receipts = await handler.broadcast(
          record,
          AbortSignal.timeout(noticeMs),
        );

        if (receipts.some((receipt) => receipt.status === "uncertain"))
          ok = false;
      } catch {
        ok = false;
      }
    }

    await this.handle
      ?.update({
        noticeRunID: record.runID,
        noticePhase: phase,
        noticeStatus: ok ? "queued" : "uncertain",
      })
      .catch(() =>
        this.options.warn("Maintenance drain acknowledgement failed"),
      );

    if (ok || attempt >= 5) {
      this.done.add(key);

      return true;
    }

    this.nextAt = this.now() + 3000;

    return false;
  }

  private async pump() {
    let remaining = 0;
    let failed = false;

    for (const handler of this.handlers) {
      if (!handler.resume) continue;

      try {
        remaining += (await handler.resume(AbortSignal.timeout(noticeMs)))
          .remaining;
      } catch {
        failed = true;
      }
    }

    if (!failed && remaining === 0) this.resumeDue = false;
    else this.nextAt = this.now() + 5000;
  }
}
