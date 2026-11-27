/**
 * Fleet API v1: the read-only contract the Subspace Fleet Bridge web Space
 * reads. Additive changes only; never remove or retype a field.
 *
 * Times are epoch milliseconds. Byte counts are integers. The API neither
 * redacts nor rewrites crew task text or branch names, in any route or event.
 * Ship detail and events bound task text to 180/80/400; the crew route adds
 * no limit beyond the plugin's 64,000 code points. Only unsupported plugins
 * answer redacted; a failed current plugin read reports unavailability.
 * The agent activity route serves tool input and output, errors, reply and
 * reasoning text complete and unredacted, and pages large items instead of
 * cutting them. The crew diff routes serve every changed path's patch and
 * bytes the same way. The fleet, ship and crew routes carry no prompt or
 * reply text.
 *
 * Routes (all GET, bearer token, private networks only, `Cache-Control:
 * no-store`):
 *   /api/v1/fleet                       -> V1Fleet
 *   /api/v1/ships/{id}                  -> V1ShipDetail
 *   /api/v1/ships/{id}/crew/{member}    -> V1CrewDetail
 *   /api/v1/ships/{id}/crew/{member}/diff       -> V1Diff
 *   /api/v1/ships/{id}/crew/{member}/diff/file  -> V1DiffFilePage
 *   /api/v1/agents/{id}/activity        -> V1AgentActivity or V1ActivityItemPage
 *   /api/v1/events                      -> text/event-stream of V1Event
 */
import type { JobStatus } from "../../../../gateway/job-status";
import type { TurnStage } from "../../../../shared/turn-progress";
import type { RequestFailure } from "../../../../shared/request-failure";

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
  /** At most 180 characters; the crew member route adds no limit. */
  summary: string;
  /** At most 80 characters; the crew member route adds no limit. */
  phase: string;
  /** At most 400 characters; the crew member route adds no limit. */
  progress: string;
  createdAt: number | null;
  startedAt: number | null;
  updatedAt: number | null;
  finishedAt: number | null;
};

/**
 * Git state of one crew checkout, read on the fleet VM and cached briefly.
 * The captain's crew plugin reads it when it can, because the gateway may run
 * as a user that cannot read the captain's home.
 */
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
  /** Full object ID of HEAD; null when unborn or unknown. */
  commit?: string | null;
  /** Absolute path of the checkout on the fleet VM, when known. */
  worktree?: string;
  /** True when `changedFiles` is above zero; absent when the count is unknown. */
  dirty?: boolean;
  /**
   * Who read the state: `captain` is the captain's crew plugin, running as
   * the user that owns the worktree; `gateway` is this process.
   */
  source?: "captain" | "gateway";
  /**
   * Crew checkouts read by the captain: changes with anything their diff
   * shows, and equals `V1Diff.fingerprint` in every mode.
   */
  fingerprint?: string;
};

export type V1DiffMode = "branch" | "committed" | "working";

/** One changed path, in GitHub's per-file shape. */
export type V1DiffFile = {
  path: string;
  /** The old path of a rename; else null. */
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed";
  /** Null when binary. */
  additions: number | null;
  deletions: number | null;
  /** Not in Git's index: new, and not ignored. */
  untracked?: true;
  binary?: true;
  /** Bytes of the new side, or of the old side for a removed file. */
  size?: number;
  /** Hunks only, without file headers; null when there are none. */
  patch: string | null;
  /** Continue the patch with the file route's `page`. */
  patchNextPage?: string;
  kind?: "submodule" | "symlink";
};

/** A crew checkout's changes; `files: []` means none. */
export type V1Diff = {
  ship: string;
  member: string;
  project: string | null;
  mode: V1DiffMode;
  fingerprint: string;
  /** The checkout kept changing: this answer may mix two states. */
  unstable: boolean;
  branch: string | null;
  /**
   * The merge base with `origin/HEAD`. Null when there is none: `origin/HEAD`
   * cannot be resolved, shares no history with HEAD, or HEAD is unborn.
   */
  base: { ref: string; commit: string } | null;
  /** Null on an unborn branch. */
  head: string | null;
  /** Changed paths in the whole diff, and their line counts. */
  total: number;
  additions: number;
  deletions: number;
  /** Sorted by path in byte order. */
  files: V1DiffFile[];
  nextPage?: string;
};

/** One page of a file's bytes, base64-encoded. */
export type V1DiffContent = {
  side: "old" | "new";
  encoding: "base64";
  offset: number;
  size: number;
  data: string;
  nextPage?: string;
};

/** A page of one file's patch, or of one side's bytes. */
export type V1DiffFilePage = {
  fingerprint: string;
  file: V1DiffFile;
  content?: V1DiffContent;
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
  /** Configured crew ID: the key of its state, the `{member}` route segment. */
  id: string;
  /** Configured crew name, which may differ from the ID; else the ID. */
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
  /** Whether the read returned complete stored task text or the bounded view. */
  taskText: "full" | "preview";
};

/** A crew read failed; it did not establish whether the member exists. */
export class CrewStatusUnavailable extends Error {}

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

/** A provider failure as the agent saw it. */
export type V1ActivityError = {
  type: string;
  message: string;
  /** HTTP status, when the provider gave one. */
  status: number | null;
  /** The provider's response body, when it gave one. */
  responseBody: string | null;
  retryAfterMs: number | null;
};

export type V1ActivityContent =
  | { type: "text"; text: string }
  /** `uri` is often a `data:` URI holding the whole file. */
  | { type: "file"; uri: string; mime: string; name: string | null };

export type V1ActivityTokens = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Item IDs are stable within their turn. `seq` is the agent change sequence
 * of the item's latest change; a client keeps the item with the higher seq.
 */
type V1ActivityItemBase = {
  unavailable?: string[];
  id: string;
  seq: number;
  startedAt: number;
  updatedAt: number;
};

/** One model request and response. */
export type V1ActivityStep = V1ActivityItemBase & {
  kind: "step";
  status: "running" | "completed" | "failed";
  model: { provider: string; id: string; variant: string | null } | null;
  firstTokenAt: number | null;
  streamedAt: number | null;
  endedAt: number | null;
  finish: string | null;
  /** Settled token use; null while running. */
  tokens: V1ActivityTokens | null;
  /** Settled cost in USD; null while running or when unpriced. */
  cost: number | null;
  error: V1ActivityError | null;
};

/** Reply text (`text`) or the model's reasoning text (`reasoning`). */
export type V1ActivityText = V1ActivityItemBase & {
  kind: "text" | "reasoning";
  status: "streaming" | "completed";
  text: string;
};

export type V1ActivityToolCall = V1ActivityItemBase & {
  kind: "tool";
  /** The provider's tool call ID. */
  callId: string;
  /** Null until the call's name is observed. */
  name: string | null;
  /** `input` while the model streams the arguments. */
  status: "input" | "running" | "completed" | "failed";
  /** The arguments as the model streamed them. */
  rawInput: string;
  /** The parsed arguments once the call was made. */
  input: Record<string, unknown> | null;
  /** Whether the tool ran; null until known. */
  executed: boolean | null;
  /** The tool's latest progress or result metadata, such as live output. */
  metadata: Record<string, unknown> | null;
  /** The result, or a failed call's partial output. */
  content: V1ActivityContent[] | null;
  error: V1ActivityError | null;
};

export type V1ActivityItem =
  | V1ActivityStep
  | V1ActivityText
  | V1ActivityToolCall;

/**
 * An item whose JSON exceeds 64 KiB. Fetch its pages with
 * `?turn=&item=&page=` and join their `data` to read the complete item JSON.
 */
export type V1ActivityPagedItem = V1ActivityItemBase & {
  kind: V1ActivityItem["kind"];
  status: V1ActivityItem["status"];
  /** Tool calls only. */
  callId?: string;
  /** Tool calls only. */
  name?: string | null;
  paged: { pages: number; bytes: number };
};

/** Provider total when available, otherwise summed over the turn's steps. */
export type V1ActivityUsage = {
  steps: number;
  tokens: V1ActivityTokens;
  /** USD. */
  cost: number;
};

export type V1ActivityTurn = V1ActivityTurnSummary & {
  /** In first-observed order. */
  items: (V1ActivityItem | V1ActivityPagedItem)[];
};

/** A turn without its items, as the `agent-activity` event carries it. */
export type V1ActivityTurnSummary = {
  /**
   * SDK session and, for children, the parent turn and spawning call; a
   * crew turn's worker session, with `parent` null for its root.
   */
  session?: V1ActivityTurnSession;
  /** Stable and unique across gateway restarts. */
  id: string;
  /** The agent change sequence of the turn's latest change. */
  seq: number;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Observation ended without a confirmed native outcome. Only on cancelled turns. */
  lost?: true;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** Original IRC requests in intake order; empty when no wire msgid is known. */
  requests: { channel: string; msgid: string }[];
  /** Times the live provider stream reattached; changes can be missing. */
  reconnects: number;
  /** Null until a step settles. */
  usage: V1ActivityUsage | null;
  /**
   * Crew turns only: the task whose input this turn answers, matched by
   * input ID; null for a turn outside any task (mail, notices, compaction).
   */
  task?: V1ActivityTurnTask | null;
};

export type V1ActivityTurnTask = {
  id: string;
  inputId: string;
  /** The crew project key; null for the captain's default project. */
  project: string | null;
};

export type V1ActivityTurnSession = {
  id: string;
  /** The turn and tool call that started this sub-session. */
  parent: { turnId: string; callId: string | null } | null;
};

/** Changes up to `seq` are included. `generation` changes on restart. */
export type V1ActivityCursor = { generation: string; seq: number };

export type V1AgentActivity = {
  agent: {
    /** Registration ID. */
    id: string;
    role: "captain" | "rear_admiral";
    backend: V1Backend;
    /** False when this gateway does not collect turns for the backend. */
    collected: boolean;
    unavailable?: string[];
    /** Crew subjects only: the crew member ID under `id`'s captain. */
    member?: string;
  };
  /** Oldest first; at most 16 recent root turns and their children. */
  turns: V1ActivityTurn[];
  cursor: V1ActivityCursor;
};

/** One page of one item's complete JSON, at most 64 KiB of UTF-8. */
export type V1ActivityItemPage = {
  agent: string;
  /** Crew subjects only. */
  member?: string;
  turn: string;
  item: string;
  /** Pages of different `seq` values do not join; refetch from page 0. */
  seq: number;
  page: number;
  pages: number;
  /** UTF-8 length of the whole item JSON. */
  bytes: number;
  data: string;
};

/**
 * One coalesced change. Every change type is an upsert by ID: a turn's
 * summary (including `session` when known) or one item, as the snapshot
 * route shows it. Paged item stubs retain any `unavailable` entries.
 */
export type V1AgentActivityChange =
  | {
      type: "turn-started" | "turn-updated" | "turn-ended";
      turn: V1ActivityTurnSummary;
    }
  | { type: "item"; item: V1ActivityItem | V1ActivityPagedItem };

/**
 * `agent-activity`, sent only to `/api/v1/events?agent=` subscribers.
 * Wait for the stream's response before fetching the snapshot. `generation`
 * and `seq` are the snapshot cursor's, per agent: apply events whose `seq` is
 * above that agent's snapshot cursor. `seq` rises with every event but skips
 * values for coalesced changes and other turns, so a skipped value is not a
 * loss; a stream that falls behind is closed instead.
 */
export type V1AgentActivityEvent = {
  agentId: string;
  /**
   * Crew subjects only: the crew member under captain `agentId`. Each member
   * has its own `seq`; key cursors by `(agentId, member)`.
   */
  member?: string;
  turnId: string;
  generation: string;
  seq: number;
  /** When the change happened, in epoch milliseconds. */
  at: number;
  change: V1AgentActivityChange;
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
  | { type: "agent-activity"; data: V1AgentActivityEvent }
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
  /**
   * The same reads for officers' sockets, with the crew plugin's ordinary
   * task text: redacted and bounded, never `unredacted` or `full`.
   */
  officer: Pick<ApiV1Source, "fleet" | "ship" | "crew">;
}

/** One poll's view, compared with the previous one to emit events. */
export type V1Snapshot = {
  fleet: Omit<V1Fleet, "host" | "gateway">;
  ships: Record<string, V1ShipDetail>;
};
