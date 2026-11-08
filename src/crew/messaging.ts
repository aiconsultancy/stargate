import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CrewCaller, CrewEngine } from "./engine";
import type { MesijClient } from "./mesij";
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
    CREATE TABLE IF NOT EXISTS mail_notices (id TEXT PRIMARY KEY);`);
  }
  get(id: string) {
    return this.db
      .query<MailRoute, [string]>("SELECT * FROM mail_routes WHERE id=?")
      .get(id);
  }
  save(route: MailRoute) {
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
  }
  notice(id: string): boolean {
    return (
      this.db.query("INSERT OR IGNORE INTO mail_notices VALUES (?)").run(id)
        .changes === 1
    );
  }
  cursor(sessionID: string, captainID: string, after?: number) {
    if (after !== undefined)
      this.db
        .query(`INSERT INTO mailbox_cursors VALUES (?,?,?)
      ON CONFLICT(sessionID,captainID) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)`)
        .run(sessionID, captainID, after);
    return (
      this.db
        .query<{ sequence: number }, [string, string]>(
          "SELECT sequence FROM mailbox_cursors WHERE sessionID=? AND captainID=?",
        )
        .get(sessionID, captainID)?.sequence ?? 0
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
      : contextTask?.originCaptainID === captainID
        ? contextTask
        : null;
    const actor = this.engine.mailActor(caller.sessionID);
    if (input.op === "inbox") {
      await this.mailer.register(actor, caller.sessionID, caller.signal);
      const after = routes.cursor(caller.sessionID, captainID, input.after);
      const events = await this.mailer.inbox(
        { sessionID: caller.sessionID, after, limit: input.limit },
        caller.signal,
      );
      const messages = events.flatMap((event) => {
        const route =
          routes.get(event.id) ?? this.engine.legacyStatusRoute(event);
        const statusRequest = this.engine.statusRequestRoute(event.id);
        if (
          !route ||
          route.recipient !== caller.sessionID ||
          (captainID && route.captainID !== captainID && !statusRequest) ||
          event.to !== caller.sessionID ||
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
      const recipient =
        peer?.sessionID ??
        (reply && reply.sender === reply.captainID
          ? reply.captainID
          : captainID);
      const candidate = peer ? this.engine.state.activeTask(member) : source;
      const target = statusReply
        ? source
        : candidate &&
            ["dispatching", "running", "cancelling"].includes(candidate.status)
          ? candidate
          : null;
      try {
        if (!registered) {
          await this.mailer.register(actor, caller.sessionID, caller.signal);
          registered = true;
        }
        await this.mailer.register(
          this.engine.mailActor(recipient),
          recipient,
          caller.signal,
        );
        const receipt = await this.mailer.send(
          {
            actor,
            sessionID: caller.sessionID,
            to: recipient,
            text: JSON.stringify({
              namespace: this.engine.options.namespace,
              sender: caller.sessionID,
              recipient,
              originCaptainID:
                statusReply && source ? source.originCaptainID : captainID,
              sourceTaskID: source?.id,
              targetTaskID: target?.id,
              text: input.text,
              ...(statusReply ? { statusRequestID: statusReply.id } : {}),
            }),
            key: createHash("sha256")
              .update(
                JSON.stringify([
                  this.engine.options.namespace,
                  caller.sessionID,
                  recipient,
                  key,
                ]),
              )
              .digest("hex"),
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          },
          caller.signal,
        );
        const route: MailRoute = {
          id: receipt.id,
          sender: caller.sessionID,
          recipient,
          captainID,
          sourceTaskID: source?.id ?? null,
          targetTaskID: target?.id ?? null,
        };
        routes.save(route);
        if (!source || !this.engine.state.reporting.isReport(source.id))
          this.engine.state.reporting.journal.append(
            {
              member: caller.agent,
              captainID,
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
              route,
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

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
