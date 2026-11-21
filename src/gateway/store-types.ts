import type { FleetJob, NativeMaker } from "../fleet/protocol";
import type { NotificationContext } from "../notifications";
import type { InboundReaction } from "../reactions";
import type { RequestFailure } from "../request-failure";

export type Incoming = {
  eventId: string;
  botKey: string;
  conversation: string;
  channel: string;
  thread: string;
  /** IRC thread root; null/absent means an ordinary main-channel request. */
  replyParent?: string | null;
  user: string;
  text: string;
  files?: readonly string[];
  deferDelivery?: boolean;
  /**
   * `captain`: a verified peer captain bot. `crew`: this ship's own captain
   * or crew account on IRC. Absent for people.
   */
  sender?: "captain" | "crew" | null;
  /** Transport time of the message in ms, for rolling turn limits (IRC). */
  received?: number | null;
  /**
   * `spoken`: held until its speech names the bot; it neither starts nor
   * continues a conversation yet. `admitted`: its speech named the bot.
   */
  gate?: "spoken" | "admitted" | null;
  /** The configured name that admitted a message without a mention. */
  textMention?: string | null;
  /** Earliest start in ms (IRC all-call turns); absent starts at once. */
  notBefore?: number | null;
  /** Only trusted gateway intake/result recovery supplies this correlation. */
  fleet?: FleetJob;
  /** Trusted Slack ingress classification; absent on legacy/scheduled/native jobs. */
  notification?: NotificationContext;
  /** Present only for a verified Slack reaction, not a Slack message. */
  slackReaction?: InboundReaction;
};

/**
 * Job lifecycle. Each method below is one transition and its SQL guard is
 * the check: a transition from any other status writes nothing.
 *
 * - queued → running: `running` (not after an accepted Stop).
 * - queued → responding: an accepted Stop (`cancel`, `cancelTurn`).
 * - running → responding: `respond` (throws `JobTransitionRefused` from
 *   another status), or `recover` after a restart.
 * - responding → done or failed: `finish`, after delivery or its last retry.
 * - failed → responding: `appendTranscript` requeues a `transcript:*` row.
 * - queued → failed: `finish`, when access was removed before the turn.
 *
 * While responding, `sent` moves the delivery cursor forward and `retry`
 * delays the next attempt. `finish`, `sent` and `retry` return false when
 * the status refused them.
 *
 * A row with `deferDelivery` has no delivery: it goes to `done` at once.
 */
export const jobStatuses = [
  "queued",
  "running",
  "responding",
  "done",
  "failed",
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export type Job = Incoming & {
  id: number;
  status: JobStatus;
  response: string | null;
  sent: number;
  attempts: number;
  failure?: RequestFailure | null;
  input?: string | null;
  makers?: NativeMaker[];
};
