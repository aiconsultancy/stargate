/**
 * Shared parts of the backends that run an agent CLI per turn (Claude Code,
 * Codex): the minimal child environment, UTF-8 text attachments, and finding
 * and stopping every process that a turn started.
 */
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Attachment } from "../chat/attachments/attachments";
import { AttachmentInputUnavailable } from "../shared/request-failure";

/**
 * Non-secret variables an agent CLI inherits. Everything else in Stargate's
 * environment, including Slack tokens and provider keys, is dropped.
 */
export const inheritedEnvironment = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
] as const;

/** The inherited variables that are set in `parent`. */
export function inherited(parent: NodeJS.ProcessEnv) {
  const env: Record<string, string> = {};

  for (const name of inheritedEnvironment) {
    const value = parent[name];

    if (value) env[name] = value;
  }

  return env;
}

const textTypes = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/javascript",
]);

/** True for MIME types read as UTF-8 text. */
export function isTextAttachment(file: Attachment) {
  return file.mime.startsWith("text/") || textTypes.has(file.mime);
}

/** The attachment as a labelled text block; refuses invalid or binary text. */
export function textAttachment(file: Attachment) {
  let decoded: string;

  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
  } catch {
    throw new AttachmentInputUnavailable(
      "Text attachments require valid UTF-8",
    );
  }

  if (
    file.data.some(
      (byte) =>
        byte === 127 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13),
    )
  )
    throw new AttachmentInputUnavailable(
      "Text attachment contains binary control bytes",
    );

  return `Attachment: ${file.name}\n${decoded}`;
}

/**
 * Every process of a turn inherits `variable` with a random `value`. Agent
 * CLIs run tool commands in their own sessions or sandboxes, outside any one
 * process group, so the marker is how Stargate finds what a turn left behind.
 */
export type TurnMarker = { variable: string; value: string };

/**
 * The Linux process table: `/proc`, this process's user ID and `kill`. Tests
 * use a fake root to simulate PID reuse.
 */
export type ProcessTable = {
  root: string;
  uid: number | undefined;
  kill(pid: number, signal: NodeJS.Signals): void;
};

export const systemProcesses: ProcessTable = {
  root: "/proc",
  uid: process.getuid?.(),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

/** A process found for a turn: its PID and start time pin its identity. */
export type TurnProcess = { pid: number; start: number };

/** A recorded CLI: the leader of its process group. */
export type TurnLeader = TurnProcess & { marker: TurnMarker; session: string };

/** Start time in clock ticks since boot: field 22 of `/proc/<pid>/stat`. */
export function statStart(stat: string) {
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}

/**
 * Now, in the clock ticks of `statStart` (Linux USER_HZ, 100), less a small
 * margin: no process started by a turn that begins now can be older. Zero
 * without `/proc`, where nothing is found anyway.
 */
export async function bootTicks(table: ProcessTable = systemProcesses) {
  try {
    const uptime = Number(
      (await readFile(join(table.root, "uptime"), "utf8")).split(" ")[0],
    );

    return Number.isFinite(uptime)
      ? Math.max(0, Math.floor(uptime * 100) - 2)
      : 0;
  } catch {
    return 0;
  }
}

/** Start time, process group (field 5) and the four user IDs. */
function facts(stat: string, status: string) {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const start = Number(fields[19]);
  const group = Number(fields[2]);
  const uids = /^Uid:[ \t]+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(group) || !uids)
    return;

  return { start, group, uids };
}

/** Real, effective, saved and filesystem user IDs are all Stargate's own. */
function owned(table: ProcessTable, uids: readonly string[]) {
  return (
    table.uid !== undefined &&
    uids.length === 4 &&
    uids.every((uid) => uid === String(table.uid))
  );
}

function carries(environ: Buffer, marker: TurnMarker) {
  return Buffer.concat([Buffer.from([0]), environ]).includes(
    Buffer.from(`\0${marker.variable}=${marker.value}\0`),
  );
}

/** One process's facts and environment, read now and synchronously. */
function inspect(table: ProcessTable, pid: number) {
  try {
    const base = join(table.root, String(pid));

    const known = facts(
      readFileSync(join(base, "stat"), "utf8"),
      readFileSync(join(base, "status"), "utf8"),
    );

    return known && { ...known, environ: readFileSync(join(base, "environ")) };
  } catch {
    return;
  }
}

/**
 * Processes of Stargate's user that started at or after `since` and carry the
 * turn marker. Linux only: without `/proc` nothing is found.
 */
export async function turnProcesses(
  table: ProcessTable,
  marker: TurnMarker,
  since: number,
): Promise<TurnProcess[]> {
  let entries: string[];

  try {
    entries = await readdir(table.root);
  } catch {
    return [];
  }

  const found: TurnProcess[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) return;

      try {
        const base = join(table.root, entry);

        const known = facts(
          await readFile(join(base, "stat"), "utf8"),
          await readFile(join(base, "status"), "utf8"),
        );

        if (!known || known.start < since || !owned(table, known.uids)) return;

        if (carries(await readFile(join(base, "environ")), marker))
          found.push({ pid: Number(entry), start: known.start });
      } catch {
        // Gone, or not readable by this user.
      }
    }),
  );

  return found.toSorted((a, b) => a.pid - b.pid);
}

/**
 * Signal each process only while it is still the one that was found: the
 * same start time, all user IDs Stargate's, and the turn marker. Bun and Node
 * have no pidfd API, so the check and `kill` run synchronously, without
 * yielding; a PID could change owner only inside that window. Returns the
 * number signalled.
 */
export function signalTurnProcesses(
  table: ProcessTable,
  processes: readonly TurnProcess[],
  marker: TurnMarker,
  signal: NodeJS.Signals,
) {
  let sent = 0;

  for (const { pid, start } of processes) {
    const now = inspect(table, pid);

    if (
      !now ||
      now.start !== start ||
      !owned(table, now.uids) ||
      !carries(now.environ, marker)
    )
      continue;

    try {
      table.kill(pid, signal);
      sent++;
    } catch {
      // Exited after the check.
    }
  }

  return sent;
}

/**
 * True while the recorded CLI still leads its group: same start time, Stargate's
 * user, the turn marker and the session ID in its arguments. While it lives,
 * its group ID cannot be reused.
 */
function leads(table: ProcessTable, leader: TurnLeader) {
  const now = inspect(table, leader.pid);

  if (
    !now ||
    now.start !== leader.start ||
    now.group !== leader.pid ||
    !owned(table, now.uids) ||
    !carries(now.environ, leader.marker)
  )
    return false;

  try {
    return readFileSync(join(table.root, String(leader.pid), "cmdline"), "utf8")
      .split("\0")
      .some((argument) => argument.includes(leader.session));
  } catch {
    return false;
  }
}

/** Signal a recorded CLI's group only after `leads` holds, synchronously. */
export function signalTurnGroup(
  table: ProcessTable,
  leader: TurnLeader,
  signal: NodeJS.Signals,
) {
  if (!leads(table, leader)) return false;

  try {
    table.kill(-leader.pid, signal);

    return true;
  } catch {
    return false;
  }
}

async function until(
  done: () => boolean | Promise<boolean>,
  ms: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + ms;

  while (!(await done())) {
    if (Date.now() >= deadline || signal?.aborted) return false;
    await delay(50);
  }

  return true;
}

/** SIGTERM a recorded CLI's group, then SIGKILL it if it still leads. */
export async function stopTurnGroup(
  table: ProcessTable,
  leader: TurnLeader,
  grace: number,
  signal?: AbortSignal,
) {
  const gone = () => !leads(table, leader);

  if (!signalTurnGroup(table, leader, "SIGTERM")) return;

  if (await until(gone, grace, signal)) return;

  if (signalTurnGroup(table, leader, "SIGKILL")) await until(gone, grace);
}

/** SIGTERM a turn's processes, then SIGKILL whatever remains after `grace`. */
export async function stopTurnProcesses(
  table: ProcessTable,
  marker: TurnMarker,
  since: number,
  grace: number,
  signal?: AbortSignal,
) {
  const left = () => turnProcesses(table, marker, since);
  const gone = async () => (await left()).length === 0;

  if (!signalTurnProcesses(table, await left(), marker, "SIGTERM")) return;

  if (await until(gone, grace, signal)) return;

  if (signalTurnProcesses(table, await left(), marker, "SIGKILL"))
    await until(gone, grace);
}
