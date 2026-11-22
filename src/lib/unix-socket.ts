// Adapted from CFP Starfleet Teams 0.4.0; transport logic is independent of Claude Code.
// Unix socket listeners for the Teams endpoint and the fleet bus.
//
// Each socket lives in a directory that only its ship's user can write
// (tmpfiles.d creates it with mode 2750), so no other local user can create,
// replace or squat on the socket. The socket is created under umask 0117, so it
// is born mode 0660 with no chmod race, and the setgid directory gives it the
// group that may connect: cloudflared for the Teams socket, fleet for the bus.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";

export const SOCKET_UMASK = 0o117;
export const SOCKET_MODE = 0o660;
// The start-up lock: held only while a starter checks, removes and binds the socket.
export const LOCK_WAIT_MS = 10_000;
const LOCK_RELEASE_WAIT_MS = 2_000;

export class SocketBusyError extends Error {}
// The caller stopped (the bridge is shutting down) before the socket was bound.
export class StartAbortedError extends Error {}
// The process holding the start-up lock went away before the socket was bound, so
// another starter may now hold it. Nothing was removed or bound; try again, as for
// a busy socket.
export class StartupLockLostError extends Error {}

// The start-up lock as the code it protects sees it: stillHeld() turns false once
// the process holding the lock has gone, for example because it was killed.
export type StartupLock = { stillHeld: () => boolean };

// The socket file this process created, so shutdown removes that file and no other:
// its device and inode, and the inode's change time. Device and inode alone are not
// enough. ext4, xfs and overlay filesystems give a new file the inode number of one
// just removed, so a socket bound at the same path straight afterwards would look
// the same. tmpfs, where the fleet VM's /run lives, does not reuse them at once.
// The change time tells the two apart on any of them, unless both were created
// within one tick of the filesystem clock, a few milliseconds.
export type SocketIdentity = { dev: bigint; ino: bigint; ctimeNs: bigint };

function identityOf(stats: BigIntStats): SocketIdentity {
  return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs };
}

const sameFile = (a: SocketIdentity, b: SocketIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs;

// signal stops a start in progress. uid, umask, connectTo, lockWaitMs and
// lockCommand are overridable only so tests can exercise the checks.
export type Ownership = {
  /** Private API opt-in. Existing group sockets retain mode 0660. */
  mode?: 0o600;
  uid?: number;
  umask?: number;
  connectTo?: (path: string) => Socket;
  lockWaitMs?: number;
  signal?: AbortSignal;
  lockCommand?: LockCommand;
};

// The command that takes the kernel lock and holds it. It must take an exclusive
// flock(2) on lockPath, waiting up to waitSeconds, write one byte to standard
// output once it holds the lock, hold it until its standard input closes, and
// exit 1 without writing anything if it cannot get the lock in time.
export type LockCommand = (
  lockPath: string,
  waitSeconds: number,
) => { command: string; args: string[] };

// util-linux flock, as on Ubuntu 24.04: "printf R" signals the lock is held, and
// cat keeps it until the bridge closes the pipe.
export const flockCommand: LockCommand = (lockPath, waitSeconds) => ({
  command: "flock",
  args: [
    ...(waitSeconds > 0 ? ["-x", "-w", String(waitSeconds)] : ["-x", "-n"]),
    lockPath,
    "sh",
    "-c",
    "printf R; exec cat",
  ],
});

let defaultLockCommand: LockCommand = flockCommand;

/**
 * @internal Test-only: lets the suite run where util-linux flock is missing, such
 * as macOS. No production module may call it, which a test checks.
 */
export function setDefaultLockCommandForTests(command: LockCommand): void {
  defaultLockCommand = command;
}

function currentUid(options: Ownership): number {
  if (options.uid !== undefined) return options.uid;
  if (typeof process.getuid !== "function")
    throw new Error("Unix sockets need a POSIX platform");
  return process.getuid();
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// For a socket file: one lstat gives both the checks and the identity.
function lstatSocketOrUndefined(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// Paths are checked and bound exactly as given, so they must be absolute and already
// normalised: no "." or ".." segment and no doubled or trailing slash (resolve()
// also makes a relative path absolute). Otherwise the checks and the bind could see
// different paths: lstat of "/safe/link/." follows the symlink "link", which a walk
// of the normalised path would never examine.
function checkNormalised(path: string, what: string): void {
  if (path !== resolve(path))
    throw new Error(`${what} ${path} is not an absolute, normalised path`);
}

// The directory must be a real directory (not a symlink), owned by this user and
// writable by nobody else. The setgid bit is expected. Every directory above it must
// be safe too (see checkAncestors), and is checked first.
export function checkPrivateDirectory(
  dir: string,
  options: Ownership = {},
): void {
  checkNormalised(dir, "socket directory");
  checkAncestors(dir, currentUid(options));
  const stats = lstatOrUndefined(dir);
  if (!stats) throw new Error(`socket directory ${dir} does not exist`);
  if (stats.isSymbolicLink())
    throw new Error(`socket directory ${dir} is a symlink`);
  if (!stats.isDirectory())
    throw new Error(`socket directory ${dir} is not a directory`);
  if (stats.uid !== currentUid(options))
    throw new Error(`socket directory ${dir} is not owned by this user`);
  if (stats.mode & 0o022) {
    throw new Error(
      `socket directory ${dir} is writable by its group or by others (mode ${(stats.mode & 0o7777).toString(8)})`,
    );
  }
  if (options.mode === 0o600 && (stats.mode & 0o7777) !== 0o700)
    throw new Error(`private socket directory ${dir} must have mode 0700`);
}

// Whoever can write a directory can rename what is in it, so anyone able to write
// an ancestor could move the socket directory aside and put their own in its place.
// So every ancestor, from the parent up to /, must be a real directory (a symlink
// is never followed), owned by root or this user, and writable by neither its group
// nor others. A sticky directory such as /tmp is the exception: others may write
// it, but its sticky bit stops them renaming or removing an entry they do not own.
// That is enough because the entry below it is always owned by root or this user:
// every ancestor and the socket directory itself must be.
function checkAncestors(dir: string, uid: number): void {
  let current = dir;
  while (current !== dirname(current)) {
    current = dirname(current);
    const stats = lstatOrUndefined(current);
    if (!stats) throw new Error(`socket directory ${dir} does not exist`);
    if (stats.isSymbolicLink())
      throw new Error(`socket directory ancestor ${current} is a symlink`);
    if (stats.uid !== 0 && stats.uid !== uid)
      throw new Error(
        `socket directory ancestor ${current} is owned by uid ${stats.uid}, not root or this user`,
      );
    if (stats.mode & 0o022 && !(stats.mode & 0o1000)) {
      throw new Error(
        `socket directory ancestor ${current} is writable by its group or by others and is not sticky (mode ${(stats.mode & 0o7777).toString(8)})`,
      );
    }
  }
}

// Fails closed if the start-up lock has gone: called immediately before each step
// that only the lock holder may take. Node learns that the holding process died
// from its exit event, so a loss it has not yet seen cannot be caught here; this
// catches every loss seen by then, such as the holder being killed during the
// liveness probe.
function ensureStillHeld(lock: StartupLock, path: string, step: string): void {
  if (!lock.stillHeld())
    throw new StartupLockLostError(
      `lost the start-up lock for ${path} before ${step}`,
    );
}

// Dead means nothing is bound: the connection is refused or the file has gone.
// Anything else, including a timeout or a full backlog (EAGAIN), may be a live
// process, so it counts as live and the socket is left alone.
const DEAD_SOCKET_CODES = new Set(["ECONNREFUSED", "ENOENT"]);

export function isLiveSocket(
  path: string,
  timeoutMs = 1_000,
  connectTo: (path: string) => Socket = connect,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTo(path);
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(timeoutMs, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(!DEAD_SOCKET_CODES.has(err.code ?? "")),
    );
  });
}

// Removes a socket left behind by this user's own process that died. Anything
// else at the path is left alone: a live socket, a socket another user owns,
// a symlink (never followed) or any other kind of file. If the path changes
// while the liveness probe runs, for example because another starter bound a
// new socket there, nothing is removed and the caller retries. Nor is anything
// removed once the start-up lock has been lost.
export async function removeStaleSocket(
  path: string,
  lock: StartupLock,
  options: Ownership = {},
): Promise<void> {
  const stats = lstatSocketOrUndefined(path);
  if (!stats) return;
  if (stats.isSymbolicLink())
    throw new Error(`${path} is a symlink; refusing to use or remove it`);
  if (!stats.isSocket())
    throw new Error(
      `${path} exists and is not a socket; refusing to remove it`,
    );
  if (Number(stats.uid) !== currentUid(options))
    throw new Error(`${path} is owned by another user; refusing to remove it`);
  if (await isLiveSocket(path, 1_000, options.connectTo))
    throw new SocketBusyError(`${path} is served by another process`);
  const again = lstatSocketOrUndefined(path);
  if (again && !sameFile(identityOf(stats), identityOf(again)))
    throw new SocketBusyError(
      `${path} was replaced while it was being checked`,
    );
  ensureStillHeld(lock, path, "removing the stale socket");
  try {
    unlinkSync(path);
  } catch (err) {
    // Its owner removed it in the meantime: the path is free, which is the goal.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function listenNow(server: Server, path: string, umask: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // This relies on Node binding a Unix socket synchronously inside
    // server.listen(path), as it does outside a cluster worker: bind(2) runs before
    // listen() returns, and only the 'listening' event waits. So the umask applies
    // to this socket alone and is restored straight away, and nothing runs between
    // the lock check in checkAndBind and the bind. A test pins the behaviour.
    const previous = process.umask(umask);
    try {
      server.listen(path);
    } finally {
      process.umask(previous);
    }
  });
}

type HeldLock = StartupLock & { release: () => Promise<void> };

// Takes the kernel lock through a child process that holds it. The kernel
// releases a flock(2) lock when the last descriptor on it closes, so the lock can
// never be left behind: if the bridge exits or is killed, the child's standard
// input closes, the child exits and the lock goes with it. If the child is killed,
// the lock goes at once. There is nothing stale to detect and nothing to clean up,
// so no starter ever removes another's lock. The lock file itself stays in place
// for good: deleting a file others may be locking would break the exclusion.
function acquireKernelLock(
  lockPath: string,
  options: Ownership,
): Promise<HeldLock> {
  const waitSeconds = Math.max(0, (options.lockWaitMs ?? LOCK_WAIT_MS) / 1000);
  const { command, args } = (options.lockCommand ?? defaultLockCommand)(
    lockPath,
    waitSeconds,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let alive = true;
    let stderr = "";
    const exited = new Promise<void>((done) =>
      child.once("exit", () => {
        alive = false;
        done();
      }),
    );
    const release = async () => {
      child.stdin.end();
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        LOCK_RELEASE_WAIT_MS,
      );
      await exited;
      clearTimeout(timer);
    };
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (err) {
        child.kill("SIGKILL");
        reject(err);
      } else resolve({ release, stillHeld: () => alive });
    };
    const onAbort = () =>
      settle(new StartAbortedError(`stopped before ${lockPath} was taken`));
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString("utf8");
    });
    child.stdout.once("data", () => settle());
    child.once("error", (err) =>
      settle(
        new Error(
          `cannot run ${command} for the start-up lock: ${err.message}`,
        ),
      ),
    );
    child.once("exit", (code) => {
      if (code === 1)
        settle(new SocketBusyError(`${lockPath} is held by another starter`));
      else
        settle(
          new Error(
            `${command} exited with ${code ?? "a signal"} before taking the start-up lock${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
    });
  });
}

// Serialises starters across processes: two sessions starting together must not
// both judge the same socket dead, so that one removes the socket the other has
// just bound. The lock is a kernel flock on "<socket>.lock" in the owner-only
// directory, held by a child process (see acquireKernelLock). run is given the lock
// so it can check, before each step, that the lock is still held.
export async function withStartupLock<T>(
  socketPath: string,
  run: (lock: StartupLock) => Promise<T>,
  options: Ownership = {},
): Promise<T> {
  const lockPath = `${socketPath}.lock`;
  // Created here, private (0600). Node's open neither follows a symlink nor blocks
  // on a FIFO, and the open handle must be a regular file. The lock command then
  // opens the path again itself, so what keeps both opens on this file is the
  // directory: listenOnUnixSocket has already checked that only root or this user
  // can write it or any directory above it (checkPrivateDirectory).
  const notRegular = new Error(
    `${lockPath} is not a regular file; refusing to use it`,
  );
  let fd: number;
  try {
    fd = openSync(
      lockPath,
      constants.O_RDONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
  } catch (err) {
    // A symlink (ELOOP), or a directory, which Linux refuses to open with O_CREAT
    // (EISDIR) where macOS opens it and the fstat below refuses it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EISDIR") throw notRegular;
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw notRegular;
  } finally {
    closeSync(fd);
  }
  const lock = await acquireKernelLock(lockPath, options);
  try {
    return await run({ stillHeld: lock.stillHeld });
  } finally {
    await lock.release();
  }
}

export async function listenOnUnixSocket(
  server: Server,
  path: string,
  options: Ownership = {},
): Promise<SocketIdentity> {
  checkNormalised(path, "socket path");
  checkPrivateDirectory(dirname(path), options);
  const identity = await withStartupLock(
    path,
    (lock) => checkAndBind(server, path, lock, options),
    options,
  );
  if (options.signal?.aborted) {
    // Stopped while binding: undo it rather than leave a listener nobody will close.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unlinkOwnSocket(path, identity, options);
    throw new StartAbortedError(`stopped while ${path} was being bound`);
  }
  return identity;
}

// Removes a stale socket and binds a new one, under the start-up lock.
async function checkAndBind(
  server: Server,
  path: string,
  lock: StartupLock,
  options: Ownership = {},
): Promise<SocketIdentity> {
  await removeStaleSocket(path, lock, options);
  // Nothing yields between this check and the bind, because listenNow binds
  // synchronously (see there).
  ensureStillHeld(lock, path, "binding");
  // libuv unlinks its original bind path on native close, without checking
  // identity. Publish a private socket by rename so native close cannot remove
  // a successor at the public path. Explicit cleanup still checks identity.
  const bindPath =
    options.mode === 0o600
      ? resolve(dirname(path), `.${randomBytes(3).toString("hex")}`)
      : path;
  const mode = options.mode ?? SOCKET_MODE;
  await listenNow(
    server,
    bindPath,
    options.umask ?? (options.mode === 0o600 ? 0o177 : SOCKET_UMASK),
  );
  // Group mode is live at its final path. Private mode must still check the
  // startup lock before publishing its bound socket.
  let stats = lstatSync(bindPath, { bigint: true });
  const actualMode = Number(stats.mode) & 0o777;
  if (!stats.isSocket() || actualMode !== mode) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(
      `${path} was created with mode ${actualMode.toString(8)}, not ${mode.toString(8)}`,
    );
  }
  if (bindPath !== path) {
    try {
      ensureStillHeld(lock, path, "publishing the private socket");
      if (lstatSocketOrUndefined(path))
        throw new SocketBusyError(`${path} was replaced before publication`);
      renameSync(bindPath, path);
      stats = lstatSync(path, { bigint: true });
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }
  return identityOf(stats);
}

/**
 * @internal Test-only: checkAndBind, so tests can hand it a lock that is lost at a
 * chosen step. No production module may use it, which a test checks.
 */
export const checkAndBindForTests = checkAndBind;

// Removes the socket on shutdown, but only if the path still holds the very socket
// this process created. Node usually removes it on close already; this covers the
// rest without ever removing a successor's socket after an overlapping restart.
export function unlinkOwnSocket(
  path: string,
  identity: SocketIdentity | undefined,
  options: Ownership = {},
): void {
  if (!identity) return;
  const stats = lstatSocketOrUndefined(path);
  if (!stats?.isSocket() || Number(stats.uid) !== currentUid(options)) return;
  if (!sameFile(identityOf(stats), identity)) return;
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
