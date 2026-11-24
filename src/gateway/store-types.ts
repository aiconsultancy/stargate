import type { FleetJob, NativeMaker } from "../coordination/fleet/protocol";
import type { NotificationContext } from "../notifications/preferences/notifications";
import type { InboundReaction } from "../shared/reactions";
import type { RequestFailure } from "../shared/request-failure";
import type { JobStatus } from "./job-status";

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
