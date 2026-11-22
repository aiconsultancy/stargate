import type { Database } from "bun:sqlite";
import type { ReplyChunk } from "../shared/slack-format";
import type { JobStatus } from "./store-types";

export class TranscriptRecords {
  constructor(private readonly db: Database) {}

  transcriptCursor(conversation: string): string | undefined {
    return (
      this.db
        .query<{ cursor: string | null }, [string]>(
          "SELECT cursor FROM sessions WHERE conversation=?",
        )
        .get(conversation)?.cursor ?? undefined
    );
  }

  /** Seed a missing cursor without moving an existing one. */
  baselineTranscript(conversation: string, cursor: string) {
    this.db
      .query(
        "UPDATE sessions SET cursor=? WHERE conversation=? AND cursor IS NULL",
      )
      .run(cursor, conversation);

    return this.transcriptCursor(conversation);
  }

  /** Every mapped conversation of this bot namespace, or one session's. */
  transcripts(botKey: string, session?: string): string[] {
    // Separate statements keep the session_id index usable for settle events.
    return this.db
      .query<{ conversation: string }, string[]>(
        `SELECT s.conversation FROM sessions s
      WHERE ${session === undefined ? "" : "s.session_id=? AND"} EXISTS
      (SELECT 1 FROM jobs j WHERE j.conversation=s.conversation AND j.botKey=?)`,
      )
      .all(...(session === undefined ? [] : [session]), botKey)
      .map((row) => row.conversation);
  }

  /** The mapped session plus the latest request's source and delivery mode. */
  transcriptTarget(botKey: string, conversation: string) {
    const row = this.db
      .query<
        {
          session: string;
          cursor: string | null;
          channel: string;
          thread: string;
          replyParent: string | null;
          user: string;
          deferDelivery: number;
        },
        [string, string]
      >(`SELECT s.session_id AS session, s.cursor, j.channel, j.thread, j.replyParent, j.user,j.deferDelivery
      FROM sessions s JOIN jobs j ON j.conversation=s.conversation
      WHERE j.botKey=? AND s.conversation=? AND (j.gate IS NULL OR j.gate='admitted') AND j.failure IS NOT 'muted'
      ORDER BY j.id DESC LIMIT 1`)
      .get(botKey, conversation);

    return (
      row && {
        ...row,
        cursor: row.cursor ?? undefined,
        deferDelivery: row.deferDelivery === 1,
      }
    );
  }

  /** Bot keys with requests in one Slack thread, for targeted repair. */
  threadBots(channel: string, thread: string): string[] {
    return this.db
      .query<{ botKey: string }, [string, string]>(
        "SELECT DISTINCT botKey FROM jobs WHERE channel=? AND thread=?",
      )
      .all(channel, thread)
      .map((row) => row.botKey);
  }

  /** Persisted reply chunks, including replies that are still delivering. */
  replies(botKey: string, conversation: string): ReplyChunk[][] {
    return this.db
      .query<{ response: string }, [string, string]>(`SELECT response FROM jobs
      WHERE botKey=? AND conversation=? AND response IS NOT NULL
      AND status IN ('responding','done') ORDER BY id`)
      .all(botKey, conversation)
      .map((row) => JSON.parse(row.response) as ReplyChunk[]);
  }

  /** This thread's `transcript:*` outbox rows, for targeted repair. */
  transcriptRows(botKey: string, conversation: string) {
    return this.db
      .query<
        { eventId: string; status: JobStatus; response: string | null },
        [string, string]
      >(`SELECT eventId, status, response FROM jobs WHERE botKey=?
      AND conversation=? AND eventId LIKE 'transcript:%' ORDER BY id`)
      .all(botKey, conversation)
      .map((row) => ({
        ...row,
        response: JSON.parse(row.response ?? "[]") as ReplyChunk[],
      }));
  }

  interruptedSessions(botKey: string): string[] {
    return this.db
      .query<
        { session_id: string },
        [string]
      >(`SELECT DISTINCT s.session_id FROM sessions s
      JOIN jobs j ON j.conversation=s.conversation WHERE j.botKey=? AND j.status='running'`)
      .all(botKey)
      .map((row) => row.session_id);
  }

  /** Native sessions this bot namespace has used, most recently used first. */
  sessionIDs(botKey: string, limit: number): string[] {
    return this.db
      .query<
        { session_id: string },
        [string, number]
      >(`SELECT s.session_id FROM sessions s
      JOIN jobs j ON j.conversation=s.conversation WHERE j.botKey=?
      GROUP BY s.session_id ORDER BY MAX(j.id) DESC LIMIT ?`)
      .all(botKey, limit)
      .map((row) => row.session_id);
  }

  /** True only when this bot namespace has a request mapped to the session. */
  ownsSession(botKey: string, sessionID: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM sessions s
      JOIN jobs j ON j.conversation=s.conversation
      WHERE s.session_id=? AND j.botKey=? LIMIT 1`)
        .get(sessionID, botKey) !== null
    );
  }
}
