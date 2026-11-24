import type { Database } from "bun:sqlite";

/** Initialize the shared database in migration order before opening its records. */
export function initializeStoreSchema(db: Database) {
  db.run(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sessions (
      conversation TEXT PRIMARY KEY, session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId TEXT NOT NULL, botKey TEXT NOT NULL,
      conversation TEXT NOT NULL, channel TEXT NOT NULL,
      thread TEXT NOT NULL, user TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', response TEXT,
      sent INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(botKey, eventId), UNIQUE(botKey, channel, eventId)
    );
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(botKey, status, retry_at);
    CREATE INDEX IF NOT EXISTS jobs_conversation ON jobs(conversation, id);
    CREATE TABLE IF NOT EXISTS previews (
      job INTEGER NOT NULL REFERENCES jobs(id), part INTEGER NOT NULL,
      ts TEXT NOT NULL, PRIMARY KEY(job, part)
    );
    CREATE INDEX IF NOT EXISTS previews_ts ON previews(ts);
    CREATE TABLE IF NOT EXISTS ignored_events (
      botKey TEXT NOT NULL, eventId TEXT NOT NULL, PRIMARY KEY(botKey, eventId)
    );
    CREATE TABLE IF NOT EXISTS thread_followups (
      botKey TEXT NOT NULL, eventId TEXT NOT NULL, owner INTEGER NOT NULL,
      sessionID TEXT NOT NULL, inputID TEXT NOT NULL, nativeID TEXT NOT NULL,
      state TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL, transport TEXT NOT NULL,
      reconcileAttempts INTEGER NOT NULL DEFAULT 0,
      retryAt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(botKey,eventId)
    );
    CREATE TABLE IF NOT EXISTS meta_receipts (
      registration TEXT NOT NULL, message TEXT NOT NULL,
      channel TEXT NOT NULL, thread TEXT NOT NULL, user TEXT NOT NULL,
      at INTEGER NOT NULL, command TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', oldDelayMs INTEGER,
      newDelayMs INTEGER, reply TEXT, delivered INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(registration,message)
    );
    CREATE TABLE IF NOT EXISTS slack_questions (
      token TEXT PRIMARY KEY, ts TEXT NOT NULL, question TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS config_panels (
      nonce TEXT PRIMARY KEY, registration TEXT NOT NULL, message TEXT NOT NULL,
      channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT,
      createdAt INTEGER NOT NULL, revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL, user TEXT NOT NULL, at INTEGER NOT NULL,
      UNIQUE(registration,message)
    );
    CREATE TABLE IF NOT EXISTS captain_cursors (
      botKey TEXT NOT NULL, session_id TEXT NOT NULL, cursor TEXT,
      owner INTEGER, PRIMARY KEY(botKey, session_id)
    );
    CREATE TABLE IF NOT EXISTS irc_cursors (
      botKey TEXT NOT NULL, target TEXT NOT NULL, time TEXT NOT NULL,
      PRIMARY KEY(botKey, target)
    );
    CREATE TABLE IF NOT EXISTS irc_bursts (
      job INTEGER PRIMARY KEY REFERENCES jobs(id), policy TEXT NOT NULL,
      deadline INTEGER NOT NULL, maximum INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS irc_burst_messages (
      botKey TEXT NOT NULL, eventId TEXT NOT NULL,
      job INTEGER NOT NULL REFERENCES jobs(id), ordinal INTEGER NOT NULL,
      message TEXT NOT NULL, PRIMARY KEY(botKey,eventId), UNIQUE(job,ordinal)
    );
    CREATE TABLE IF NOT EXISTS irc_thread_messages (
      botKey TEXT NOT NULL, channel TEXT NOT NULL, msgid TEXT NOT NULL,
      root TEXT NOT NULL, PRIMARY KEY(botKey,channel,msgid)
    );
    CREATE TABLE IF NOT EXISTS irc_thread_memberships (
      botKey TEXT NOT NULL, channel TEXT NOT NULL, root TEXT NOT NULL,
      PRIMARY KEY(botKey,channel,root)
    );
    CREATE TABLE IF NOT EXISTS irc_stargate_dm (
      id TEXT PRIMARY KEY, sent INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS irc_stargate_dm_cursor (
      botKey TEXT PRIMARY KEY, sequence INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_units (
      job INTEGER NOT NULL REFERENCES jobs(id), part INTEGER NOT NULL,
      plan TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(job, part)
    );
    CREATE TABLE IF NOT EXISTS native_questions (
      token TEXT PRIMARY KEY, botKey TEXT NOT NULL, formID TEXT NOT NULL,
      sessionID TEXT NOT NULL, inputID TEXT NOT NULL, jobID INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0, recovering INTEGER NOT NULL DEFAULT 0,
      UNIQUE(botKey,sessionID,formID)
    );
    CREATE TABLE IF NOT EXISTS irc_question_sources (
      botKey TEXT NOT NULL,eventId TEXT NOT NULL,user TEXT NOT NULL,
      channel TEXT NOT NULL,thread TEXT NOT NULL,root TEXT NOT NULL,
      PRIMARY KEY(botKey,eventId)
    );
  `);

  const column = (table: string, name: string, type: string) => {
    if (
      !db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === name)
    ) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);

      return true;
    }

    return false;
  };

  column("slack_questions", "progress", "TEXT NOT NULL DEFAULT '{}'");
  column("slack_questions", "revision", "INTEGER NOT NULL DEFAULT 0");
  column("jobs", "progressStage", "TEXT");
  column("jobs", "progressAt", "INTEGER");
  column("jobs", "progressDisconnected", "INTEGER NOT NULL DEFAULT 0");
  column("jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
  column("jobs", "question_stop_attempted", "INTEGER NOT NULL DEFAULT 0");
  column("jobs", "failure", "TEXT");
  column("jobs", "activity", "TEXT");
  column("jobs", "input", "TEXT");
  column("jobs", "input_files", "TEXT");
  column("jobs", "output_files", "TEXT");
  column("jobs", "deferDelivery", "INTEGER NOT NULL DEFAULT 0");
  column("jobs", "sender", "TEXT");
  column("jobs", "gate", "TEXT");
  column("jobs", "textMention", "TEXT");
  column("jobs", "notification_context", "TEXT");
  column("jobs", "slack_reaction", "TEXT");
  column("jobs", "notification_held", "INTEGER NOT NULL DEFAULT 0");
  column("jobs", "received", "INTEGER");
  column("jobs", "replyParent", "TEXT");
  column("jobs", "fleet_context", "TEXT");
  column("jobs", "fleet_exported", "INTEGER NOT NULL DEFAULT 0");
  column("jobs", "makers", "TEXT");
  column("native_questions", "outcome", "TEXT");
  column("native_questions", "outcomeNotified", "INTEGER NOT NULL DEFAULT 0");

  if (
    column(
      "native_questions",
      "publicationStarted",
      "INTEGER NOT NULL DEFAULT 0",
    )
  )
  // Existing offers may have been seen despite a lost ACK. Preserve their
  // Original expiry rather than restarting their window on this migration.
  {
    db.run("UPDATE native_questions SET publicationStarted=1");
  }

  column("irc_thread_messages", "request", "TEXT");

  for (const table of [
    "native_questions",
    "irc_question_sources",
    "irc_thread_messages",
    "irc_thread_memberships",
  ]) {
    if (column(table, "recorded", "INTEGER NOT NULL DEFAULT 0")) {
      db.query(`UPDATE ${table} SET recorded=?`).run(Date.now());
    }

    db.run(
      `CREATE INDEX IF NOT EXISTS ${table}_retention ON ${table}(botKey,recorded)`,
    );
  }

  db.run(
    "CREATE INDEX IF NOT EXISTS jobs_irc_root ON jobs(botKey,channel,CAST(COALESCE(replyParent,thread) AS TEXT),status)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS native_questions_job ON native_questions(botKey,jobID)",
  );
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_fleet_assignment
    ON jobs(botKey,json_extract(fleet_context,'$.dispatchID'))
    WHERE json_extract(fleet_context,'$.kind')='assignment'`);
  db.run(
    "CREATE INDEX IF NOT EXISTS jobs_received ON jobs(sender,received) WHERE received IS NOT NULL",
  );
  db.run(`CREATE INDEX IF NOT EXISTS jobs_activity_ts
    ON jobs(botKey,channel,json_extract(activity,'$.ts')) WHERE activity IS NOT NULL`);

  // Preserve source-first context and legacy ownership; keep statuses intact.
  if (column("jobs", "started", "INTEGER NOT NULL DEFAULT 0")) {
    db.run(`UPDATE jobs SET started=1 WHERE started=0
    AND status!='queued' AND failure IS NOT 'context'
    AND failure IS NOT 'cancelled' AND text!='';`);
  }

  db.run("CREATE INDEX IF NOT EXISTS jobs_input ON jobs(botKey,input)");
  // Newest native message accounted for in Slack; NULL needs a baseline.
  column("sessions", "cursor", "TEXT");
  // Server-wide settle events look up mappings by native session ID.
  db.run("CREATE INDEX IF NOT EXISTS sessions_session ON sessions(session_id)");
}
