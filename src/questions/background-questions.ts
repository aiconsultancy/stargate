import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export type BackgroundCase = {
  reference: string;
  token: string | null;
  owner: string;
  input: string;
  fingerprint: string;
  session: string;
  form: string;
  state: "new" | "alerted" | "attempted" | "answered" | "cancelled";
  expires: number;
};

export interface OperatorRoute {
  account: string;
  ready(): boolean;
  send(text: string, allowed: () => boolean): Promise<void>;
}

export function operatorControl(text: string) {
  return /^(show|answer)\s+(Q[0-9a-f]{10})(?:\s+([^\r\n]+))?$/i.exec(
    text.trim(),
  );
}

export class BackgroundCases {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS background_questions (
      ship TEXT NOT NULL, session TEXT NOT NULL, form TEXT NOT NULL, input TEXT NOT NULL,
      fingerprint TEXT NOT NULL, owner TEXT NOT NULL, reference TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'new', expires INTEGER NOT NULL DEFAULT 0,
      token TEXT UNIQUE, checked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(ship,session,form))`);
  }

  remember<
    Question extends {
      sessionID: string;
      id: string;
      inputID: string;
      fingerprint: string;
    },
  >(ship: string, owner: string, q: Question) {
    this.db
      .query(
        "INSERT INTO background_questions(ship,session,form,input,fingerprint,owner,reference) VALUES(?,?,?,?,?,?,?) ON CONFLICT(ship,session,form) DO UPDATE SET owner=excluded.owner, reference=excluded.reference, token=NULL, expires=0, state='new' WHERE owner!=excluded.owner AND state IN ('new','alerted') AND input=excluded.input AND fingerprint=excluded.fingerprint",
      )
      .run(
        ship,
        q.sessionID,
        q.id,
        q.inputID,
        q.fingerprint,
        owner,
        "Q" + randomBytes(5).toString("hex"),
      );
    return this.db
      .query<BackgroundCase, [string, string, string]>(
        "SELECT * FROM background_questions WHERE ship=? AND session=? AND form=?",
      )
      .get(ship, q.sessionID, q.id);
  }
  find(ship: string, value: string, answering: boolean) {
    const column = answering ? "token" : "reference";
    return this.db
      .query<BackgroundCase, [string, string]>(
        `SELECT * FROM background_questions WHERE ship=? AND ${column}=? COLLATE NOCASE`,
      )
      .get(ship, value);
  }
  alerted(ref: string) {
    this.db
      .query(
        "UPDATE background_questions SET state='alerted' WHERE reference=? AND state='new'",
      )
      .run(ref);
  }
  show(ref: string) {
    const now = Date.now();
    return this.db
      .query<{ token: string }, [number, string, number, number, string]>(
        `UPDATE background_questions SET
        token=CASE WHEN expires>? THEN token ELSE ? END,
        expires=CASE WHEN expires>? THEN expires ELSE ? END
        WHERE reference=? AND state IN ('new','alerted') RETURNING token`,
      )
      .get(
        now,
        "Q" + randomBytes(5).toString("hex"),
        now,
        now + 30 * 60_000,
        ref,
      )?.token;
  }
  attempt(token: string) {
    return (
      this.db
        .query(
          "UPDATE background_questions SET state='attempted' WHERE token=? COLLATE NOCASE AND state IN ('new','alerted') AND expires>?",
        )
        .run(token, Date.now()).changes === 1
    );
  }
  unsettled(ship: string) {
    return this.db
      .query<BackgroundCase, [string]>(
        "SELECT * FROM background_questions WHERE ship=? AND state IN ('new','alerted','attempted') ORDER BY checked,rowid LIMIT 16",
      )
      .all(ship);
  }
  checked(ref: string) {
    this.db
      .query("UPDATE background_questions SET checked=? WHERE reference=?")
      .run(Date.now(), ref);
  }
  close(ref: string, outcome: "answered" | "cancelled") {
    this.db
      .query("UPDATE background_questions SET state=? WHERE reference=?")
      .run(outcome, ref);
  }
}
