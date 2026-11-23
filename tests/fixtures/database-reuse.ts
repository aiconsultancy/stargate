// Check saved synthetic databases: bun tests/fixtures/database-reuse.ts
// Rebuild intentionally: bun tests/fixtures/database-reuse.ts --write
import { createHash } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const crewSchemaFixture = new URL(
  "./crew-schema.sqlite",
  import.meta.url,
);

export const statusHistoryFixture = new URL(
  "./status-history.sqlite",
  import.meta.url,
);

export const nightlyStoreFixture = new URL(
  "./nightly-store.sqlite",
  import.meta.url,
);

export const historySession = "ses_statushistory";
export const historyTaskID = (i: number) => `task_history_${i}`;

export async function copyCrewDatabase(
  directory: string,
  namespace: string,
  source = crewSchemaFixture,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(namespace).digest("hex");
  await copyFile(source, join(directory, `crew-${hash}.sqlite`));
}

if (import.meta.main) {
  const { Database } = await import("bun:sqlite");

  const assert: typeof import("node:assert") = (await import("node:assert"))
    .default;

  const { mkdtemp, rm, access } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  const { CrewState } =
    await import("../../src/coordination/crew/execution/state");

  const { openStore } = await import("../../src/app/open-store");
  const directory = await mkdtemp(join(tmpdir(), "database-reuse-build-"));
  const assets = [crewSchemaFixture, statusHistoryFixture, nightlyStoreFixture];

  const paths = assets.map((asset) =>
    join(directory, asset.pathname.split("/").at(-1) ?? ""),
  );

  try {
    const [emptyPath, historyPath, storePath] = paths;

    if (!emptyPath || !historyPath || !storePath)
      throw new Error("Missing asset path");

    const state = await CrewState.open(
      join(directory, "source"),
      "schema",
      "synthetic-schema-source",
    );

    const sourcePath = state.path;
    state.close();
    const source = new Database(sourcePath, { readonly: true, strict: true });
    const empty = new Database(emptyPath, { create: true, strict: true });

    try {
      // Export current DDL only, never the scratch directory's bound identity.
      const ddl = source
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
        )
        .all();

      empty
        .transaction(() => {
          for (const row of ddl) empty.exec(row.sql);
        })
        .immediate();
    } finally {
      empty.close();
      source.close();
    }

    await copyFile(emptyPath, historyPath);
    const history = new Database(historyPath, { strict: true });

    try {
      history
        .transaction(() => {
          history
            .query("INSERT INTO peers VALUES ('chief',?,'pending')")
            .run(historySession);

          const task = history.query(
            "INSERT INTO tasks (id,crewID,workerSessionID,originCaptainID,inputID,status,result,released) VALUES (?,'chief',?,'captain',?,'completed','RAW PRIVATE FINAL RESULT',1)",
          );

          const notice = history.query(
            "INSERT INTO notices(taskID,text) VALUES (?,'raw tool output and private reasoning')",
          );

          for (let i = 0; i < 24; i++) {
            task.run(historyTaskID(i), historySession, `msg_history_${i}`);
            notice.run(historyTaskID(i));
          }
        })
        .immediate();
    } finally {
      history.close();
    }

    const store = openStore(storePath);

    try {
      store.saveSession('["k","C123","1.0"]', "ses_captain");
    } finally {
      store.close();
    }

    for (const [i, asset] of assets.entries()) {
      const path = paths[i];

      if (!path) throw new Error("Missing asset path");

      // Close every writer first; never copy a main file without its live WAL.
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (
          await access(path + suffix).then(
            () => true,
            () => false,
          )
        )
          throw new Error(`Unsettled database sidecar: ${path}${suffix}`);
      }

      if (process.argv.includes("--write")) await copyFile(path, asset);
      // SQLite can create WAL/SHM even on a read-only open. Inspect a private
      // Copy so checking never opens or changes the canonical saved fixture.
      const checkPath = join(directory, `check-${i}.sqlite`);
      await copyFile(asset, checkPath);
      const expected = new Database(path, { readonly: true, strict: true });

      const saved = new Database(checkPath, {
        readonly: true,
        strict: true,
      });

      try {
        assert.strictEqual(
          saved
            .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
            .get()?.integrity_check,
          "ok",
        );
        assert.deepStrictEqual(
          saved.query("PRAGMA foreign_key_check").all(),
          [],
        );

        const schema =
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name";

        assert.deepStrictEqual(
          saved.query(schema).all(),
          expected.query(schema).all(),
        );
        assert.deepStrictEqual(
          saved.query("PRAGMA journal_mode").get(),
          expected.query("PRAGMA journal_mode").get(),
        );

        for (const { name } of expected
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all()) {
          if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected table name");
          const sql = `SELECT * FROM "${name}" ORDER BY rowid`;
          assert.deepStrictEqual(
            saved.query(sql).all(),
            expected.query(sql).all(),
          );
        }
      } finally {
        saved.close();
        expected.close();
      }

      for (const suffix of ["-wal", "-shm", "-journal"]) {
        if (
          await access(fileURLToPath(asset) + suffix).then(
            () => true,
            () => false,
          )
        )
          throw new Error(
            `Saved fixture has a sidecar: ${fileURLToPath(asset)}${suffix}`,
          );
      }
    }

    console.log(
      "Checked crew empty schema, 24 raw status histories without metadata, and synthetic Store mapping.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
