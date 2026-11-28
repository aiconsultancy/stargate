import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { FleetError, type TimerInput } from "../coordination/fleet/protocol";
import type { Incoming, Job } from "./store-types";

const minuteMs = 60_000;

type Timer = {
  id: string;
  origin: string;
  dueAt: number;
  delayMs: number;
  session: string;
  note: string;
};

/** Timers and the ordinary gateway queue share a transaction. */
export class TeamsTimers {
  public constructor(
    private readonly db: Database,
    private readonly jobs: {
      enqueue(input: Incoming): boolean;
      jobByEvent(botKey: string, eventId: string): Job | null;
      jobByInput(botKey: string, input: string): Job | null;
    },
  ) {
    db.run(`
      CREATE TABLE IF NOT EXISTS teams_timer_origins (
        bot TEXT NOT NULL, event TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(bot,event)
      );
      CREATE TABLE IF NOT EXISTS teams_timers (
        bot TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL,
        dueAt INTEGER NOT NULL, delayMs INTEGER NOT NULL, session TEXT NOT NULL,
        note TEXT NOT NULL, PRIMARY KEY(bot,scope)
      );
      CREATE TABLE IF NOT EXISTS teams_timer_receipts (
        bot TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(bot,id)
      );
    `);
  }

  public admitHuman(input: Incoming, scope: string, now = Date.now()) {
    return this.db
      .transaction(() => {
        if (!this.jobs.enqueue(input)) {
          return false;
        }

        this.db
          .query("INSERT INTO teams_timer_origins VALUES (?,?,?)")
          .run(input.botKey, input.eventId, scope);
        const withdrawn = this.withdrawQueued(input.botKey, scope);
        this.db
          .query(`UPDATE teams_timers SET dueAt=?+delayMs,
          id=COALESCE(?,id) WHERE bot=? AND scope=?`)
          .run(now, withdrawn ? randomUUID() : null, input.botKey, scope);

        return true;
      })
      .immediate();
  }

  private withdrawQueued(bot: string, scope: string) {
    return (
      this.db
        .query(`UPDATE jobs SET status='done',deferDelivery=1
        WHERE botKey=?1 AND status='queued'
        AND eventId=(SELECT 'teams-timer:' || id FROM teams_timers WHERE bot=?1 AND scope=?2)`)
        .run(bot, scope).changes > 0
    );
  }

  public change(
    job: Job,
    pin: string,
    id: string,
    input: TimerInput,
    now = Date.now(),
  ) {
    const bot = job.botKey;

    let origin: string | undefined = job.eventId;

    if (job.fleet?.kind === "timer") {
      origin = job.fleet.originEvent;
    } else if (job.fleet?.kind === "result") {
      origin = this.jobs.jobByInput(bot, job.fleet.originInputID)?.eventId;
    }

    const scope = this.db
      .query<{ scope: string }, [string, string]>(
        "SELECT scope FROM teams_timer_origins WHERE bot=? AND event=?",
      )
      .get(bot, origin ?? "")?.scope;

    if (scope === undefined || origin === undefined) {
      throw new FleetError("A timer needs an admitted Teams conversation.");
    }

    return this.db
      .transaction(() => {
        if (
          input.op !== "status" &&
          this.db
            .query("INSERT OR IGNORE INTO teams_timer_receipts VALUES (?,?)")
            .run(bot, id).changes
        ) {
          this.withdrawQueued(bot, scope);

          if (input.op === "cancel") {
            this.db
              .query("DELETE FROM teams_timers WHERE bot=? AND scope=?")
              .run(bot, scope);
          } else {
            const delay = (input.minutes ?? 30) * minuteMs;
            this.db
              .query(`INSERT INTO teams_timers VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(bot,scope) DO UPDATE SET id=excluded.id,
            origin=excluded.origin,dueAt=excluded.dueAt,delayMs=excluded.delayMs,
            session=excluded.session,note=excluded.note`)
              .run(
                bot,
                scope,
                id,
                origin,
                now + delay,
                delay,
                pin,
                input.note ?? "",
              );
          }
        }

        const timer = this.db
          .query<Timer, [string, string]>(
            "SELECT * FROM teams_timers WHERE bot=? AND scope=?",
          )
          .get(bot, scope);

        return timer
          ? { state: "armed", dueAt: new Date(timer.dueAt).toISOString() }
          : { state: "idle" };
      })
      .immediate();
  }

  public releaseDue(bot: string, pin: string, now = Date.now()) {
    this.db
      .transaction(() => {
        const due = this.db
          .query<Timer & { scope: string }, [string, string, number]>(
            `SELECT t.* FROM teams_timers t LEFT JOIN jobs j
                ON j.botKey=t.bot AND j.eventId='teams-timer:' || t.id
              WHERE t.bot=? AND t.session=? AND t.dueAt<=?
                AND j.status IS NOT 'queued' ORDER BY dueAt LIMIT 16`,
          )
          .all(bot, pin, now);

        for (const timer of due) {
          const original = this.jobs.jobByEvent(bot, timer.origin);

          if (
            original &&
            !this.jobs.jobByEvent(bot, `teams-timer:${timer.id}`)
          ) {
            const { botKey, channel, conversation, thread, user } = original;

            this.jobs.enqueue({
              eventId: `teams-timer:${timer.id}`,
              botKey,
              channel,
              conversation,
              thread,
              user,
              notBefore: timer.dueAt,
              text: [
                "Scheduled Teams follow-up. Check the status of the existing work without repeating the assignment.",
                "If the result is ready, report it here. If work is still underway, give one concise progress update and call stargate_timer to schedule another check if needed.",
                ...(timer.note ? [`Saved reminder: ${timer.note}`] : []),
              ].join("\n"),
              fleet: { kind: "timer", originEvent: timer.origin },
            });
            continue;
          }

          this.db
            .query("DELETE FROM teams_timers WHERE bot=? AND scope=?")
            .run(bot, timer.scope);
        }
      })
      .immediate();
  }
}
