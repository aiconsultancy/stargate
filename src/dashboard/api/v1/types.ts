/**
 * Fleet API v1: the read-only contract the Subspace Fleet Bridge web Space
 * reads. Additive changes only; never remove or retype a field.
 *
 * Times are epoch milliseconds. Byte counts are integers. Text that came from
 * crew or model output is bounded and redacted exactly as the dashboard's
 * crew status already is; prompt and reply text never appear.
 *
 * Routes (all GET, bearer token, private networks only, `Cache-Control:
 * no-store`):
 *   /api/v1/fleet                       -> V1Fleet
 *   /api/v1/ships/{id}                  -> V1ShipDetail
 *   /api/v1/ships/{id}/crew/{member}    -> V1CrewDetail
 *   /api/v1/events                      -> text/event-stream of V1Event
 */
import type { JobStatus } from "../../../gateway/store";
import type { TurnStage } from "../../../shared/turn-progress";
import type { RequestFailure } from "../../../shared/request-failure";

export const API_V1_VERSION = 1 as const;

export type V1QueueCounts = Record<JobStatus, number>;

export type V1TaskStatus =
  | "queued"
  | "cancelled"
  | "dispatching"
  | "running"
  | "completed"
  | "cancelling"
  | "uncertain"
  | "abandoned";

/**
 * One derived state per member or context, for the map:
 * running: a current task is dispatching, running or cancelling;
 * uncertain: the current or last task is uncertain with no later outcome;
 * queued: no current task but queued work exists;
 * idle: none of the above, provisioned;
 * unprovisioned: no worker session exists yet.
 */
export type V1Activity =
  | "running"
  | "queued"
  | "idle"
  | "uncertain"
  | "unprovisioned";

export type V1Task = {
  id: string;
  status: V1TaskStatus;
  kind: "assignment" | "report" | "unknown";
  /** At most 180 characters. */
  summary: string;
  /** At most 80 characters. */
  phase: string;
  /** At most 400 characters. */
  progress: string;
  createdAt: number | null;
  startedAt: number | null;
  updatedAt: number | null;
  finishedAt: number | null;
};

/** Git state of one crew checkout, read on the fleet VM and cached briefly. */
export type V1Git = {
  /** Null on a detached HEAD. */
  branch: string | null;
  /** Abbreviated commit of HEAD. */
  head: string | null;
  /** The upstream or default branch compared against, such as `origin/main`. */
  base: string | null;
  ahead: number | null;
  behind: number | null;
  /** Count of changed, added, deleted and untracked paths. */
  changedFiles: number | null;
  /** `owner/name` parsed from the `origin` remote, when it is a GitHub URL. */
  repository: string | null;
  /** @deprecated Legacy optional field. */
  pushRepository?: string | null;
  /** @deprecated Legacy optional field. */
  pushRepositoryAmbiguous?: true;
  checkedAt: number;
  /** A safe reason when the read failed; other fields are then null. */
  error?: string;
};

export type V1PullRequest = {
  number: number;
  url: string;
  title: string;
  state: "draft" | "open" | "merged" | "closed";
  checks: "passing" | "running" | "failing" | "none";
};

export type V1CrewContext = {
  /** Configured project key; null for the default project. */
  project: string | null;
  activity: V1Activity;
  provisioned: "unprovisioned" | "pending" | "ready";
  /** True when the worker reports the current task in flight. */
  observed: boolean;
  current: V1Task | null;
  queuedCount: number;
  /** At most five. */
  queued: V1Task[];
  lastOutcome: V1Task | null;
  /** At most eight, newest first. */
  recent: V1Task[];
  recentCount: number;
  /** Null when the checkout is unknown or not yet provisioned. */
  git: V1Git | null;
  /** Null when unknown or when no PR exists for the branch. */
  pullRequest: V1PullRequest | null;
  /** A settled lookup exists for this branch, including a known absence. */
  pullRequestKnown?: true;
};

export type V1Subagent = {
  id: string;
  title: string;
  updatedAt: number | null;
};

export type V1CrewMember = {
  id: string;
  name: string;
  /** Configured specialism, when the roster declares one. */
  role: string | null;
  /** Configured model ID, when the roster declares one. */
  model: string | null;
  backend: "opencode" | "pi-durable";
  /** The most active state across contexts, in the order of V1Activity. */
  activity: V1Activity;
  /** When the member entered `activity`, when known. */
  since: number | null;
  /** Finish time of the latest outcome while idle; otherwise null. */
  idleSince: number | null;
  contexts: V1CrewContext[];
  /** Child sessions of the member's sessions updated in the last hour. */
  subagents: V1Subagent[];
};

export type V1Feature = {
  /** Stable dotted key, such as `dashboard` or `irc.typing`. */
  key: string;
  /** Short human label. */
  label: string;
  enabled: boolean;
  /** The value Stargate uses when the setting is omitted. */
  defaultEnabled: boolean;
  /** A non-boolean setting's value, such as `summary` for crew activity. */
  value?: string;
};

export type V1Transport = "slack" | "irc" | "teams";

export type V1Backend =
  | "opencode"
  | "pi-durable"
  | "claude"
  | "codex"
  | "module";

export type V1RequestProgress = {
  request: number;
  stage: TurnStage;
  observedAt: number;
  disconnected: boolean;
  stale: boolean;
  status: JobStatus;
  failure: RequestFailure | null;
};

export type V1Captain = {
  requests?: V1RequestProgress[];
  /** Configured registration ID. */
  id: string;
  name: string;
  role: "captain" | "rear_admiral";
  transport: V1Transport;
  backend: V1Backend;
  model: string | null;
  queue: V1QueueCounts;
  /** Running when a job runs, queued when only queued jobs exist, else idle. */
  activity: "running" | "queued" | "idle";
  /** When `activity` last changed while this process was running. */
  since: number | null;
};

export type V1Ship = {
  /** Registration ID of the captain; also the route key. */
  id: string;
  name: string;
  captain: V1Captain;
  /** `owner/name` of the captain's project, when its origin is on GitHub. */
  repository: string | null;
  /** False when the ship's crew or backend could not be read. */
  available: boolean;
  /** A safe reason when `available` is false. */
  error?: string;
  /** Null when the backend has no crew. */
  crew: {
    people: number;
    busy: number;
    queued: number;
    /** True when counts are lower bounds. */
    partial?: true;
  } | null;
  /** Registration-scoped switches, such as `irc.typing`. */
  features: V1Feature[];
};

export type V1ShipDetail = V1Ship & {
  crewMembers: V1CrewMember[];
  /** In a ship event, when the crew state was observed. */
  detailUpdatedAt?: number;
  /** In a ship event, true if the last successful detail is being retained. */
  detailStale?: true;
};

export type V1CrewDetail = {
  ship: string;
  member: V1CrewMember;
};

export type V1Host = {
  hostname: string;
  platform: string;
  arch: string;
  /** Seconds since the VM booted. */
  uptimeSec: number;
  cpu: {
    cores: number;
    /** Busy fraction 0..1 over the last sample window; null before two samples. */
    usage: number | null;
    load: [number, number, number];
  };
  memory: { totalBytes: number; availableBytes: number };
  /** The filesystems labelled `/` and `data`, deduplicated by device. */
  disks: { path: string; totalBytes: number; freeBytes: number }[];
  sampledAt: number;
};

export type V1Gateway = {
  /** The installed release's version, a release checkout's tag, or the package version. */
  version: string;
  /** Version reported by the connected OpenCode server; null when unknown. */
  opencodeVersion: string | null;
  bunVersion: string;
  startedAt: number;
  /** Gateway-wide switches, such as `dashboard` or `api`. */
  features: V1Feature[];
};

export type V1Fleet = {
  apiVersion: typeof API_V1_VERSION;
  generatedAt: number;
  /** In a fleet event, true while a previous overview is being retained. */
  overviewStale?: true;
  /** The configured fleet name, or the hostname. */
  name: string;
  host: V1Host;
  gateway: V1Gateway;
  /** Null when no registration has the rear admiral role. */
  admiral: V1Captain | null;
  /** Captain ships, excluding the rear admiral's registration. */
  ships: V1Ship[];
  longestIdle: { ship: string; member: string; since: number } | null;
};

/** Derived transitions for the ticker and the dispatch/report animation. */
export type V1ActivityEvent = {
  ship: string;
  member: string | null;
  kind: "dispatch" | "phase" | "outcome" | "queued" | "git" | "availability";
  /** One plain sentence, at most 200 characters, such as `Starbuck started “…”`. */
  text: string;
  at: number;
  branch?: string;
  /** Final status for `outcome`. */
  status?: V1TaskStatus;
};

/**
 * Server-sent events. Each frame is `event: <type>` then `data: <json>`.
 * On connect the server sends `fleet` and one `ship` per ship, then changes.
 */
export type V1Event =
  | { type: "fleet"; data: V1Fleet }
  | { type: "ship"; data: V1ShipDetail }
  | { type: "ship-sampled"; data: { id: string; detailUpdatedAt: number } }
  | { type: "host"; data: V1Host }
  | { type: "activity"; data: V1ActivityEvent }
  | { type: "heartbeat"; data: { at: number } };

export type V1ShipRead = (
  signal: AbortSignal,
) => Promise<V1ShipDetail | undefined>;

/** What the projection provides to the HTTP layer. */
export interface ApiV1Source {
  stop?(): Promise<void>;
  /** Fleet without host/gateway. The poller can reuse its captured crew reads. */
  fleet(
    signal: AbortSignal,
    captureShipRead?: (id: string, read: V1ShipRead) => void,
    crewDeadline?: AbortSignal,
  ): Promise<Omit<V1Fleet, "host" | "gateway">>;
  /** Internal identity of the current top-level captains, independent of read availability. */
  shipIdentities?(): ReadonlyMap<string, string>;
  ship(id: string, signal: AbortSignal): Promise<V1ShipDetail | undefined>;
  crew(
    ship: string,
    member: string,
    signal: AbortSignal,
  ): Promise<V1CrewDetail | undefined>;
  /** Gateway-wide switches from the loaded configuration. */
  gatewayFeatures(): V1Feature[];
}

/** One poll's view, compared with the previous one to emit events. */
export type V1Snapshot = {
  fleet: Omit<V1Fleet, "host" | "gateway">;
  ships: Record<string, V1ShipDetail>;
};
