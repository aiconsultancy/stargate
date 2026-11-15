import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cutoverBotKey,
  cutoverSessionFields,
  type MigrationPlan,
  migratedPath,
  migrateSnapshot,
  sha256,
} from "../scripts/migrate-stargate-state";
import { configSchema, loadConfig } from "../src/config";
import { crewFingerprint } from "../src/crew/identity";
import { defaultTeam } from "../src/crew/team";
import { ircKey } from "../src/irc/ship";
import { botKey, conversationKey } from "../src/routing";
import { bot, identity } from "./fixtures";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "stargate-cutover-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
const prompt =
  "Keep /pogo and pogo_crew in this historical prompt. Do not replay.";
async function fixture(version: "0.14" | "0.20") {
  const root = await directory();
  const source = join(root, "snapshot"),
    destination = join(root, "converted");
  await mkdir(source, { mode: 0o700 });
  await writeFile(
    join(source, ".stargate-offline-snapshot"),
    "pogo-to-stargate-v1\n",
  );
  const before = bot("pogo"); // A registration ID is not the product name.
  if (before.backend.type !== "opencode") throw new Error("Fixture backend");
  before.backend.directory = "/srv/pogo/captain";
  const after = structuredClone(before);
  if (after.backend.type !== "opencode") throw new Error("Fixture backend");
  after.backend.directory = "/srv/stargate/captain";
  const oldKey = botKey(before, identity),
    newKey = botKey(after, identity);
  const conversation = conversationKey(oldKey, "C123", "1.000");
  const db = new Database(join(source, "pogo.sqlite"));
  db.exec(`CREATE TABLE sessions(conversation TEXT PRIMARY KEY,session_id TEXT,cursor TEXT);
    CREATE TABLE jobs(id INTEGER PRIMARY KEY,botKey TEXT,conversation TEXT,text TEXT,status TEXT,response TEXT,sent INTEGER,attempts INTEGER,retry_at INTEGER,output_files TEXT);
    CREATE TABLE ignored_events(botKey TEXT,eventId TEXT,PRIMARY KEY(botKey,eventId));
    CREATE TABLE captain_cursors(botKey TEXT,session_id TEXT,cursor TEXT,owner INTEGER,PRIMARY KEY(botKey,session_id));
    CREATE TABLE previews(job INTEGER,part INTEGER,ts TEXT);
    CREATE TABLE delivery_units(job INTEGER,part INTEGER,plan TEXT,done INTEGER);`);
  db.query("INSERT INTO sessions VALUES (?,?,?)").run(
    conversation,
    "ses_NATIVE",
    "msg_CURSOR",
  );
  const attachments = JSON.stringify([
    {
      path: "/srv/pogo/files/a.txt",
      caption: "pogo",
      prepared: { path: "/srv/pogo/files/a.txt", sha256: "abc" },
      phase: "completing",
      fileID: "FNATIVE",
    },
  ]);
  db.query("INSERT INTO jobs VALUES (1,?,?,?,?,?,2,3,12345,?)").run(
    oldKey,
    conversation,
    prompt,
    "responding",
    '["reply mentioning pogo"]',
    attachments,
  );
  db.query(
    "INSERT INTO jobs VALUES (2,?,?,?,'queued',NULL,0,0,45678,NULL)",
  ).run(oldKey, conversation, prompt);
  db.query("INSERT INTO ignored_events VALUES (?,?)").run(oldKey, "EvIgnored");
  db.query("INSERT INTO captain_cursors VALUES (?,?,?,1)").run(
    oldKey,
    "ses_NATIVE",
    "msg_CURSOR",
  );
  db.exec(
    "INSERT INTO previews VALUES (1,0,'1.001'); INSERT INTO delivery_units VALUES (1,0,'{\"text\":\"pogo\"}',1)",
  );
  if (version === "0.20") {
    db.exec(
      "CREATE TABLE irc_pogo_dm(id TEXT PRIMARY KEY,sent INTEGER); CREATE TABLE irc_pogo_dm_cursor(botKey TEXT PRIMARY KEY,sequence INTEGER); INSERT INTO irc_pogo_dm VALUES ('RECEIPT',123)",
    );
    db.query("INSERT INTO irc_pogo_dm_cursor VALUES (?,41)").run(oldKey);
  }
  db.close();
  const cron = new Database(join(source, "cron.sqlite"));
  cron.exec(
    "CREATE TABLE cron_schedules(id TEXT PRIMARY KEY,botKey TEXT,source TEXT,prompt TEXT,nextAt INTEGER); CREATE TABLE cron_runs(id TEXT PRIMARY KEY,status TEXT,snapshot TEXT,jobId INTEGER)",
  );
  cron
    .query("INSERT INTO cron_schedules VALUES ('schedule',?,?,?,300)")
    .run(oldKey, "/srv/pogo/cronjobs/job/CRONJOB.md", prompt);
  cron.query("INSERT INTO cron_runs VALUES ('run','queued',?,1)").run(
    JSON.stringify({
      botKey: oldKey,
      source: "/srv/pogo/cronjobs/job/CRONJOB.md",
      prompt,
    }),
  );
  cron.close();
  const crew = new Database(join(source, "crew.sqlite"));
  crew.exec(
    "CREATE TABLE identity(value TEXT PRIMARY KEY); CREATE TABLE peers(crewID TEXT,sessionID TEXT); CREATE TABLE tasks(id TEXT,status TEXT,workerSessionID TEXT); CREATE TABLE journal(text TEXT); CREATE TABLE irc_dm_outbox(id TEXT,text TEXT,sequence INTEGER)",
  );
  const crewIdentity =
    version === "0.14"
      ? ["ship", "/srv/pogo/project", "/srv/pogo/captain", "/srv/pogo/crew"]
      : {
          version: 2,
          namespace: "ship",
          projectDirectory: "/srv/pogo/project",
          captain: { id: "adama", directory: "/srv/pogo/captain" },
          crew: [
            {
              id: "chief",
              permissionProfile: "coding",
              directory: "/srv/pogo/crew",
            },
          ],
        };
  crew
    .query("INSERT INTO identity VALUES (?)")
    .run(JSON.stringify(crewIdentity));
  crew.exec(
    "INSERT INTO peers VALUES ('chief','ses_WORKER'); INSERT INTO tasks VALUES ('task_NATIVE','uncertain','ses_WORKER')",
  );
  crew.query("INSERT INTO journal VALUES (?)").run(prompt);
  crew.query("INSERT INTO irc_dm_outbox VALUES ('RECEIPT',?,41)").run(prompt);
  crew.close();
  const native = new Database(join(source, "native.sqlite"));
  native.exec("CREATE TABLE session(id TEXT PRIMARY KEY,data TEXT)");
  const oldNative = JSON.stringify({
    id: "ses_WORKER",
    metadata: { pogoCrew: { namespace: "ship", crewID: "chief" } },
    text: prompt,
  });
  const newNative = JSON.stringify({
    id: "ses_WORKER",
    metadata: { stargateCrew: { namespace: "ship", crewID: "chief" } },
    text: prompt,
  });
  native.query("INSERT INTO session VALUES ('ses_WORKER',?)").run(oldNative);
  native.close();
  await writeFile(
    join(source, "config.json"),
    JSON.stringify({
      maintenance: { pogo: { root: "/srv/pogo" } },
      bots: [{ id: "pogo" }],
    }),
  );
  await mkdir(join(source, sha256(oldKey)));
  await writeFile(
    join(source, sha256(oldKey), "pi.sqlite"),
    "native bytes untouched",
  );
  const plan: MigrationPlan = {
    schema: "stargate.cutover.v1",
    source,
    destination,
    gateway: "pogo.sqlite",
    cron: "cron.sqlite",
    crew: [
      {
        database: "crew.sqlite",
        before: JSON.stringify(crewIdentity),
        after: JSON.stringify(crewIdentity).replaceAll(
          "/srv/pogo",
          "/srv/stargate",
        ),
      },
    ],
    paths: [{ from: "/srv/pogo", to: "/srv/stargate" }],
    botKeys: [{ from: oldKey, to: newKey }],
    moves: [
      { from: "pogo.sqlite", to: "stargate.sqlite" },
      { from: sha256(oldKey), to: sha256(newKey) },
    ],
    jsonFiles: [
      {
        file: "config.json",
        edits: [
          {
            path: ["maintenance"],
            before: { pogo: { root: "/srv/pogo" } },
            after: { stargate: { root: "/srv/stargate" } },
          },
        ],
      },
    ],
    cells: [
      {
        database: "native.sqlite",
        table: "session",
        column: "data",
        keyColumn: "id",
        key: "ses_WORKER",
        before: oldNative,
        after: newNative,
      },
    ],
  };
  return { plan, source, destination, oldKey, newKey, conversation, version };
}

describe("one-time Stargate cutover", () => {
  test("permits a physically disjoint destination ancestor alias, but not a linked source root", async () => {
    const f = await fixture("0.20");
    const outside = await directory();
    const alias = join(f.source, "..", "outside-alias");
    await symlink(outside, alias);
    const sourceAlias = join(f.source, "..", "source-alias");
    await symlink(f.source, sourceAlias);
    await expect(
      migrateSnapshot({
        ...f.plan,
        source: sourceAlias,
        destination: join(alias, "converted"),
      }),
    ).rejects.toThrow("private, owned");
    const entries = await readdir(f.source, { recursive: true });
    expect(
      await migrateSnapshot({
        ...f.plan,
        destination: join(alias, "converted"),
      }),
    ).toBe(join(outside, "converted"));
    expect(await readdir(f.source, { recursive: true })).toEqual(entries);
  });

  test.each([
    "destination ancestor",
    "missing destination ancestors",
    "source ancestor",
  ])(
    "refuses physical overlap through %s without changing source",
    async (mode) => {
      const f = await fixture("0.20");
      const alias = join(f.source, "..", "alias");
      await symlink(
        mode === "source ancestor" ? join(f.source, "..") : f.source,
        alias,
      );
      const entries = await readdir(f.source, { recursive: true });
      const original = await readFile(join(f.source, "pogo.sqlite"));
      const source =
        mode === "source ancestor" ? join(alias, "snapshot") : f.source;
      const destination =
        mode === "source ancestor"
          ? join(f.source, "converted")
          : mode === "missing destination ancestors"
            ? join(alias, "missing", "deeper", "converted")
            : join(alias, "converted");
      const error: unknown = await migrateSnapshot({
        ...f.plan,
        source,
        destination,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(await readdir(f.source, { recursive: true })).toEqual(entries);
      expect(await readFile(join(f.source, "pogo.sqlite"))).toEqual(original);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("disjoint");
    },
  );

  test("native V2 field plan preserves ID, unrelated metadata, rule order and effects", () => {
    const metadata = {
      pogoCrew: { namespace: "ship", crewID: "chief" },
      other: { model: "leave this alone" },
    };
    const permissions = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "pogo_crew", resource: "*", effect: "allow" as const },
      { action: "rpc", resource: "pogo.crew.irc", effect: "ask" as const },
      { action: "read", resource: "/srv/pogo/secret", effect: "deny" as const },
    ];
    expect(
      cutoverSessionFields(
        {
          id: "ses_NATIVE",
          directory: "/srv/pogo/captain",
          metadata,
          permissions,
        },
        [{ from: "/srv/pogo", to: "/srv/stargate" }],
      ),
    ).toEqual({
      update: {
        sessionID: "ses_NATIVE",
        metadata: { stargateCrew: metadata.pogoCrew, other: metadata.other },
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "stargate_crew", resource: "*", effect: "allow" },
          { action: "rpc", resource: "stargate.crew.irc", effect: "ask" },
          { action: "read", resource: "/srv/stargate/secret", effect: "deny" },
        ],
      },
      move: { sessionID: "ses_NATIVE", directory: "/srv/stargate/captain" },
    });
    expect(metadata).toHaveProperty("pogoCrew");
    expect(permissions[1]?.action).toBe("pogo_crew");
  });

  test("key planner requires old normalization and preserves Slack/IRC identities", () => {
    const before = bot();
    if (before.backend.type !== "opencode") throw new Error("Fixture backend");
    before.backend.directory = "/srv/pogo/captain";
    before.backend.headersEnv = { authorization: "POGO_RPC" };
    const after = structuredClone(before);
    if (after.backend.type !== "opencode") throw new Error("Fixture backend");
    after.backend.directory = "/srv/stargate/captain";
    after.backend.headersEnv = { authorization: "STARGATE_RPC" };
    const oldKey = botKey(before, identity),
      newKey = botKey(after, identity);
    expect(cutoverBotKey(oldKey, before.backend, after.backend)).toEqual({
      from: oldKey,
      to: newKey,
      fromHash: sha256(oldKey),
      toHash: sha256(newKey),
    });
    expect(() =>
      cutoverBotKey(
        oldKey,
        { type: "opencode", directory: "/srv/pogo/captain" },
        after.backend,
      ),
    ).toThrow("does not match");
    const server = { host: "IRC.EXAMPLE", port: 6697 };
    const oldIrc = ircKey("ship-chief", server, "Chief", before.backend);
    const newIrc = ircKey("ship-chief", server, "Chief", after.backend);
    expect(cutoverBotKey(oldIrc, before.backend, after.backend).to).toBe(
      newIrc,
    );
    const options = {
      namespace: "ship",
      projectDirectory: "/project",
      captainDirectory: "/captain",
      worktrees: Object.fromEntries(
        defaultTeam.crew.map(({ id }) => [id, `/crew/${id}`]),
      ),
      team: defaultTeam,
    };
    const fingerprint: unknown = JSON.parse(crewFingerprint(options));
    expect(fingerprint).toMatchObject({
      namespace: "ship",
      captain: { id: defaultTeam.captain.id },
    });
  });

  test("Mesij identity surgery preserves inbox/receipt/idempotency and repairs mail digests", async () => {
    const f = await fixture("0.20");
    const oldActor = `pogo:${"a".repeat(64)}:chief`,
      newActor = `stargate:${"a".repeat(64)}:chief`;
    const text = JSON.stringify({ namespace: "ship", text: prompt });
    const fingerprint = (actor: string) =>
      sha256(
        JSON.stringify([
          actor,
          "ses_WORKER",
          "ses_NATIVE",
          "message.posted",
          text,
          null,
        ]),
      );
    const crew = new Database(join(f.source, "crew.sqlite"));
    crew.exec(
      "CREATE TABLE mail_intents(key TEXT PRIMARY KEY,fingerprint TEXT,receiptID TEXT,sender TEXT,recipient TEXT)",
    );
    crew
      .query(
        "INSERT INTO mail_intents VALUES ('intent',?,'receipt','ses_WORKER','ses_NATIVE')",
      )
      .run(fingerprint(oldActor));
    crew.close();
    const db = new Database(join(f.source, "mesij.sqlite"));
    db.exec(`PRAGMA user_version=4;
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,project_id TEXT,actor TEXT,session_id TEXT,recipient_session TEXT,reply_to TEXT,event_type TEXT,payload TEXT,worktree TEXT,branch TEXT,commit_sha TEXT,host TEXT,user_name TEXT,ip TEXT,idempotency_key TEXT,created_at TEXT);
      CREATE TABLE agents(project_id TEXT,session_id TEXT,actor TEXT,started_at TEXT,last_seen_at TEXT,PRIMARY KEY(project_id,session_id));
      CREATE TABLE mentions(event_id TEXT,actor TEXT,PRIMARY KEY(event_id,actor));
      CREATE TABLE idempotency_keys(project_id TEXT,session_id TEXT,key TEXT,event_id TEXT,PRIMARY KEY(project_id,session_id,key));
      CREATE TABLE active_work(project_id TEXT,session_id TEXT,work_id TEXT,event_id TEXT,projection TEXT,PRIMARY KEY(project_id,session_id,work_id));
      CREATE TABLE projection_errors(event_id TEXT,project_id TEXT,reason TEXT);
      CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
      CREATE TRIGGER idempotency_keys_immutable_update BEFORE UPDATE ON idempotency_keys BEGIN SELECT RAISE(ABORT,'idempotency keys are immutable'); END;`);
    const payload = JSON.stringify({
      message: text,
      mentions: [oldActor, `@${oldActor}`],
      arbitrary: prompt,
    });
    db.query(
      "INSERT INTO events VALUES (41,'receipt','project',?,'ses_WORKER','ses_NATIVE','','message.posted',?,'/srv/pogo/crew','branch','sha','host','user','ip','intent','2026-01-01')",
    ).run(oldActor, payload);
    db.query(
      "INSERT INTO agents VALUES ('project','ses_WORKER',?,'start','seen')",
    ).run(oldActor);
    db.query("INSERT INTO mentions VALUES ('receipt',?)").run(oldActor);
    db.exec(
      "INSERT INTO idempotency_keys VALUES ('project','ses_WORKER','intent','receipt')",
    );
    db.query(
      "INSERT INTO active_work VALUES ('project','ses_WORKER','task_NATIVE','receipt',?)",
    ).run(JSON.stringify({ message: prompt, data: { note: oldActor } }));
    db.close();
    await migrateSnapshot({
      ...f.plan,
      mesij: [
        {
          database: "mesij.sqlite",
          crewDatabase: "crew.sqlite",
          actors: [{ from: oldActor, to: newActor }],
        },
      ],
    });
    const result = new Database(join(f.destination, "mesij.sqlite"));
    const event = result
      .query<{ actor: string; payload: string }, []>("SELECT * FROM events")
      .get();
    expect(event).toMatchObject({
      sequence: 41,
      id: "receipt",
      actor: newActor,
      session_id: "ses_WORKER",
      recipient_session: "ses_NATIVE",
      idempotency_key: "intent",
      worktree: "/srv/stargate/crew",
    });
    expect(JSON.parse(event?.payload ?? "null")).toEqual({
      message: text,
      mentions: [newActor, `@${newActor}`],
      arbitrary: prompt,
    });
    expect(result.query("SELECT * FROM idempotency_keys").get()).toEqual({
      project_id: "project",
      session_id: "ses_WORKER",
      key: "intent",
      event_id: "receipt",
    });
    expect(result.query("SELECT actor FROM agents").get()).toEqual({
      actor: newActor,
    });
    expect(result.query("SELECT actor FROM mentions").get()).toEqual({
      actor: newActor,
    });
    expect(result.query("SELECT projection FROM active_work").get()).toEqual({
      projection: JSON.stringify({ message: prompt, data: { note: oldActor } }),
    });
    expect(() => result.exec("UPDATE events SET actor='bad'")).toThrow(
      "immutable",
    );
    expect(() => result.exec("UPDATE idempotency_keys SET key='bad'")).toThrow(
      "immutable",
    );
    result.close();
    const repaired = new Database(join(f.destination, "crew.sqlite"), {
      readonly: true,
    });
    expect(
      repaired.query("SELECT fingerprint,receiptID FROM mail_intents").get(),
    ).toEqual({ fingerprint: fingerprint(newActor), receiptID: "receipt" });
    repaired.close();
  });

  test.each(["0.14", "0.20"] as const)(
    "preserves %s-style IDs, uncertain tasks, journal, queue and delivery progress",
    async (version) => {
      const f = await fixture(version);
      await migrateSnapshot(f.plan);
      const db = new Database(join(f.destination, "stargate.sqlite"), {
        readonly: true,
      });
      expect(db.query("SELECT * FROM jobs").get()).toMatchObject({
        id: 1,
        botKey: f.newKey,
        conversation: conversationKey(f.newKey, "C123", "1.000"),
        text: prompt,
        status: "responding",
        response: '["reply mentioning pogo"]',
        sent: 2,
        attempts: 3,
        retry_at: 12345,
      });
      expect(db.query("SELECT * FROM sessions").get()).toMatchObject({
        session_id: "ses_NATIVE",
        cursor: "msg_CURSOR",
      });
      expect(db.query("SELECT * FROM jobs WHERE id=2").get()).toMatchObject({
        botKey: f.newKey,
        text: prompt,
        status: "queued",
        response: null,
        sent: 0,
        attempts: 0,
        retry_at: 45678,
      });
      const files: unknown = JSON.parse(
        String(
          db
            .query<{ output_files: string }, []>(
              "SELECT output_files FROM jobs",
            )
            .get()?.output_files,
        ),
      );
      expect(files).toEqual([
        {
          path: "/srv/stargate/files/a.txt",
          caption: "pogo",
          prepared: { path: "/srv/stargate/files/a.txt", sha256: "abc" },
          phase: "completing",
          fileID: "FNATIVE",
        },
      ]);
      expect(db.query("SELECT * FROM delivery_units").get()).toEqual({
        job: 1,
        part: 0,
        plan: '{"text":"pogo"}',
        done: 1,
      });
      if (version === "0.20") {
        expect(db.query("SELECT * FROM irc_stargate_dm").get()).toEqual({
          id: "RECEIPT",
          sent: 123,
        });
        expect(db.query("SELECT * FROM irc_stargate_dm_cursor").get()).toEqual({
          botKey: f.newKey,
          sequence: 41,
        });
      }
      db.close();
      const crew = new Database(join(f.destination, "crew.sqlite"), {
        readonly: true,
      });
      expect(
        String(
          crew.query<{ value: string }, []>("SELECT value FROM identity").get()
            ?.value,
        ),
      ).toContain("/srv/stargate");
      expect(
        String(
          crew.query<{ value: string }, []>("SELECT value FROM identity").get()
            ?.value,
        ),
      ).not.toContain("/srv/pogo");
      expect(crew.query("SELECT * FROM tasks").get()).toEqual({
        id: "task_NATIVE",
        status: "uncertain",
        workerSessionID: "ses_WORKER",
      });
      expect(crew.query("SELECT text FROM journal").get()).toEqual({
        text: prompt,
      });
      expect(crew.query("SELECT * FROM irc_dm_outbox").get()).toEqual({
        id: "RECEIPT",
        text: prompt,
        sequence: 41,
      });
      crew.close();
      const cron = new Database(join(f.destination, "cron.sqlite"), {
        readonly: true,
      });
      expect(cron.query("SELECT * FROM cron_schedules").get()).toMatchObject({
        botKey: f.newKey,
        source: "/srv/stargate/cronjobs/job/CRONJOB.md",
        prompt,
        nextAt: 300,
      });
      const run = cron
        .query<{ snapshot: string }, []>("SELECT * FROM cron_runs")
        .get();
      expect(run).toMatchObject({ status: "queued", jobId: 1 });
      expect(JSON.parse(String(run?.snapshot))).toEqual({
        botKey: f.newKey,
        source: "/srv/stargate/cronjobs/job/CRONJOB.md",
        prompt,
      });
      cron.close();
      const native = new Database(join(f.destination, "native.sqlite"), {
        readonly: true,
      });
      expect(
        JSON.parse(
          String(
            native.query<{ data: string }, []>("SELECT data FROM session").get()
              ?.data,
          ),
        ),
      ).toEqual({
        id: "ses_WORKER",
        metadata: { stargateCrew: { namespace: "ship", crewID: "chief" } },
        text: prompt,
      });
      native.close();
      expect(
        await readFile(
          join(f.destination, sha256(f.newKey), "pi.sqlite"),
          "utf8",
        ),
      ).toBe("native bytes untouched");
      expect(
        JSON.parse(await readFile(join(f.destination, "config.json"), "utf8")),
      ).toEqual({
        maintenance: { stargate: { root: "/srv/stargate" } },
        bots: [{ id: "pogo" }],
      });
      expect(
        await stat(join(f.destination, ".stargate-cutover-complete.json")),
      ).toBeDefined();
      const original = new Database(join(f.source, "pogo.sqlite"), {
        readonly: true,
      });
      expect(
        original.query("SELECT botKey,conversation FROM jobs").get(),
      ).toEqual({ botKey: f.oldKey, conversation: f.conversation });
      original.close();
      await expect(migrateSnapshot(f.plan)).rejects.toThrow("already exists");
    },
  );

  test("refuses collisions and leaves source unchanged without a completion marker", async () => {
    const f = await fixture("0.20");
    const db = new Database(join(f.source, "pogo.sqlite"));
    db.query("INSERT INTO ignored_events VALUES (?,'other')").run(f.newKey);
    db.close();
    await expect(migrateSnapshot(f.plan)).rejects.toThrow("already exists");
    expect(
      await Bun.file(
        join(f.destination, ".stargate-cutover-complete.json"),
      ).exists(),
    ).toBe(false);
    const source = new Database(join(f.source, "pogo.sqlite"), {
      readonly: true,
    });
    expect(
      source
        .query("SELECT name FROM sqlite_master WHERE name='irc_pogo_dm'")
        .get(),
    ).not.toBeNull();
    source.close();
  });

  test("refuses guessed native cell edits, live sidecars and identity changes", async () => {
    const f = await fixture("0.20");
    await expect(
      migrateSnapshot({
        ...f.plan,
        botKeys: [
          { from: f.oldKey, to: f.newKey.replace('"pogo"', '"renamed-bot"') },
        ],
      }),
    ).rejects.toThrow("only the backend fingerprint");
    await writeFile(join(f.source, "native.sqlite-wal"), "live");
    await expect(migrateSnapshot(f.plan)).rejects.toThrow("sidecar");
    await rm(join(f.source, "native.sqlite-wal"));
    const cells = f.plan.cells?.map((cell) => ({ ...cell, before: "wrong" }));
    await expect(
      migrateSnapshot({ ...f.plan, cells: cells ?? [] }),
    ).rejects.toThrow("precondition");
    expect(
      await Bun.file(
        join(f.destination, ".stargate-cutover-complete.json"),
      ).exists(),
    ).toBe(false);
  });

  test("path mapping respects boundaries and explicit longest prefixes", () => {
    const paths = [
      { from: "/srv/pogo", to: "/srv/stargate" },
      { from: "/srv/pogo/crew", to: "/work/crew" },
    ];
    expect(migratedPath("/srv/pogo/crew/a", paths)).toBe("/work/crew/a");
    expect(migratedPath("/srv/pogostick/a", paths)).toBe("/srv/pogostick/a");
    expect(migratedPath(prompt, paths)).toBe(prompt);
  });

  test("configuration fails closed rather than silently opening parallel empty state", async () => {
    const root = await directory();
    const path = join(root, "stargate.json");
    await writeFile(path, JSON.stringify({ bots: [bot()] }));
    await mkdir(join(root, ".pogo"));
    await expect(loadConfig(path)).rejects.toThrow("Unconverted Pogo state");
    await mkdir(join(root, ".stargate"));
    await expect(loadConfig(path)).rejects.toThrow("Unconverted Pogo state");
    await writeFile(join(root, ".stargate", "pogo.sqlite"), "old");
    await expect(loadConfig(path)).rejects.toThrow("Unconverted Pogo state");
    expect(
      await Bun.file(join(root, ".stargate", "stargate.sqlite")).exists(),
    ).toBe(false);
    expect(
      configSchema.safeParse({ bots: [bot()], maintenance: { pogo: {} } })
        .success,
    ).toBe(false);
  });
});
