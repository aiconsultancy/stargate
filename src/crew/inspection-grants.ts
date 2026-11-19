import type { Database } from "bun:sqlite";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { CrewError } from "./error";
import { inspectionTeamIdentity } from "./identity";
import { agentIDSchema } from "./team";

/** greybeard: one explicit current target, 15 minutes, no renewal or grants of
 * grants. Widen the schema only with a separately reviewed authority policy. */
export const inspectionGrantLifetimeMs = 15 * 60_000;
const taskID = z.string().startsWith("task_").max(100);
const grantID = z.string().regex(/^inspect_[a-f0-9]{32}$/);
const key = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
const page = {
  after: z.number().int().safe().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
export const inspectionGrantInputSchemas = [
  z.strictObject({
    op: z
      .literal("grant-inspect")
      .describe(
        "Pinned captain only: grant one assigned worker read-only inspect for one current same-team target. Actual caller must also hold inspect. Protected use needs fresh read-only issuer proof; SDK 2.2.7 cannot supply it and fails closed. No human, rank or cross-ship issuer authority; no subdelegation.",
      ),
    crew: agentIDSchema,
    taskID,
    resource: z
      .strictObject({ crew: agentIDSchema, taskID })
      .describe(
        "One explicit same-team running target owned by the issuing captain; no wildcard or foreign task.",
      ),
    expiresAt: z.iso
      .datetime({ offset: true })
      .describe(
        "Required future RFC3339 expiry with timezone, at most 15 minutes after issuance. Never auto-renewed.",
      ),
    key,
  }),
  z.strictObject({ op: z.literal("list-inspect-grants"), ...page }),
  z.strictObject({ op: z.literal("revoke-inspect"), grantID, key }),
  z.strictObject({ op: z.literal("audit-inspect-grant"), grantID, ...page }),
] as const;
export const inspectionGrantIDSchema = grantID.describe(
  "Non-bearer selector from grant-inspect/list-inspect-grants. Valid only for the exact assigned recipient, current task and inspect resource. No requestStatus or other powers.",
);
export type InspectionGrantOperation = z.infer<
  (typeof inspectionGrantInputSchemas)[number]
>;
const binding = z.strictObject({
  crew: agentIDSchema,
  taskID,
  sessionID: z.string().min(1).max(256),
  inputID: z.string().min(1).max(256),
  conversationID: z.string().min(1).max(256).nullable(),
});
const payloadSchema = z.strictObject({
  version: z.literal(1),
  team: z.string(),
  issuer: z.string().min(1).max(256),
  recipient: binding,
  resource: binding,
  issuedAt: z.number().int().safe(),
  expiresAt: z.number().int().safe(),
});
export type InspectionBinding = z.infer<typeof binding>;
export type InspectionGrant = z.infer<typeof payloadSchema> & { id: string };
export type InspectionGrantView = InspectionGrant & {
  revokedAt: number | null;
};
export type InspectionAuditSubject = {
  id: string | null;
  issuer: string;
  recipient: Pick<InspectionBinding, "sessionID" | "taskID">;
  resource: Pick<InspectionBinding, "crew" | "taskID">;
};

export function inspectionGrantView(grant: InspectionGrantView) {
  return {
    id: grant.id,
    issuer: grant.issuer,
    recipient: {
      crew: grant.recipient.crew,
      taskID: grant.recipient.taskID,
      sessionID: grant.recipient.sessionID,
    },
    resource: { crew: grant.resource.crew, taskID: grant.resource.taskID },
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    humanApproval: false as const,
  };
}
export type InspectionDenial =
  | "invalid-input"
  | "identity"
  | "native-denied"
  | "proof"
  | "expired"
  | "revoked"
  | "scope"
  | "task"
  | "controller"
  | "lifetime"
  | "replay"
  | "cancelled"
  | "unavailable";
export class InspectionDenied extends CrewError {
  constructor(readonly reason: InspectionDenial) {
    super(
      `Inspection capability denied (${reason}); no protected data released.`,
    );
  }
}
type StoredGrant = {
  id: string;
  payload: string;
  proof: string;
  revokedAt: number | null;
};
export type InspectionAudit = {
  id: number;
  grantID: string | null;
  team: string;
  issuer: string | null;
  recipient: string | null;
  taskID: string | null;
  operation: string;
  resource: string | null;
  resourceTaskID: string | null;
  actor: string;
  agent: string;
  at: number;
  outcome: string;
  reason: string;
};

/** Private tables in CrewState's existing database, not another state owner.
 * The HMAC and key never leave this store. Handles are selectors, not bearers. */
export class InspectionGrants {
  private readonly secret: string | null;
  readonly team: string;
  constructor(
    private readonly db: Database,
    identity: string,
  ) {
    this.team = createHash("sha256")
      .update(inspectionTeamIdentity(identity))
      .digest("hex");
    db.exec(`
      CREATE TABLE IF NOT EXISTS inspection_authority (
        id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inspection_grants (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, proof TEXT NOT NULL,
        revokedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS inspection_receipts (
        issuer TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL,
        grantID TEXT NOT NULL REFERENCES inspection_grants(id),
        PRIMARY KEY(issuer,key)
      );
      CREATE TABLE IF NOT EXISTS inspection_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, grantID TEXT, team TEXT NOT NULL,
        issuer TEXT, recipient TEXT, taskID TEXT, operation TEXT NOT NULL,
        resource TEXT, resourceTaskID TEXT, actor TEXT NOT NULL,
        agent TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inspection_audit_grant ON inspection_audit(grantID,id);
    `);
    this.secret = db
      .transaction(() => {
        const saved = db
          .query<{ secret: string }, []>(
            "SELECT secret FROM inspection_authority WHERE id=1",
          )
          .get();
        if (saved) {
          return /^[a-f0-9]{64}$/.test(saved.secret) ? saved.secret : null;
        }
        if (db.query("SELECT 1 FROM inspection_grants LIMIT 1").get())
          return null;
        const secret = randomBytes(32).toString("hex");
        db.query("INSERT INTO inspection_authority VALUES (1,?)").run(secret);
        return secret;
      })
      .immediate();
  }

  private proof(id: string, payload: string, revokedAt: number | null) {
    this.requireCustody();
    if (!this.secret) throw new InspectionDenied("proof");
    return createHmac("sha256", Buffer.from(this.secret, "hex"))
      .update(
        JSON.stringify(["stargate-inspection-v1", id, payload, revokedAt]),
      )
      .digest("hex");
  }

  /** Lost custody disables capabilities, never ordinary crew/recovery tools.
   * Retained grants/audits remain untouched; do not silently rotate their key. */
  requireCustody() {
    if (!this.secret) throw new InspectionDenied("proof");
  }

  get(id: string): InspectionGrantView {
    const saved = this.db
      .query<StoredGrant, [string]>(
        "SELECT id,payload,proof,revokedAt FROM inspection_grants WHERE id=?",
      )
      .get(id);
    if (
      !saved ||
      !/^[a-f0-9]{64}$/.test(saved.proof) ||
      !timingSafeEqual(
        Buffer.from(saved.proof, "hex"),
        Buffer.from(this.proof(id, saved.payload, saved.revokedAt), "hex"),
      )
    )
      throw new InspectionDenied("proof");
    const parsed = payloadSchema.safeParse(JSON.parse(saved.payload));
    if (
      !parsed.success ||
      parsed.data.team !== this.team ||
      parsed.data.expiresAt <= parsed.data.issuedAt ||
      parsed.data.expiresAt - parsed.data.issuedAt > inspectionGrantLifetimeMs
    )
      throw new InspectionDenied("proof");
    return { id, ...parsed.data, revokedAt: saved.revokedAt };
  }

  check(id: string, now: number): InspectionGrantView {
    const grant = this.get(id);
    if (grant.revokedAt !== null) throw new InspectionDenied("revoked");
    if (now < grant.issuedAt || now >= grant.expiresAt)
      throw new InspectionDenied("expired");
    return grant;
  }

  replay(
    issuer: string,
    key: string,
    args: unknown,
  ): InspectionGrantView | null {
    const receipt = this.db
      .query<{ digest: string; grantID: string }, [string, string]>(
        "SELECT digest,grantID FROM inspection_receipts WHERE issuer=? AND key=?",
      )
      .get(issuer, key);
    if (!receipt) return null;
    if (receipt.digest !== this.digest(args))
      throw new InspectionDenied("replay");
    return this.get(receipt.grantID);
  }

  private digest(args: unknown) {
    return createHash("sha256").update(JSON.stringify(args)).digest("hex");
  }

  issue(
    payload: Omit<InspectionGrant, "id" | "version" | "team">,
    key: string,
    args: unknown,
    actor: { sessionID: string; agent: string },
  ) {
    return this.db
      .transaction(() => {
        const replay = this.replay(payload.issuer, key, args);
        if (replay) return replay;
        const id = `inspect_${randomUUID().replaceAll("-", "")}`;
        const value = JSON.stringify({
          version: 1,
          team: this.team,
          ...payload,
        });
        this.db
          .query(
            "INSERT INTO inspection_grants(id,payload,proof) VALUES (?,?,?)",
          )
          .run(id, value, this.proof(id, value, null));
        this.receipt(payload.issuer, key, args, id);
        const grant = this.get(id);
        this.record(
          grant,
          actor,
          "grant-inspect",
          "issued",
          "current-task",
          payload.issuedAt,
        );
        return grant;
      })
      .immediate();
  }

  private receipt(issuer: string, key: string, args: unknown, id: string) {
    this.db
      .query("INSERT INTO inspection_receipts VALUES (?,?,?,?)")
      .run(issuer, key, this.digest(args), id);
  }

  revoke(
    grant: InspectionGrantView,
    key: string,
    args: unknown,
    actor: { sessionID: string; agent: string },
    now: number,
  ) {
    return this.db
      .transaction(() => {
        const replay = this.replay(grant.issuer, key, args);
        if (replay) return replay;
        this.get(grant.id);
        const row = this.db
          .query<StoredGrant, [string]>(
            "SELECT id,payload,proof,revokedAt FROM inspection_grants WHERE id=?",
          )
          .get(grant.id);
        if (!row) throw new InspectionDenied("proof");
        const revokedAt = row.revokedAt ?? now;
        this.db
          .query("UPDATE inspection_grants SET revokedAt=?,proof=? WHERE id=?")
          .run(
            revokedAt,
            this.proof(grant.id, row.payload, revokedAt),
            grant.id,
          );
        this.receipt(grant.issuer, key, args, grant.id);
        const current = this.get(grant.id);
        this.record(
          current,
          actor,
          "revoke-inspect",
          "revoked",
          "captain-revoke",
          now,
        );
        return current;
      })
      .immediate();
  }

  list(
    issuer: string | null,
    recipient: string,
    taskID: string | null,
    after: number,
    limit: number,
  ) {
    const rows = this.db
      .query<
        { sequence: number; id: string },
        [number, string | null, string, string | null, number]
      >(`
      SELECT sequence,id FROM inspection_grants WHERE sequence>?1 AND
      ((?2 IS NOT NULL AND json_extract(payload,'$.issuer')=?2) OR
       (?2 IS NULL AND json_extract(payload,'$.recipient.sessionID')=?3
        AND json_extract(payload,'$.recipient.taskID')=?4))
      ORDER BY sequence LIMIT ?5`)
      .all(after, issuer, recipient, taskID, limit);
    return {
      grants: rows.map(({ id }) => this.get(id)),
      nextAfter: rows.at(-1)?.sequence ?? after,
    };
  }

  record(
    grant: InspectionAuditSubject | null,
    actor: { sessionID: string; agent: string },
    operation: string,
    outcome: string,
    reason: string,
    at: number,
  ) {
    // No free-form reasons, raw input, SDK errors, prompts, keys or MACs.
    this.db
      .query(`INSERT INTO inspection_audit
      (grantID,team,issuer,recipient,taskID,operation,resource,resourceTaskID,actor,agent,at,outcome,reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        grant?.id ?? null,
        this.team,
        grant?.issuer ?? null,
        grant?.recipient.sessionID ?? null,
        grant?.recipient.taskID ?? null,
        operation,
        grant?.resource.crew ?? null,
        grant?.resource.taskID ?? null,
        actor.sessionID,
        actor.agent,
        at,
        outcome,
        reason,
      );
  }

  audit(id: string, after: number, limit: number) {
    const audit = this.db
      .query<InspectionAudit, [string, number, number]>(
        "SELECT * FROM inspection_audit WHERE grantID=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(id, after, limit);
    return { audit, nextAfter: audit.at(-1)?.id ?? after };
  }
}
