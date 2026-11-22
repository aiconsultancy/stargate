// Check: bun tests/fixtures/irc-outbox.ts
// Rebuild after an intentional schema/content change: add --write.
import { Database } from "bun:sqlite";
import { deepStrictEqual, strictEqual } from "node:assert";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IrcSessions } from "../../src/crew/messaging/irc";

// Fixed clock shared by saved rows and retention-test operations, not wall time.
export const outboxNow = 1_700_000_000_000;
export const outboxFixture = new URL("./irc-outbox.sqlite", import.meta.url);

if (import.meta.main) {
  const directory = await mkdtemp(join(tmpdir(), "irc-outbox-build-"));
  const path = join(directory, "expected.sqlite");
  try {
    const db = new Database(path, { create: true, strict: true });
    try {
      new IrcSessions(db);
      const insert = db.query(
        "INSERT INTO irc_dm_outbox (id,fromRole,fromID,toRole,toID,text,created) VALUES (?,?,?,?,?,?,?)",
      );
      db.transaction(() => {
        for (let n = 1; n <= 1000; n++) {
          insert.run(
            n.toString(16).padStart(32, "0"),
            "captain",
            "captain",
            "crew",
            "worker",
            `message ${n}`,
            n === 1 ? outboxNow - 24 * 60 * 60_000 - 1000 : outboxNow,
          );
        }
      }).immediate();
    } finally {
      db.close();
    }
    if (process.argv.includes("--write")) await copyFile(path, outboxFixture);
    const expected = new Database(path, { readonly: true, strict: true });
    const saved = new Database(outboxFixture.pathname, {
      readonly: true,
      strict: true,
    });
    try {
      strictEqual(
        saved
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get()?.integrity_check,
        "ok",
      );
      for (const sql of [
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name",
        "SELECT * FROM irc_dm_outbox ORDER BY sequence",
        "SELECT * FROM irc_sessions",
        "SELECT * FROM sqlite_sequence ORDER BY name",
      ]) {
        deepStrictEqual(saved.query(sql).all(), expected.query(sql).all());
      }
      console.log(
        "Fixture checked: production schema, 1000 synthetic rows, sequence 1000.",
      );
    } finally {
      saved.close();
      expected.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
