import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { fleetJobSchema } from "../coordination/fleet/protocol";
import { inboundReactionSchema } from "../shared/reactions";
import type { IrcOperations } from "../transports/irc/store-contract";
import type { StoredJob } from "./row-codec";
import type { Incoming, Job } from "./store-types";

const followUpSchema = Schema.Struct({
  botKey: Schema.String,
  eventId: Schema.String,
  conversation: Schema.String,
  channel: Schema.String,
  thread: Schema.String,
  replyParent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  user: Schema.String,
  text: Schema.String,
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  received: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  sender: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["captain", "crew"])),
  ),
  gate: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["spoken", "admitted"])),
  ),
  textMention: Schema.optionalKey(Schema.NullOr(Schema.String)),
  notBefore: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  deferDelivery: Schema.optionalKey(Schema.Boolean),
  fleet: Schema.optionalKey(fleetJobSchema),
  slackReaction: Schema.optionalKey(inboundReactionSchema),
  notification: Schema.optionalKey(
    Schema.Struct({
      wake: Schema.Literals(["ordinary", "direct", "broadcast"]),
      note: Schema.optionalKey(Schema.String),
    }),
  ),
});

export type ThreadFollowUp = {
  botKey: string;
  eventId: string;
  owner: number;
  sessionID: string;
  inputID: string;
  nativeID: string;
  transport: "slack" | "irc";
  state: "pending" | "writing" | "accepted" | "uncertain" | "queued";
  notified: number;
  reconcileAttempts: number;
  retryAt: number;
  payload: string;
};

export interface FollowUpJobOperations {
  enqueue(input: Incoming): boolean;
  jobByEvent(botKey: string, eventId: string): Job | null;
  jobByInput(botKey: string, input: string): Job | null;
}

export class ThreadFollowUpRecords {
  public constructor(
    private readonly db: Database,
    private readonly jobs: FollowUpJobOperations,
    private readonly irc: Pick<
      IrcOperations,
      "ircThreadMessage" | "ircThreadParticipating" | "joinIrcThread"
    >,
  ) {}

  /** Persist admission before transport ACK. Undefined keeps ordinary intake. */
  public admitFollowUp(
    input: Incoming,
    sessionID: string,
    transport: "slack" | "irc" = "slack",
    invited = false,
  ): boolean | undefined {
    return this.db.transaction(() => {
      if (
        this.db
          .query("SELECT 1 FROM thread_followups WHERE botKey=? AND eventId=?")
          .get(input.botKey, input.eventId) !== null ||
        this.jobs.jobByEvent(input.botKey, input.eventId)
      )
        return false;

      const owner = this.db
        .query<StoredJob, [string]>(
          "SELECT * FROM jobs WHERE botKey=? AND status='running' ORDER BY id DESC LIMIT 1",
        )
        .get(input.botKey);

      if (!owner) return;

      const root = (message: Pick<Incoming, "thread" | "replyParent">) =>
        transport === "irc"
          ? (message.replyParent ?? message.thread)
          : message.thread;

      const eligible =
        owner.conversation === input.conversation &&
        owner.channel === input.channel &&
        root(owner) === root(input) &&
        !!owner.input &&
        !input.sender &&
        !input.fleet &&
        !input.gate &&
        !input.deferDelivery &&
        !input.files?.length;

      if (!eligible && !this.jobs.enqueue(input)) return false;

      if (transport === "irc") {
        this.irc.ircThreadMessage(
          input.botKey,
          input.channel,
          input.thread,
          root(input),
        );

        if (eligible)
          this.db
            .query(
              "UPDATE jobs SET replyParent=COALESCE(replyParent,thread) WHERE id=? AND status='running'",
            )
            .run(owner.id);

        if (
          invited ||
          this.irc.ircThreadParticipating(
            input.botKey,
            input.channel,
            root(input),
          )
        )
          this.irc.joinIrcThread(input.botKey, input.channel, root(input));
      }

      this.db
        .query(`INSERT INTO thread_followups
        (botKey,eventId,owner,sessionID,inputID,nativeID,state,payload,transport)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          input.botKey,
          input.eventId,
          owner.id,
          sessionID,
          owner.input ?? "",
          `msg_${createHash("sha256").update(`${input.botKey}\0${input.eventId}`).digest("hex")}`,
          eligible ? "pending" : "queued",
          JSON.stringify(input),
          transport,
        );

      return true;
    })();
  }

  public followUps(botKey: string, finalOwner?: number): ThreadFollowUp[] {
    return this.db
      .query<
        ThreadFollowUp,
        [string, number | null, number | null, number, number | null]
      >(
        `SELECT * FROM thread_followups WHERE botKey=? AND (? IS NULL OR owner=?) AND
      (state='pending' OR notified=0 OR
       (state IN ('writing','uncertain') AND ((reconcileAttempts<8 AND retryAt<=?) OR owner=?)))
      ORDER BY rowid LIMIT 32`,
      )
      .all(
        botKey,
        finalOwner ?? null,
        finalOwner ?? null,
        Date.now(),
        finalOwner ?? null,
      );
  }

  public followUpInput(receipt: ThreadFollowUp): Incoming {
    return Schema.decodeUnknownSync(followUpSchema)(
      JSON.parse(receipt.payload),
    );
  }

  public ownsFollowUp(receipt: ThreadFollowUp): boolean {
    const input = this.followUpInput(receipt);
    const owner = this.jobs.jobByInput(receipt.botKey, receipt.inputID);

    const root = (message: Incoming) =>
      receipt.transport === "irc"
        ? (message.replyParent ?? message.thread)
        : message.thread;

    return (
      owner?.id === receipt.owner &&
      owner.status === "running" &&
      owner.conversation === input.conversation &&
      owner.channel === input.channel &&
      root(owner) === root(input) &&
      this.db
        .query("SELECT 1 FROM jobs WHERE id=? AND cancel_requested=0")
        .get(owner.id) !== null
    );
  }

  public claimFollowUp(receipt: ThreadFollowUp): boolean {
    return (
      this.db
        .query(
          "UPDATE thread_followups SET state='writing' WHERE botKey=? AND eventId=? AND state='pending'",
        )
        .run(receipt.botKey, receipt.eventId).changes === 1
    );
  }

  public settleFollowUp(
    receipt: ThreadFollowUp,
    state: "accepted" | "uncertain" | "queued",
  ) {
    this.db.transaction(() => {
      // A definite refusal alone permits normal queue admission. Remove the
      // Receipt temporarily inside this transaction to reuse enqueue's guards.
      if (state === "queued") {
        this.db
          .query("DELETE FROM thread_followups WHERE botKey=? AND eventId=?")
          .run(receipt.botKey, receipt.eventId);
        this.jobs.enqueue(this.followUpInput(receipt));
        this.db
          .query(`INSERT INTO thread_followups
          (botKey,eventId,owner,sessionID,inputID,nativeID,state,notified,payload,transport)
          VALUES (?,?,?,?,?,?,'queued',0,?,?)`)
          .run(
            receipt.botKey,
            receipt.eventId,
            receipt.owner,
            receipt.sessionID,
            receipt.inputID,
            receipt.nativeID,
            receipt.payload,
            receipt.transport,
          );
      } else if (state === "uncertain")
        this.db
          .query(
            "UPDATE thread_followups SET state=?,reconcileAttempts=reconcileAttempts+1,retryAt=? WHERE botKey=? AND eventId=?",
          )
          .run(
            state,
            Date.now() +
              Math.min(60_000, 1000 * 2 ** receipt.reconcileAttempts),
            receipt.botKey,
            receipt.eventId,
          );
      else
        this.db
          .query(
            "UPDATE thread_followups SET state=?,notified=0 WHERE botKey=? AND eventId=?",
          )
          .run(state, receipt.botKey, receipt.eventId);
    })();
  }

  public notifiedFollowUp(receipt: ThreadFollowUp) {
    this.db
      .query(
        "UPDATE thread_followups SET notified=1 WHERE botKey=? AND eventId=?",
      )
      .run(receipt.botKey, receipt.eventId);
  }

  public followUpLinks(owner: number): string {
    return this.db
      .query<{ payload: string; transport: string }, [number]>(
        "SELECT payload,transport FROM thread_followups WHERE owner=? AND state='accepted' ORDER BY rowid LIMIT 20",
      )
      .all(owner)
      .map((row) => {
        const input = Schema.decodeUnknownSync(followUpSchema)(
          JSON.parse(row.payload),
        );

        const message =
          input.slackReaction?.ts ??
          input.eventId.slice(input.channel.length + 1);

        return row.transport === "slack"
          ? `https://slack.com/archives/${input.channel}/p${message.replace(".", "")}`
          : `irc follow-up ${message}`;
      })
      .join("\n");
  }
}
