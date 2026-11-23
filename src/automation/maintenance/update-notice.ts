import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Predicate, Schema } from "effect";
import { redactCredentials } from "../../lib/credentials";
import { metaCommandSyntax } from "../../meta-commands/meta-command-syntax";
import { compareVersions, parseVersion } from "./nightly/update/versions";

const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");

const flagPaths = [
  "notifications.updateNotice",
  "maintenance.enabled",
  "maintenance.models.updateGlobalCatalog",
  "maintenance.components.stargate",
  "maintenance.components.cliproxyapi",
  "maintenance.components.agentClis",
  "maintenance.components.models",
  "dashboard",
] as const;

const readPath = (value: unknown, path: string): unknown => {
  let node = value;

  for (const key of path.split("."))
    node = Predicate.isObject(node) ? node[key] : undefined;

  return node;
};

export const updateSnapshotSchema = Schema.Struct({
  version: Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
  ),
  configDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  flags: Schema.Record(
    Schema.String.check(
      Schema.isPattern(
        /^(?:notifications\.updateNotice|maintenance\.(?:enabled|models\.updateGlobalCatalog|components\.(?:stargate|cliproxyapi|agentClis|models))|dashboard)$/,
      ),
    ),
    Schema.Boolean,
  ),
  commands: Schema.Array(Schema.String),
  changes: Schema.Array(
    Schema.Struct({
      version: Schema.NullOr(Schema.String),
      text: Schema.String,
    }),
  ),
  tools: Schema.NullOr(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^stargate_[a-z0-9_]+$/)),
      Schema.String,
    ),
  ),
});

export type UpdateSnapshot = typeof updateSnapshotSchema.Type;

export type UpdateReceipt = {
  sessionID: string;
  status: "queued" | "mail" | "unchanged" | "uncertain";
};

/** Fixed projections only: config values, access rules and tool descriptions never become prose. */
export function buildUpdateSnapshot(
  version: string | null,
  config: unknown,
  changelog: string,
): UpdateSnapshot {
  const flags = Object.fromEntries(
    flagPaths.map((path) => [path, readPath(config, path) === true]),
  );

  let section = version;
  const changes = [];

  for (const line of redactCredentials(changelog, 12_000).split("\n")) {
    const heading = /^## (?:v)?(\d+\.\d+\.\d+)/.exec(line);

    if (heading?.[1]) section = heading[1];
    else if (line === "## Unreleased") section = version;
    else if (line.startsWith("- ") && changes.length < 40)
      changes.push({ version: section, text: line.slice(2, 302) });
  }

  const registrations = ["bots", "irc", "teams"]
    .map((name) => readPath(config, name))
    .flatMap((items) =>
      Array.isArray(items)
        ? items.map((item: unknown) => ({
            access: readPath(item, "access"),
            permissions: readPath(item, "backend.permissions"),
            model: readPath(item, "backend.model"),
            agent: readPath(item, "backend.agent"),
          }))
        : [],
    );

  return {
    version,
    flags,
    configDigest: digest({ flags, registrations }),
    commands: metaCommandSyntax(),
    changes,
    tools: null,
  };
}

export function noticeTools(
  tools: readonly { id: string; description?: string; input?: unknown }[],
) {
  return Object.fromEntries(
    tools
      .filter((tool) => /^stargate_[a-z0-9_]+$/.test(tool.id))
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((tool) => {
        let input: unknown;

        try {
          input = Schema.isSchema(tool.input)
            ? Schema.toJsonSchemaDocument(tool.input)
            : tool.input;
        } catch {
          input = "unavailable";
        }

        return [
          tool.id,
          digest({ description: tool.description ?? "", input }),
        ];
      }),
  );
}

export function scopedUpdate(
  snapshot: UpdateSnapshot,
  tools: Record<string, string> | null,
  effective: unknown,
): UpdateSnapshot {
  return {
    ...snapshot,
    tools,
    configDigest: digest({ host: snapshot.configDigest, effective }),
  };
}

function noticeText(
  previous: UpdateSnapshot | undefined,
  next: UpdateSnapshot,
) {
  const tools = Object.keys(next.tools ?? {}).toSorted();
  const added = tools.filter((name) => !previous?.tools?.[name]);

  const changed = tools.filter((name) => {
    const before = previous?.tools?.[name];

    return (
      before !== undefined && before !== "" && before !== next.tools?.[name]
    );
  });

  const removed = Object.keys(previous?.tools ?? {}).filter(
    (name) => !next.tools?.[name],
  );

  const commands = next.commands.filter(
    (name) => !previous?.commands.includes(name),
  );

  const lines = [
    `[Stargate update notice: ${previous?.version ?? "initial"} → ${next.version ?? "checkout"}]`,
    "Context only. Do not interrupt, repeat or resume assigned work, change settings, or send an acknowledgement.",
  ];

  if (added.length > 0) lines.push(`New tools: ${added.join(", ")}`);

  if (changed.length > 0) lines.push(`Changed tools: ${changed.join(", ")}`);

  if (removed.length > 0) lines.push(`Removed tools: ${removed.join(", ")}`);
  lines.push(
    "Use the host's registered tool listing for current names and schemas; permissions remain authoritative.",
  );

  if (commands.length > 0)
    lines.push(
      `Meta commands (captain-addressed Slack): ${commands.join(", ")}`,
    );
  lines.push(
    ...Object.entries(next.flags).map(
      ([name, on]) => `${name}: ${on ? "on" : "off"}`,
    ),
  );

  if (previous && previous.configDigest !== next.configDigest)
    lines.push(
      "Effective tools, permissions, flags or models changed. Re-read their current settings; no new authority is granted.",
    );

  if (!previous || previous.version !== next.version)
    lines.push(
      ...next.changes
        .filter(
          (change) =>
            !change.version ||
            !previous?.version ||
            !parseVersion(change.version) ||
            (compareVersions(change.version, previous.version) > 0 &&
              (!next.version ||
                compareVersions(change.version, next.version) <= 0)),
        )
        .slice(0, 10)
        .map((change) => `Change: ${change.text}`),
    );

  if (next.version && /^\d+\.\d+\.\d+$/.test(next.version))
    lines.push(
      `Release notes: https://github.com/aiconsultancy/stargate/releases/tag/v${next.version}`,
    );

  return redactCredentials(lines.join("\n"), 6000);
}

type Row = {
  id: string;
  token: string;
  snapshot: string;
  acknowledged: string | null;
  text: string;
  status: string;
};

/** Receipt tables share their existing gateway/crew database owner. No mail copy or worker queue. */
export class UpdateNotices {
  public constructor(private readonly db: Database) {
    db.run(
      "CREATE TABLE IF NOT EXISTS update_notice_state (scope TEXT NOT NULL, sessionID TEXT NOT NULL, id TEXT NOT NULL, token TEXT NOT NULL, snapshot TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, acknowledged TEXT, PRIMARY KEY(scope,sessionID))",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS update_notice_context (id TEXT PRIMARY KEY, scope TEXT NOT NULL, sessionID TEXT NOT NULL, text TEXT NOT NULL)",
    );
  }

  /** Local context queue, not a native inbox input: never affects task lineage or idle guards. */
  public queueExternalContext(
    sessionID: string,
    id: string,
    text: string,
    scope: string,
  ) {
    this.db
      .query(
        "INSERT OR IGNORE INTO update_notice_context (id,scope,sessionID,text) VALUES (?,?,?,?)",
      )
      .run(id, scope, sessionID, text);
  }

  public queueContext(sessionID: string, id: string, scope: string) {
    this.db
      .transaction(() => {
        const written = this.db
          .query(
            "INSERT OR IGNORE INTO update_notice_context SELECT id,scope,sessionID,text FROM update_notice_state WHERE scope=? AND sessionID=? AND id=?",
          )
          .run(scope, sessionID, id);

        if (written.changes !== 1)
          throw new Error("Update context intent missing");
        this.db
          .query(
            "UPDATE update_notice_state SET status='queued',acknowledged=snapshot WHERE scope=? AND sessionID=? AND id=?",
          )
          .run(scope, sessionID, id);
      })
      .immediate();
  }

  public consumeContext(
    sessionID: string,
    scope: string,
    append: (text: string) => void,
  ) {
    this.db
      .transaction(() => {
        const pending = this.db
          .query<{ id: string; text: string }, [string, string]>(
            "SELECT id,text FROM update_notice_context WHERE scope=? AND sessionID=? ORDER BY rowid LIMIT 10",
          )
          .all(scope, sessionID);

        for (const notice of pending) {
          append(notice.text);
          this.db
            .query("DELETE FROM update_notice_context WHERE id=?")
            .run(notice.id);
        }
      })
      .immediate();
  }
  public async deliver(
    sessionID: string,
    snapshot: UpdateSnapshot,
    mode: "queued" | "mail",
    queue: (id: string, text: string) => Promise<void>,
    scope = "",
  ): Promise<UpdateReceipt> {
    const intent = this.db
      .transaction(() => {
        const old = this.db
          .query<Row, [string, string]>(
            "SELECT * FROM update_notice_state WHERE scope=? AND sessionID=?",
          )
          .get(scope, sessionID);

        const previous = old?.acknowledged
          ? Schema.decodeUnknownSync(updateSnapshotSchema)(
              JSON.parse(old.acknowledged),
            )
          : undefined;

        const known = old
          ? Schema.decodeUnknownSync(updateSnapshotSchema)(
              JSON.parse(old.snapshot),
            )
          : undefined;

        const next = {
          ...snapshot,
          tools: snapshot.tools ?? known?.tools ?? null,
        };

        const token = digest({
          version: next.version,
          config: next.configDigest,
          tools: next.tools,
          commands: next.commands,
        });

        if (old?.token === token)
          return {
            id: old.id,
            status: old.status,
            text: old.text,
            send: false,
          };
        const text = noticeText(previous, next);
        const id = `msg_${digest([scope, sessionID, old?.id ?? "", token])}`;
        this.db
          .query(
            "INSERT INTO update_notice_state VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope,sessionID) DO UPDATE SET id=excluded.id,token=excluded.token,snapshot=excluded.snapshot,text=excluded.text,status=excluded.status",
          )
          .run(
            scope,
            sessionID,
            id,
            token,
            JSON.stringify(next),
            text,
            "uncertain",
            old?.acknowledged ?? null,
          );

        return { id, text, status: "uncertain", send: true };
      })
      .immediate();

    if (!intent.send)
      return {
        sessionID,
        status: intent.status === "uncertain" ? "uncertain" : "unchanged",
      };

    try {
      await queue(intent.id, intent.text);
      this.db
        .query(
          "UPDATE update_notice_state SET status=?,acknowledged=snapshot WHERE scope=? AND sessionID=? AND id=?",
        )
        .run(mode, scope, sessionID, intent.id);

      return { sessionID, status: mode };
    } catch {
      return { sessionID, status: "uncertain" };
    }
  }
}
