import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { ircBurstMessageSchema } from "./burst";
import type { IrcBurstMessage, IrcOperations } from "./store-contract";

export class IrcRecords implements IrcOperations {
  public constructor(private readonly db: Database) {}

  /**
   * Admitted messages of one sender kind received at or after `since` (ms),
   * in these registrations and in one conversation or channel. IRC only:
   * Slack rows carry no `received` time.
   */
  public turnsSince(input: {
    botKeys: readonly string[];
    sender: "captain" | "crew";
    since: number;
    scope: { conversation: string } | { channel: string };
  }): number {
    if (input.botKeys.length === 0) return 0;
    const keys = input.botKeys.map(() => "?").join(",");

    const [column, value] =
      "conversation" in input.scope
        ? ["conversation", input.scope.conversation]
        : ["channel", input.scope.channel];

    return (
      this.db
        .query<{ n: number }, (string | number)[]>(
          `SELECT COUNT(*) AS n FROM jobs WHERE sender=? AND received>=?
        AND ${column}=? AND botKey IN (${keys})`,
        )
        .get(input.sender, input.since, value, ...input.botKeys)?.n ?? 0
    );
  }

  /** Outbound IRC root of this registration's request; legacy rows stay plain. */
  public ircReplyParent(botKey: string, thread: string): string | undefined {
    return (
      this.db
        .query<
          { replyParent: string | null },
          [string, string, string, string]
        >(
          `SELECT replyParent FROM jobs WHERE botKey=? AND thread=?
           UNION ALL SELECT COALESCE(json_extract(payload,'$.replyParent'),json_extract(payload,'$.thread')) AS replyParent
           FROM thread_followups WHERE botKey=? AND transport='irc' AND json_extract(payload,'$.thread')=? LIMIT 1`,
        )
        .get(botKey, thread, botKey, thread)?.replyParent ?? undefined
    );
  }

  public ircBurst(job: number) {
    return this.db
      .query<{ policy: string; deadline: number; maximum: number }, [number]>(
        "SELECT policy,deadline,maximum FROM irc_bursts WHERE job=?",
      )
      .get(job);
  }

  public startIrcBurst(
    job: number,
    policy: string,
    deadline: number,
    maximum: number,
  ) {
    this.db
      .query(
        "INSERT INTO irc_bursts(job,policy,deadline,maximum) VALUES(?,?,?,?)",
      )
      .run(job, policy, deadline, maximum);
  }

  public extendIrcBurst(job: number, deadline: number) {
    this.db
      .query("UPDATE irc_bursts SET deadline=? WHERE job=?")
      .run(deadline, job);
  }

  /** Original accepted text and source labels, retained across restarts. */
  public ircBurstMessages(job: number): IrcBurstMessage[] {
    return this.db
      .query<{ message: string }, [number]>(
        "SELECT message FROM irc_burst_messages WHERE job=? ORDER BY ordinal",
      )
      .all(job)
      .map(({ message }) =>
        Schema.decodeUnknownSync(ircBurstMessageSchema)(JSON.parse(message)),
      );
  }

  /** Stop can resolve a grouped member without changing ordinary thread state. */
  public ircBurstRequest(
    botKey: string,
    channel: string,
    msgid: string,
  ): string | undefined {
    return this.db
      .query<{ thread: string }, [string, string, string]>(
        `SELECT j.thread FROM irc_burst_messages b JOIN jobs j ON j.id=b.job AND j.botKey=b.botKey
         WHERE b.botKey=? AND b.eventId=? AND j.channel=?`,
      )
      .get(botKey, `${channel}:${msgid}`, channel)?.thread;
  }

  public saveIrcBurstMessage(
    job: number,
    ordinal: number,
    botKey: string,
    message: IrcBurstMessage,
  ) {
    this.db
      .query(
        "INSERT INTO irc_burst_messages(botKey,eventId,job,ordinal,message) VALUES(?,?,?,?,?)",
      )
      .run(botKey, message.eventId, job, ordinal, JSON.stringify(message));
  }

  public ircThreadRoot(
    botKey: string,
    channel: string,
    msgid: string,
  ): string | undefined {
    return this.db
      .query<{ root: string }, [string, string, string]>(
        "SELECT root FROM irc_thread_messages WHERE botKey=? AND channel=? AND msgid=?",
      )
      .get(botKey, channel, msgid)?.root;
  }

  public ircThreadParticipating(
    botKey: string,
    channel: string,
    root: string,
  ): boolean {
    return (
      this.db
        .query(
          "SELECT 1 FROM irc_thread_memberships WHERE botKey=? AND channel=? AND root=?",
        )
        .get(botKey, channel, root) !== null
    );
  }

  /** Exact original request of a locally correlated own echo, never its root. */
  public ircRequestAnchor(botKey: string, channel: string, msgid: string) {
    return (
      this.db
        .query<{ request: string | null }, [string, string, string]>(
          "SELECT request FROM irc_thread_messages WHERE botKey=? AND channel=? AND msgid=?",
        )
        .get(botKey, channel, msgid)?.request ?? undefined
    );
  }

  public ircThreadMessage(
    botKey: string,
    channel: string,
    msgid: string,
    root: string,
    request?: string,
  ) {
    const existing = this.ircThreadRoot(botKey, channel, msgid);

    if (existing !== undefined && existing !== root)
      throw new Error("IRC thread ancestry conflict");
    this.db
      .query(
        "INSERT INTO irc_thread_messages(botKey,channel,msgid,root,recorded,request) VALUES (?,?,?,?,?,?) ON CONFLICT(botKey,channel,msgid) DO UPDATE SET recorded=excluded.recorded,request=COALESCE(irc_thread_messages.request,excluded.request)",
      )
      .run(botKey, channel, msgid, root, Date.now(), request ?? null);
  }

  public joinIrcThread(botKey: string, channel: string, root: string) {
    this.db
      .query(
        "INSERT INTO irc_thread_memberships(botKey,channel,root,recorded) VALUES (?,?,?,?) ON CONFLICT(botKey,channel,root) DO UPDATE SET recorded=excluded.recorded",
      )
      .run(botKey, channel, root, Date.now());
  }

  /**
   * Newest IRC server time seen in one target (folded channel, or "" for
   * direct messages) of one registration: CHATHISTORY catch-up resumes
   * after it.
   */
  public ircCursor(botKey: string, target: string): string | undefined {
    return (
      this.db
        .query<{ time: string }, [string, string]>(
          "SELECT time FROM irc_cursors WHERE botKey=? AND target=?",
        )
        .get(botKey, target)?.time ?? undefined
    );
  }

  /** Moves forward only, unless `replace` (operator repair and tests). */
  public saveIrcCursor(
    botKey: string,
    target: string,
    time: string,
    replace = false,
  ) {
    this.db
      .query(`INSERT INTO irc_cursors (botKey,target,time) VALUES (?,?,?)
      ON CONFLICT(botKey,target) DO UPDATE SET time=excluded.time
      WHERE ? OR excluded.time > irc_cursors.time`)
      .run(botKey, target, time, replace ? 1 : 0);
  }

  /**
   * A stargate_dm receipt ID that this process copies to IRC: recorded before
   * the IRC copy is sent, so the recipient connection recognises it and
   * never admits it as a second turn. Kept 7 days.
   */
  public markStargateDmCopy(id: string, now = Date.now()) {
    this.db.transaction(() => {
      this.db
        .query("INSERT OR IGNORE INTO irc_stargate_dm VALUES (?,?)")
        .run(id, now);
      this.db
        .query("DELETE FROM irc_stargate_dm WHERE sent<?")
        .run(now - 7 * 24 * 60 * 60_000);
    })();
  }

  public stargateDmCopy(id: string) {
    return (
      this.db.query("SELECT 1 FROM irc_stargate_dm WHERE id=?").get(id) !== null
    );
  }

  /** Last crew-plugin outbox sequence handled for one ship (its captain). */
  public stargateDmCursor(botKey: string): number | undefined {
    return (
      this.db
        .query<{ sequence: number }, [string]>(
          "SELECT sequence FROM irc_stargate_dm_cursor WHERE botKey=?",
        )
        .get(botKey)?.sequence ?? undefined
    );
  }

  public saveStargateDmCursor(botKey: string, sequence: number) {
    this.db
      .query(`INSERT INTO irc_stargate_dm_cursor VALUES (?,?)
      ON CONFLICT(botKey) DO UPDATE SET sequence=excluded.sequence`)
      .run(botKey, sequence);
  }
}
