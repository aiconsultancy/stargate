import type { Database } from "bun:sqlite";
import type { NativeQuestion, QuestionOffer } from "./questions";

export class QuestionRecords {
  public constructor(private readonly db: Database) {}

  public recordQuestionSource(input: {
    botKey: string;
    eventId: string;
    user: string;
    channel: string;
    thread: string;
    replyParent?: string | null;
  }) {
    this.db
      .query(
        "INSERT OR IGNORE INTO irc_question_sources(botKey,eventId,user,channel,thread,root,recorded) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        input.botKey,
        input.eventId,
        input.user,
        input.channel,
        input.thread,
        input.replyParent ?? input.thread,
        Date.now(),
      );
  }

  public ownsQuestionSource(job: {
    botKey: string;
    eventId: string;
    user: string;
    channel: string;
    thread: string;
    replyParent?: string | null;
    id: number;
  }): boolean {
    return (
      this.recordedQuestionSource(job) &&
      this.db
        .query(
          "SELECT 1 FROM jobs WHERE id=? AND cancel_requested=0 AND failure IS NOT 'cancelled'",
        )
        .get(job.id) !== null
    );
  }

  /** Historical source evidence only, never current permission to reply. */
  public recordedQuestionSource(job: {
    botKey: string;
    eventId: string;
    user: string;
    channel: string;
    thread: string;
    replyParent?: string | null;
  }): boolean {
    return (
      this.db
        .query(
          "SELECT 1 FROM irc_question_sources WHERE botKey=? AND eventId=? AND user=? AND channel=? AND thread=? AND root=?",
        )
        .get(
          job.botKey,
          job.eventId,
          job.user,
          job.channel,
          job.thread,
          job.replyParent ?? job.thread,
        ) !== null
    );
  }

  public questionByToken(
    botKey: string,
    token: string,
  ): QuestionOffer | undefined {
    return (
      this.db
        .query<QuestionOffer, [string, string]>(
          "SELECT * FROM native_questions WHERE botKey=? AND token=?",
        )
        .get(botKey, token) ?? undefined
    );
  }

  public questionOffers(
    botKey: string,
    includeRunningOutcomes = false,
  ): QuestionOffer[] {
    return this.db
      .query<QuestionOffer, [string, number]>(
        "SELECT * FROM native_questions WHERE botKey=? AND (state!='closed' OR recovering=1 OR (outcome IS NOT NULL AND (outcomeNotified=0 OR (?=1 AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=native_questions.jobID AND j.status='running'))))) ORDER BY rowid",
      )
      .all(botKey, includeRunningOutcomes ? 1 : 0);
  }

  public activeQuestionSessions(botKey: string, pinned?: string): string[] {
    const sessions = this.db
      .query<{ session_id: string }, [string]>(
        "SELECT DISTINCT s.session_id FROM sessions s JOIN jobs j ON j.conversation=s.conversation JOIN irc_question_sources q ON q.botKey=j.botKey AND q.eventId=j.eventId WHERE j.botKey=? AND j.status='running' AND j.cancel_requested=0 AND j.failure IS NOT 'cancelled' AND j.input IS NOT NULL",
      )
      .all(botKey)
      .map((v) => v.session_id);

    if (
      pinned &&
      this.db
        .query(
          "SELECT 1 FROM jobs j JOIN irc_question_sources q ON q.botKey=j.botKey AND q.eventId=j.eventId WHERE j.botKey=? AND j.status='running' AND j.cancel_requested=0 AND j.failure IS NOT 'cancelled' AND j.input IS NOT NULL LIMIT 1",
        )
        .get(botKey)
    )
      sessions.push(pinned);

    return [...new Set(sessions)];
  }

  public renewQuestion(
    token: string,
    replacement: string,
    now: number,
  ): QuestionOffer | undefined {
    const row = this.questionByTokenForRenewal(token);

    if (!row) return;

    const changed = this.db
      .query(
        "UPDATE native_questions SET token=?,expires=?,notified=0,publicationStarted=0,recorded=? WHERE token=? AND state='offered' AND expires<=?",
      )
      .run(replacement, now + 1_800_000, now, token, now).changes;

    return changed === 1
      ? this.questionByToken(row.botKey, replacement)
      : undefined;
  }

  private questionByTokenForRenewal(token: string): QuestionOffer | undefined {
    return (
      this.db
        .query<QuestionOffer, [string]>(
          "SELECT * FROM native_questions WHERE token=?",
        )
        .get(token) ?? undefined
    );
  }

  public questionOutcome(
    token: string,
    outcome: NonNullable<QuestionOffer["outcome"]>,
  ) {
    this.db
      .query(
        "UPDATE native_questions SET outcome=? WHERE token=? AND state='attempted' AND outcome IS NULL",
      )
      .run(outcome, token);
  }

  public questionOutcomeNotified(token: string) {
    this.db
      .query(
        "UPDATE native_questions SET outcomeNotified=1 WHERE token=? AND outcome IS NOT NULL",
      )
      .run(token);
  }

  public questionSourceCancelled(offer: QuestionOffer): boolean {
    return (
      this.db
        .query(
          "SELECT 1 FROM jobs WHERE id=? AND botKey=? AND input=? AND (cancel_requested=1 OR failure='cancelled')",
        )
        .get(offer.jobID, offer.botKey, offer.inputID) !== null
    );
  }

  public retireQuestion(token: string) {
    this.db
      .query(
        "UPDATE native_questions SET state='closed',outcomeNotified=1 WHERE token=? AND recovering=0",
      )
      .run(token);
  }

  public saveSlackQuestion(
    token: string,
    ts: string,
    question: NativeQuestion,
  ) {
    this.db
      .query(
        "INSERT OR IGNORE INTO slack_questions(token,ts,question) VALUES(?,?,?)",
      )
      .run(token, ts, JSON.stringify(question));
  }

  public slackQuestion(
    token: string,
  ):
    | { ts: string; question: string; progress: string; revision: number }
    | undefined {
    return (
      this.db
        .query<
          { ts: string; question: string; progress: string; revision: number },
          [string]
        >(
          "SELECT ts,question,progress,revision FROM slack_questions WHERE token=?",
        )
        .get(token) ?? undefined
    );
  }

  public advanceSlackQuestion(
    token: string,
    revision: number,
    progress: string,
  ): boolean {
    return (
      this.db
        .query(
          "UPDATE slack_questions SET progress=?,revision=revision+1 WHERE token=? AND revision=? AND EXISTS(SELECT 1 FROM native_questions WHERE token=slack_questions.token AND state='offered' AND expires>?)",
        )
        .run(progress, token, revision, Date.now()).changes === 1
    );
  }

  public claimExpiredQuestion(token: string, now: number): boolean {
    return (
      this.db
        .query(
          "UPDATE native_questions SET state='attempted' WHERE token=? AND state='offered' AND expires<=?",
        )
        .run(token, now).changes === 1
    );
  }

  public startQuestionPublication(
    botKey: string,
    token: string,
    timeoutMs = 1_800_000,
  ) {
    const now = Date.now();
    this.db
      .query(
        "UPDATE native_questions SET publicationStarted=?,expires=? WHERE botKey=? AND token=? AND state='offered' AND notified=0 AND publicationStarted=0",
      )
      .run(now, now + timeoutMs, botKey, token);
    const offer = this.questionByToken(botKey, token);

    return offer?.state === "offered" && !offer.notified && offer.expires > now
      ? offer
      : undefined;
  }

  public questionNotified(token: string) {
    this.db
      .query(
        "UPDATE native_questions SET notified=1 WHERE token=? AND state='offered'",
      )
      .run(token);
  }

  public questionRecovering(token: string) {
    this.db
      .query(
        "UPDATE native_questions SET recovering=1 WHERE token=? AND (state!='closed' OR outcome IS NOT NULL)",
      )
      .run(token);
  }

  public claimQuestionStop(offer: QuestionOffer): boolean {
    return (
      this.db
        .query(
          "UPDATE jobs SET question_stop_attempted=1 WHERE id=? AND botKey=? AND input=? AND status='running' AND cancel_requested=1 AND question_stop_attempted=0",
        )
        .run(offer.jobID, offer.botKey, offer.inputID).changes === 1
    );
  }

  public closeQuestion(token: string) {
    this.db
      .query("UPDATE native_questions SET state='closed' WHERE token=?")
      .run(token);
  }

  public attemptQuestion(token: string, now: number): boolean {
    return (
      this.db
        .query(
          "UPDATE native_questions SET state='attempted' WHERE token=? AND state='offered' AND expires>?",
        )
        .run(token, now).changes === 1
    );
  }
}
