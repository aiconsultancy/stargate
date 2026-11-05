import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { type CrewName, crewNames } from "./policy";

export const crewIDs = crewNames;
export type CrewID = CrewName;
export type Peer = {
  crewID: CrewID;
  sessionID: string;
  status: "pending" | "ready";
};
export type CrewTask = {
  id: string;
  crewID: CrewID;
  workerSessionID: string;
  originCaptainID: string;
  inputID: string;
  status: "dispatching" | "running" | "completed" | "cancelling" | "uncertain";
  result: string | null;
  released: number;
  notifying: number;
};
export type CrewNotice = { id: number; taskID: string; text: string };

export class CrewError extends Error {}

export class CrewState {
  private constructor(
    readonly path: string,
    private readonly db: Database,
  ) {}

  static async open(directory: string, namespace: string, fingerprint: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const hash = createHash("sha256").update(namespace).digest("hex");
    const path = join(directory, `crew-${hash}.sqlite`);
    const file = await open(path, "a", 0o600);
    await file.close();
    await chmod(path, 0o600);
    const db = new Database(path, { create: true, strict: true });
    try {
      db.exec(`
        PRAGMA busy_timeout=5000;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS identity (value TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS peers (
          crewID TEXT PRIMARY KEY CHECK(crewID IN ('mario','luigi','daisy','toad')),
          sessionID TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('pending','ready'))
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          crewID TEXT NOT NULL REFERENCES peers(crewID),
          workerSessionID TEXT NOT NULL,
          originCaptainID TEXT NOT NULL,
          inputID TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN
            ('dispatching','running','completed','cancelling','uncertain')),
          result TEXT,
          released INTEGER NOT NULL DEFAULT 0,
          notifying INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS active_worker
          ON tasks(crewID) WHERE released=0;
        CREATE TABLE IF NOT EXISTS notices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          taskID TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mail_cursors (
          sessionID TEXT NOT NULL, taskID TEXT NOT NULL REFERENCES tasks(id),
          sequence INTEGER NOT NULL, PRIMARY KEY(sessionID,taskID)
        );
      `);
      db.transaction(() => {
        const identity = db
          .query<{ value: string }, []>("SELECT value FROM identity")
          .get();
        if (identity && identity.value !== fingerprint)
          throw new CrewError(
            "Crew configuration changed. Restore its original namespace and directories; do not delete state.",
          );
        if (!identity)
          db.query("INSERT INTO identity VALUES (?)").run(fingerprint);
      }).immediate();
      return new CrewState(path, db);
    } catch (error) {
      db.close();
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Crew state unavailable. Check private state directory access; do not delete state.",
      );
    }
  }

  peer(crewID: CrewID): Peer | null {
    return this.db
      .query<Peer, [string]>("SELECT * FROM peers WHERE crewID=?")
      .get(crewID);
  }

  peerBySession(sessionID: string): Peer | null {
    return this.db
      .query<Peer, [string]>("SELECT * FROM peers WHERE sessionID=?")
      .get(sessionID);
  }

  reservePeer(crewID: CrewID): Peer {
    return this.db
      .transaction(() => {
        this.db
          .query("INSERT OR IGNORE INTO peers VALUES (?,?,'pending')")
          .run(crewID, `ses_${randomUUID().replaceAll("-", "")}`);
        const peer = this.peer(crewID);
        if (!peer)
          throw new CrewError("Crew reservation failed. Inspect crew state.");
        return peer;
      })
      .immediate();
  }

  readyPeer(crewID: CrewID) {
    this.db.query("UPDATE peers SET status='ready' WHERE crewID=?").run(crewID);
  }

  task(id: string): CrewTask | null {
    return this.db
      .query<CrewTask, [string]>("SELECT * FROM tasks WHERE id=?")
      .get(id);
  }

  activeTask(crewID: CrewID): CrewTask | null {
    return this.db
      .query<CrewTask, [string]>(
        "SELECT * FROM tasks WHERE crewID=? AND released=0",
      )
      .get(crewID);
  }

  reserveTask(peer: Peer, captainID: string): CrewTask | null {
    return this.db
      .transaction(() => {
        if (this.activeTask(peer.crewID)) return null;
        const id = `task_${randomUUID()}`;
        this.db
          .query(`INSERT INTO tasks
        (id,crewID,workerSessionID,originCaptainID,inputID,status)
        VALUES (?,?,?,?,?,'dispatching')`)
          .run(
            id,
            peer.crewID,
            peer.sessionID,
            captainID,
            `msg_${randomUUID()}`,
          );
        return this.task(id);
      })
      .immediate();
  }

  running(id: string) {
    this.db
      .query(
        "UPDATE tasks SET status='running' WHERE id=? AND status='dispatching'",
      )
      .run(id);
  }

  uncertain(id: string) {
    this.db
      .query(
        "UPDATE tasks SET status='uncertain' WHERE id=? AND status!='completed'",
      )
      .run(id);
  }

  complete(id: string, workerSessionID: string, result: string) {
    return this.db
      .transaction(() => {
        const task = this.task(id);
        if (!task || task.workerSessionID !== workerSessionID)
          throw new CrewError(
            "Only the assigned worker can complete this task.",
          );
        if (task.status === "completed" && task.result === result) return;
        if (task.status !== "dispatching" && task.status !== "running")
          throw new CrewError(
            "Task is not running. Inspect uncertain state; do not replay work.",
          );
        this.db
          .query("UPDATE tasks SET status='completed',result=? WHERE id=?")
          .run(result, id);
      })
      .immediate();
  }

  release(id: string): boolean {
    return (
      this.db
        .query(`UPDATE tasks SET released=1
      WHERE id=? AND status='completed' AND notifying=0`)
        .run(id).changes === 1
    );
  }

  beginCancel(id: string, captainID: string): boolean {
    return (
      this.db
        .query(`UPDATE tasks SET status='cancelling'
      WHERE id=? AND originCaptainID=? AND released=0
      AND status IN ('dispatching','running')`)
        .run(id, captainID).changes === 1
    );
  }

  notice(taskID: string, text: string) {
    this.db
      .query("INSERT INTO notices(taskID,text) VALUES (?,?)")
      .run(taskID, text);
  }

  notices(taskID: string, after: number): CrewNotice[] {
    return this.db
      .query<CrewNotice, [string, number]>(
        "SELECT * FROM notices WHERE taskID=? AND id>? ORDER BY id",
      )
      .all(taskID, after);
  }

  beginNotify(taskID: string): boolean {
    return (
      this.db
        .query(`UPDATE tasks SET notifying=notifying+1 WHERE id=?
      AND released=0 AND status IN ('dispatching','running')`)
        .run(taskID).changes === 1
    );
  }

  endNotify(taskID: string) {
    this.db
      .query(
        "UPDATE tasks SET notifying=notifying-1 WHERE id=? AND notifying>0",
      )
      .run(taskID);
  }

  mailCursor(sessionID: string, taskID: string, acknowledged?: number): number {
    return this.db
      .transaction(() => {
        if (acknowledged !== undefined)
          this.db
            .query(`INSERT INTO mail_cursors VALUES (?,?,?)
          ON CONFLICT(sessionID,taskID) DO UPDATE
          SET sequence=MAX(sequence,excluded.sequence)`)
            .run(sessionID, taskID, acknowledged);
        return (
          this.db
            .query<{ sequence: number }, [string, string]>(
              "SELECT sequence FROM mail_cursors WHERE sessionID=? AND taskID=?",
            )
            .get(sessionID, taskID)?.sequence ?? 0
        );
      })
      .immediate();
  }

  close() {
    this.db.close();
  }
}
