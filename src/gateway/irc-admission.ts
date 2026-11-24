import type { Database } from "bun:sqlite";
import {
  combineIrcBurstMessages,
  ircBurstEligible,
  ircBurstLimits,
  prepareIrcBurstMessage,
} from "../transports/irc/burst";
import { validMsgid } from "../transports/irc/protocol";
import type { IrcOperations } from "../transports/irc/store-contract";
import type { StoredJob } from "./row-codec";
import type { Incoming, Job } from "./store-types";

/** Job persistence the IRC admission flow reuses inside its transactions. */
export interface AdmissionJobOperations {
  enqueue(input: Incoming): boolean;
  jobByEvent(botKey: string, eventId: string): Job | null;
}

/**
 * IRC intake and own-echo correlation over the shared gateway job tables.
 * IRC-table access goes through the `IrcOperations` port only.
 */
export class IrcAdmission {
  public constructor(
    private readonly db: Database,
    private readonly jobs: AdmissionJobOperations,
    private readonly irc: IrcOperations,
  ) {}

  /** New opt-in human intake: persist ancestry and explicit invitation atomically. */
  public enqueueIrcHuman(input: Incoming, invited: boolean): boolean {
    const root = input.replyParent ?? input.thread;

    if (!validMsgid(input.thread) || !validMsgid(root)) {
      throw new Error("IRC human thread identity is invalid");
    }

    return this.db.transaction(() => {
      if (!this.jobs.enqueue(input)) {
        return false;
      }

      this.irc.ircThreadMessage(
        input.botKey,
        input.channel,
        input.thread,
        root,
      );

      if (
        invited ||
        this.irc.ircThreadParticipating(input.botKey, input.channel, root)
      ) {
        this.irc.joinIrcThread(input.botKey, input.channel, root);
      }

      return true;
    })();
  }

  /**
   * Coalesce only consecutively admitted human messages before work starts.
   * Original sources remain durable; event aliases never invent a native input.
   * Host receive time owns the deadline, not sender-controlled server-time tags.
   */
  public enqueueIrcBurst(
    input: Incoming,
    options: {
      quietMs: number;
      policy: string;
      source: string;
      originalText: string;
      invited: boolean;
      /** Preserve the preexisting humanWakeChannels-only intake bookkeeping. */
      trackThreads: boolean;
      now?: number;
    },
  ): boolean {
    const ordinary = (job: Incoming) =>
      options.trackThreads
        ? this.enqueueIrcHuman(job, options.invited)
        : this.jobs.enqueue(job);

    if (
      !Number.isInteger(options.quietMs) ||
      options.quietMs < 1 ||
      options.quietMs > 5000 ||
      !ircBurstEligible(input)
    ) {
      return ordinary(input);
    }

    const now = options.now ?? Date.now();

    const message = prepareIrcBurstMessage(
      input,
      options.source,
      options.originalText,
      now,
    );

    if (!message) {
      return ordinary(input);
    }

    return this.db.transaction(() => {
      if (
        this.jobs.jobByEvent(input.botKey, input.eventId) ||
        this.db
          .query(`SELECT 1 FROM ignored_events WHERE botKey=? AND eventId=?
            UNION ALL SELECT 1 FROM thread_followups WHERE botKey=? AND eventId=? LIMIT 1`)
          .get(input.botKey, input.eventId, input.botKey, input.eventId) !==
          null
      ) {
        return false;
      }

      const latest = this.db
        .query<StoredJob, [string]>(
          `SELECT * FROM jobs WHERE botKey=? AND text!=''
           AND COALESCE(json_extract(fleet_context,'$.kind'),'')!='result'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(input.botKey);

      const burst = latest ? this.irc.ircBurst(latest.id) : null;

      if (
        latest &&
        burst &&
        latest.status === "queued" &&
        !latest.input &&
        latest.user === input.user &&
        latest.channel === input.channel &&
        latest.conversation === input.conversation &&
        (latest.replyParent === latest.thread
          ? null
          : (latest.replyParent ?? null)) ===
          (input.replyParent === input.thread
            ? null
            : (input.replyParent ?? null)) &&
        (latest.textMention ?? null) === (input.textMention ?? null) &&
        burst.policy === options.policy &&
        now < burst.deadline &&
        now < burst.maximum
      ) {
        const messages = this.irc.ircBurstMessages(latest.id);
        const combined = combineIrcBurstMessages(messages, message);

        if (combined) {
          const { files, text } = combined;
          const deadline = Math.min(now + options.quietMs, burst.maximum);

          const changed = this.db
            .query(
              `UPDATE jobs SET text=?,input_files=?,retry_at=MAX(retry_at,?)
               WHERE id=? AND status='queued' AND input IS NULL AND cancel_requested=0`,
            )
            .run(
              text,
              files.length > 0 ? JSON.stringify(files) : null,
              Math.max(deadline, input.notBefore ?? 0),
              latest.id,
            ).changes;

          if (changed) {
            this.irc.extendIrcBurst(latest.id, deadline);
            this.irc.saveIrcBurstMessage(
              latest.id,
              messages.length,
              input.botKey,
              message,
              input.ircRequestChannel,
            );

            if (options.trackThreads) {
              const root = latest.replyParent ?? latest.thread;
              this.irc.ircThreadMessage(
                input.botKey,
                input.channel,
                input.thread,
                root,
                latest.thread,
              );

              if (options.invited) {
                this.irc.joinIrcThread(input.botKey, input.channel, root);
              }
            }

            return true;
          }
        }
      }

      const deadline = now + options.quietMs;

      if (
        !ordinary({
          ...input,
          notBefore: Math.max(deadline, input.notBefore ?? 0),
        })
      ) {
        return false;
      }

      const job = this.jobs.jobByEvent(input.botKey, input.eventId);

      if (!job) {
        throw new Error("IRC burst job was not persisted");
      }

      this.irc.startIrcBurst(
        job.id,
        options.policy,
        deadline,
        now + ircBurstLimits.waitMs,
      );
      this.irc.saveIrcBurstMessage(
        job.id,
        0,
        input.botKey,
        message,
        input.ircRequestChannel,
      );

      return true;
    })();
  }

  /** Called only for an exact locally-correlated, SASL-account-confirmed own echo. */
  public ircPublished(
    botKey: string,
    channel: string,
    msgid: string,
    request: string,
    wireRoot?: string,
  ) {
    if (
      !validMsgid(msgid) ||
      !validMsgid(request) ||
      (wireRoot !== undefined && !validMsgid(wireRoot))
    ) {
      return false;
    }

    return this.db.transaction(() => {
      const job = this.db
        .query<
          { thread: string; replyParent: string | null },
          [string, string, string]
        >(
          "SELECT thread,replyParent FROM jobs WHERE botKey=? AND channel=? AND thread=? ORDER BY id LIMIT 1",
        )
        .get(botKey, channel, request);

      if (!job) {
        return false;
      }

      const root = job.replyParent ?? job.thread;

      if (!validMsgid(root) || (wireRoot !== undefined && wireRoot !== root)) {
        return false;
      }

      const prior = this.irc.ircRequestAnchor(botKey, channel, msgid);

      if (prior !== undefined && prior !== request) {
        return false;
      }

      this.irc.ircThreadMessage(botKey, channel, msgid, root, request);
      this.irc.joinIrcThread(botKey, channel, root);

      return true;
    })();
  }

  /** Thirty days of settled history. Active native work and recovery holds survive. */
  public pruneIrcHistory(botKey: string, now: number) {
    const cutoff = now - 30 * 86_400_000;
    this.db.transaction(() => {
      this.db
        .query(`DELETE FROM native_questions WHERE rowid IN (SELECT rowid FROM native_questions WHERE botKey=? AND recorded<? AND recovering=0
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=native_questions.jobID AND j.status NOT IN ('done','failed')) ORDER BY recorded LIMIT 256)`)
        .run(botKey, cutoff);
      this.db
        .query(`DELETE FROM irc_question_sources WHERE rowid IN (SELECT rowid FROM irc_question_sources WHERE botKey=? AND recorded<?
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.botKey=irc_question_sources.botKey AND j.eventId=irc_question_sources.eventId AND j.status NOT IN ('done','failed'))
        AND NOT EXISTS(SELECT 1 FROM native_questions q WHERE q.botKey=irc_question_sources.botKey AND q.jobID IN (SELECT id FROM jobs WHERE botKey=irc_question_sources.botKey AND eventId=irc_question_sources.eventId)) ORDER BY recorded LIMIT 256)`)
        .run(botKey, cutoff);

      for (const table of ["irc_thread_messages", "irc_thread_memberships"]) {
        this.db
          .query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE botKey=? AND recorded<?
          AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.botKey=${table}.botKey AND j.channel=${table}.channel AND CAST(COALESCE(j.replyParent,j.thread) AS TEXT)=${table}.root AND j.status NOT IN ('done','failed'))
          AND NOT EXISTS(SELECT 1 FROM irc_thread_memberships m WHERE m.botKey=${table}.botKey AND m.channel=${table}.channel AND m.root=${table}.root AND m.recorded>=?)
          AND NOT EXISTS(SELECT 1 FROM native_questions q JOIN jobs j ON j.id=q.jobID WHERE q.botKey=${table}.botKey AND j.channel=${table}.channel AND CAST(COALESCE(j.replyParent,j.thread) AS TEXT)=${table}.root) ORDER BY recorded LIMIT 256)`)
          .run(botKey, cutoff, cutoff);
      }
    })();
  }
}
