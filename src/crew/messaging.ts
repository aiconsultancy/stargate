import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CrewCaller, CrewEngine } from "./engine";
import type { MesijClient, MesijMessage } from "./mesij";
import { CrewError } from "./state";

const send = z.strictObject({
  op: z.literal("send"),
  to: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  text: z.string().trim().min(1).max(64000),
  taskID: z.string().startsWith("task_").max(100).optional(),
  key: z.string().min(1).max(100).optional(),
  replyTo: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
});
export const mailInputSchema = z.discriminatedUnion("op", [
  send,
  z.strictObject({
    op: z.literal("inbox"),
    taskID: z.string().startsWith("task_").max(100).optional(),
    after: z.number().int().safe().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
]);
export const dmInputSchema = send.extend({
  delivery: z.enum(["steer", "queue"]).default("steer"),
});
export type MailRoute = {
  id: string;
  sender: string;
  recipient: string;
  captainID: string;
  sourceTaskID: string | null;
  targetTaskID: string | null;
};
type MailIntent = Omit<MailRoute, "id"> & { fingerprint: string };
export class MailRoutes {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS mail_routes (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      captainID TEXT NOT NULL, sourceTaskID TEXT, targetTaskID TEXT
    );
    CREATE TABLE IF NOT EXISTS mailbox_cursors (
      sessionID TEXT NOT NULL, captainID TEXT NOT NULL, sequence INTEGER NOT NULL,
      PRIMARY KEY(sessionID,captainID)
    );
    CREATE TABLE IF NOT EXISTS mail_notices (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS mail_intents (
      key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
      sender TEXT NOT NULL, recipient TEXT NOT NULL, captainID TEXT NOT NULL,
      sourceTaskID TEXT, targetTaskID TEXT, receiptID TEXT
    );
    CREATE TABLE IF NOT EXISTS mail_route_holes (
      id TEXT PRIMARY KEY, recipient TEXT NOT NULL, captainID TEXT NOT NULL,
      sequence INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mail_intents_fingerprint ON mail_intents(fingerprint);`);
  }
  get(id: string) {
    return this.db
      .query<MailRoute, [string]>("SELECT * FROM mail_routes WHERE id=?")
      .get(id);
  }
  save(route: MailRoute, key?: string) {
    this.db
      .transaction(() => {
        if (key !== undefined) {
          const intent = this.db
            .query<
              Omit<MailRoute, "id"> & { receiptID: string | null },
              [string]
            >(
              "SELECT sender,recipient,captainID,sourceTaskID,targetTaskID,receiptID FROM mail_intents WHERE key=?",
            )
            .get(key);
          if (
            !intent ||
            intent.sender !== route.sender ||
            intent.recipient !== route.recipient ||
            intent.captainID !== route.captainID ||
            intent.sourceTaskID !== route.sourceTaskID ||
            intent.targetTaskID !== route.targetTaskID ||
            (intent.receiptID !== null && intent.receiptID !== route.id)
          )
            throw new CrewError(
              "Mail receipt does not match its authorized intent.",
            );
          this.db
            .query(
              "UPDATE mail_intents SET receiptID=? WHERE key=? AND receiptID IS NULL",
            )
            .run(route.id, key);
        }
        this.db
          .query("INSERT OR IGNORE INTO mail_routes VALUES (?,?,?,?,?,?)")
          .run(
            route.id,
            route.sender,
            route.recipient,
            route.captainID,
            route.sourceTaskID,
            route.targetTaskID,
          );
        this.db.query("DELETE FROM mail_route_holes WHERE id=?").run(route.id);
      })
      .immediate();
  }
  prepare(key: string, intent: MailIntent) {
    this.db
      .transaction(() => {
        this.db
          .query(
            "INSERT OR IGNORE INTO mail_intents VALUES (?,?,?,?,?,?,?,NULL)",
          )
          .run(
            key,
            intent.fingerprint,
            intent.sender,
            intent.recipient,
            intent.captainID,
            intent.sourceTaskID,
            intent.targetTaskID,
          );
        const saved = this.db
          .query<MailIntent, [string]>(
            "SELECT fingerprint,sender,recipient,captainID,sourceTaskID,targetTaskID FROM mail_intents WHERE key=?",
          )
          .get(key);
        if (
          !saved ||
          saved.fingerprint !== intent.fingerprint ||
          saved.sender !== intent.sender ||
          saved.recipient !== intent.recipient ||
          saved.captainID !== intent.captainID ||
          saved.sourceTaskID !== intent.sourceTaskID ||
          saved.targetTaskID !== intent.targetTaskID
        )
          throw new CrewError(
            "Mail retry key belongs to a different message or context.",
          );
      })
      .immediate();
  }
  recover(event: MesijMessage) {
    // Only a pre-authorized intent can repair a lost receipt. The digest binds
    // native sender/recipient/type/reply identity and the exact namespaced
    // task/captain envelope, not merely arbitrary JSON claims in the event.
    const repaired = this.db
      .transaction(() => {
        const intent = this.db
          .query<Omit<MailRoute, "id"> & { key: string }, [string, string]>(
            "SELECT key,sender,recipient,captainID,sourceTaskID,targetTaskID FROM mail_intents WHERE fingerprint=? AND (receiptID IS NULL OR receiptID=?) LIMIT 1",
          )
          .get(mailFingerprint(event), event.id);
        if (!intent) return { route: null };
        const { key, ...context } = intent;
        const route = { id: event.id, ...context };
        // Selection and binding share this transaction: an old bound intent
        // cannot authorize a copied event or create a spurious ACK barrier.
        this.db
          .query("INSERT OR IGNORE INTO mail_route_holes VALUES (?,?,?,?)")
          .run(event.id, intent.recipient, intent.captainID, event.sequence);
        try {
          this.save(route, key);
          return { route };
        } catch (error) {
          // save's nested transaction rolls back binding and route together.
          // Commit only the ACK ceiling so a failed repair remains readable.
          return { error };
        }
      })
      .immediate();
    if ("error" in repaired) throw repaired.error;
    return repaired.route;
  }
  notice(id: string): boolean {
    return (
      this.db.query("INSERT OR IGNORE INTO mail_notices VALUES (?)").run(id)
        .changes === 1
    );
  }
  /** `holes` "" bounds ACKs by every unrepaired route to this recipient. */
  cursor(
    sessionID: string,
    captainID: string,
    after?: number,
    holes = captainID,
  ) {
    const hole = this.db
      .query<{ sequence: number | null }, [string, string, string]>(
        "SELECT MIN(sequence) AS sequence FROM mail_route_holes WHERE recipient=? AND (?='' OR captainID=?)",
      )
      .get(sessionID, holes, holes)?.sequence;
    const ceiling = hole == null ? Number.MAX_SAFE_INTEGER : hole - 1;
    if (after !== undefined)
      this.db
        .query(`INSERT INTO mailbox_cursors VALUES (?,?,?)
      ON CONFLICT(sessionID,captainID) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)`)
        .run(sessionID, captainID, Math.min(after, ceiling));
    return Math.min(
      ceiling,
      this.db
        .query<{ sequence: number }, [string, string]>(
          "SELECT sequence FROM mailbox_cursors WHERE sessionID=? AND captainID=?",
        )
        .get(sessionID, captainID)?.sequence ?? 0,
    );
  }
}

/** One durable inbox; DM adds only a native notification receipt. */
export class CrewMessaging {
  constructor(
    private readonly engine: CrewEngine,
    private readonly mailer: Pick<MesijClient, "register" | "send" | "inbox">,
  ) {}

  async run(raw: unknown, caller: CrewCaller, direct = false) {
    const parsed = direct
      ? dmInputSchema.safeParse(raw)
      : mailInputSchema.safeParse(raw);
    if (!parsed.success) throw new CrewError("Invalid mail/DM input.");
    const input = parsed.data;
    await this.engine.authorize(caller);
    const routes = this.engine.state.mailRoutes;
    const reply =
      input.op === "send" && input.replyTo
        ? (routes.get(input.replyTo) ??
          this.engine.statusRequestRoute(input.replyTo))
        : null;
    if (
      input.op === "send" &&
      input.replyTo &&
      (!reply || reply.recipient !== caller.sessionID)
    )
      throw new CrewError(
        "Reply reference must name a validated message addressed to this caller.",
      );
    const statusReply =
      input.op === "send" && input.replyTo
        ? this.engine.state.statusRequest(input.replyTo)
        : null;
    if (
      input.op === "send" &&
      statusReply &&
      (statusReply.receiptID !== input.replyTo ||
        statusReply.workerSessionID !== caller.sessionID ||
        (input.taskID && statusReply.taskID !== input.taskID))
    )
      throw new CrewError("Status reply does not belong to this worker/task.");
    const contextTask = this.engine.mailTask(
      caller,
      input.taskID,
      input.op === "inbox" || !!statusReply,
    );
    const captainID =
      caller.agent === this.engine.options.team.captain.id
        ? caller.sessionID
        : (reply?.captainID ??
          contextTask?.originCaptainID ??
          (input.op === "inbox" ? "" : undefined));
    if (captainID === undefined)
      throw new CrewError(
        "Mail requires an originating captain context or a validated reply.",
      );
    const source = statusReply
      ? this.engine.state.task(statusReply.taskID)
      : contextTask &&
          this.engine.sameCaptain(contextTask.originCaptainID, captainID)
        ? contextTask
        : null;
    const actor = this.engine.mailActor(caller.sessionID);
    if (input.op === "inbox") {
      await this.mailer.register(actor, caller.sessionID, caller.signal);
      const after = routes.cursor(
        caller.sessionID,
        captainID,
        input.after,
        // One pinned captain: holes from any of its lineage bound this ACK.
        this.engine.state.captainLineage(captainID) ? "" : captainID,
      );
      const events = await this.mailer.inbox(
        { sessionID: caller.sessionID, after, limit: input.limit },
        caller.signal,
      );
      const messages = events.flatMap((event) => {
        if (event.to !== caller.sessionID) return [];
        const route =
          routes.get(event.id) ??
          this.engine.legacyStatusRoute(event) ??
          routes.recover(event);
        const statusRequest = this.engine.statusRequestRoute(event.id);
        if (
          !route ||
          route.recipient !== caller.sessionID ||
          (captainID &&
            !this.engine.sameCaptain(route.captainID, captainID) &&
            !statusRequest) ||
          event.sessionID !== route.sender ||
          event.actor !== this.engine.mailActor(route.sender) ||
          (input.taskID && route.targetTaskID !== input.taskID)
        )
          return [];
        const envelope = z
          .object({ text: z.string() })
          .safeParse(parseJSON(event.text));
        return envelope.success
          ? [
              {
                id: event.id,
                sequence: event.sequence,
                from:
                  this.engine.state.peerBySession(route.sender)?.crewID ??
                  this.engine.options.team.captain.id,
                text: envelope.data.text,
                ...(route.sourceTaskID
                  ? { sourceTaskID: route.sourceTaskID }
                  : {}),
                ...(event.replyTo ? { replyTo: event.replyTo } : {}),
              },
            ]
          : [];
      });
      return {
        status: "inbox",
        messages,
        nextAfter: events.at(-1)?.sequence ?? after,
      };
    }
    const captain = this.engine.options.team.captain.id;
    const to = input.to === "captain" ? captain : input.to;
    if (reply) {
      const sender =
        this.engine.state.peerBySession(reply.sender)?.crewID ??
        (reply.sender === reply.captainID ? captain : undefined);
      if (to !== sender)
        throw new CrewError(
          "A reply must target the validated message sender; use a separate send for broadcasts.",
        );
    }
    const recipients =
      to === "all"
        ? [
            captain,
            ...this.engine.options.team.crew.map(({ id }) => id),
          ].filter((id) => id !== caller.agent)
        : [to];
    const key = input.key ?? caller.id;
    if (!key)
      throw new CrewError(
        "Mail requires a host tool-call identity or legacy key.",
      );
    const receipts: {
      to: string;
      stored: boolean | "uncertain";
      notification: string;
      id?: string;
      sequence?: number;
      diagnostic?: string;
    }[] = [];
    let registered = false;
    for (const member of recipients) {
      if (member === caller.agent)
        throw new CrewError("Direct self-send is refused.");
      const definition = this.engine.options.team.crew.find(
        ({ id }) => id === member,
      );
      if (member !== captain && !definition)
        throw new CrewError("Unknown configured mail recipient.");
      if (definition?.backend?.tools === "none") {
        receipts.push({
          to: member,
          stored: false,
          notification: "unsupported",
          diagnostic: "Pi tools are disabled; mail was not stored.",
        });
        continue;
      }
      // Leave room for inbox metadata below Pi's 50 KiB output ceiling.
      if (
        definition?.backend &&
        Buffer.byteLength(JSON.stringify(input.text), "utf8") > 40 * 1024
      ) {
        receipts.push({
          to: member,
          stored: false,
          notification: "unsupported",
          diagnostic:
            "Message is too large for the Pi inbox; mail was not stored.",
        });
        continue;
      }
      const peer =
        member === captain ? null : this.engine.state.reservePeer(member);
      // Earlier captain roots are evidence; pinned teams wake only the pin.
      const recipient =
        peer?.sessionID ??
        this.engine.state.captainRoute(
          reply && reply.sender === reply.captainID
            ? reply.captainID
            : captainID,
        );
      const candidate = peer ? this.engine.state.activeTask(member) : source;
      const target = statusReply
        ? source
        : candidate &&
            ["dispatching", "running", "cancelling"].includes(candidate.status)
          ? candidate
          : null;
      const route = {
        sender: caller.sessionID,
        recipient,
        captainID,
        sourceTaskID: source?.id ?? null,
        targetTaskID: target?.id ?? null,
      };
      const intentKey = createHash("sha256")
        .update(
          JSON.stringify([
            this.engine.options.namespace,
            caller.sessionID,
            recipient,
            key,
          ]),
        )
        .digest("hex");
      const message = {
        actor,
        sessionID: caller.sessionID,
        to: recipient,
        text: JSON.stringify({
          namespace: this.engine.options.namespace,
          // Bind identical human text to this send, not another pending intent.
          intentKey,
          sender: caller.sessionID,
          recipient,
          originCaptainID:
            statusReply && source ? source.originCaptainID : captainID,
          sourceTaskID: source?.id,
          targetTaskID: target?.id,
          text: input.text,
          ...(statusReply ? { statusRequestID: statusReply.id } : {}),
        }),
        key: intentKey,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      };
      try {
        routes.prepare(message.key, {
          ...route,
          fingerprint: mailFingerprint({
            ...message,
            type: message.replyTo ? "message.replied" : "message.posted",
          }),
        });
        if (!registered) {
          await this.mailer.register(actor, caller.sessionID, caller.signal);
          registered = true;
        }
        await this.mailer.register(
          this.engine.mailActor(recipient),
          recipient,
          caller.signal,
        );
        const receipt = await this.mailer.send(message, caller.signal);
        const storedRoute: MailRoute = { id: receipt.id, ...route };
        routes.save(storedRoute, message.key);
        if (!source || !this.engine.state.reporting.isReport(source.id))
          this.engine.state.reporting.journal.append(
            {
              member: caller.agent,
              captainID: this.engine.state.captainRoute(captainID),
              taskID: source?.id ?? null,
              kind: "message",
              text: `${this.engine.roster().find(({ id }) => id === caller.agent)?.name ?? caller.agent} → ${this.engine.roster().find(({ id }) => id === member)?.name ?? member}: ${input.text}`,
            },
            `mail:${receipt.id}`,
          );
        let notification = "not_requested";
        if (
          direct &&
          "delivery" in input &&
          (input.delivery === "steer" || input.delivery === "queue")
        )
          try {
            notification = await this.engine.notifyMail(
              storedRoute,
              caller,
              input.text,
              input.delivery,
            );
          } catch {
            notification = "uncertain";
          }
        receipts.push({ ...receipt, to: member, stored: true, notification });
      } catch {
        receipts.push({
          to: member,
          stored: "uncertain",
          notification: "not_requested",
          diagnostic:
            "Mail admission unconfirmed. Retry only the same message key; no notification was replayed.",
        });
      }
    }
    return recipients.length === 1
      ? { status: "sent", ...receipts[0] }
      : { status: "sent", receipts };
  }
}

function mailFingerprint(
  event: Pick<
    MesijMessage,
    "actor" | "sessionID" | "to" | "type" | "text" | "replyTo"
  >,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.actor,
        event.sessionID,
        event.to,
        event.type,
        event.text,
        event.replyTo ?? null,
      ]),
    )
    .digest("hex");
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
