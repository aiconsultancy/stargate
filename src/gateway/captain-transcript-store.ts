import type { Database } from "bun:sqlite";
import type { PublishedFile } from "../attachments/attachments";
import type { ReplyChunk } from "../shared/slack-format";

const pendingCaptainJobs = "'queued','running'";

/** Status of a stored reply: a deferred source needs no delivery. */
const storedReplyStatus =
  "CASE WHEN deferDelivery=1 THEN 'done' ELSE 'responding' END";

export type CaptainCursor = {
  cursor: string | undefined;
  owner: number | null;
};

export type CaptainTranscript = {
  botKey: string;
  sessionID: string;
  from: CaptainCursor;
  cursor: string;
  owner: number | null;
  replies: {
    job: number;
    eventId: string;
    chunks: ReplyChunk[];
    files?: PublishedFile[];
  }[];
};

/** Another writer moved the transcript cursor or its outbox rows. */
export class TranscriptConflict extends Error {
  public constructor() {
    super("Transcript cursor or delivery rows changed");
  }
}

/** Captain cursor and outbox records sharing the gateway SQLite database. */
export class CaptainTranscriptRecords {
  public constructor(private readonly db: Database) {}

  /** Anchor an unbaselined captain cursor inside the caller's input transaction. */
  public anchorInput(
    botKey: string,
    sessionID: string,
    input: string,
    owner: number,
  ) {
    // Failed initial baselines still have a durable, owned lower bound.
    this.db
      .query(`UPDATE captain_cursors SET cursor=?,owner=?
        WHERE botKey=? AND session_id=? AND cursor IS NULL`)
      .run(input, owner, botKey, sessionID);
  }

  /** One cursor per pin. Old thread mappings and all outbox rows stay intact. */
  public captainCursor(botKey: string, sessionID: string): CaptainCursor {
    return this.db.transaction(() => {
      const legacy = this.db
        .query<
          { cursor: string | null; owner: number },
          [string, string]
        >(`SELECT s.cursor,j.id AS owner FROM sessions s
        JOIN jobs j ON j.conversation=s.conversation
        WHERE j.botKey=? AND s.session_id=? AND j.started=1 AND j.failure IS NOT 'context'
        ORDER BY j.id DESC LIMIT 1`)
        .get(botKey, sessionID);

      this.db
        .query(`INSERT OR IGNORE INTO captain_cursors
        (botKey,session_id,cursor,owner) VALUES (?,?,?,?)`)
        .run(botKey, sessionID, legacy?.cursor ?? null, legacy?.owner ?? null);

      const row = this.db
        .query<
          { cursor: string | null; owner: number | null },
          [string, string]
        >(
          "SELECT cursor,owner FROM captain_cursors WHERE botKey=? AND session_id=?",
        )
        .get(botKey, sessionID);

      if (!row) throw new Error("Captain cursor not found");

      return { cursor: row.cursor ?? undefined, owner: row.owner };
    })();
  }

  public captainBusy(botKey: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM jobs WHERE botKey=?
      AND status IN (${pendingCaptainJobs}) LIMIT 1`)
        .get(botKey) !== null
    );
  }

  public baselineCaptain(
    botKey: string,
    sessionID: string,
    cursor: string,
  ): CaptainCursor {
    this.db
      .query(`UPDATE captain_cursors SET cursor=?
      WHERE botKey=? AND session_id=? AND cursor IS NULL`)
      .run(cursor, botKey, sessionID);

    return this.captainCursor(botKey, sessionID);
  }

  /** Atomic shared cursor and source-provenanced delivery; never broadcasts. */
  public commitCaptain(input: CaptainTranscript) {
    if (
      this.db
        .query(`UPDATE captain_cursors SET cursor=?,owner=?
      WHERE botKey=? AND session_id=? AND cursor IS ? AND owner IS ?`)
        .run(
          input.cursor,
          input.owner,
          input.botKey,
          input.sessionID,
          input.from.cursor ?? null,
          input.from.owner,
        ).changes !== 1
    )
      throw new TranscriptConflict();

    // Native ownership selects both source and delivery mode. Digest catch-ups
    // Commit as locally delivered rows, never as pending Slack work.
    for (const reply of input.replies) {
      if (
        this.db
          .query(`INSERT OR IGNORE INTO jobs
        (eventId,botKey,conversation,channel,thread,replyParent,user,text,status,response,output_files,deferDelivery,sent)
        SELECT ?,botKey,conversation,channel,thread,replyParent,user,'',
        ${storedReplyStatus},?,?,deferDelivery,
        CASE WHEN deferDelivery=1 THEN ? ELSE 0 END
        FROM jobs WHERE botKey=? AND id=?`)
          .run(
            reply.eventId,
            JSON.stringify(reply.chunks),
            reply.files?.length ? JSON.stringify(reply.files) : null,
            reply.chunks.length,
            input.botKey,
            reply.job,
          ).changes !== 1
      )
        throw new TranscriptConflict();
    }
  }

  public appendCaptainTranscript(input: CaptainTranscript): boolean {
    return this.db.transaction(() => {
      if (this.captainBusy(input.botKey)) return false;
      this.commitCaptain(input);

      return true;
    })();
  }
}
