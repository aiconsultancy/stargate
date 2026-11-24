import type { CrewStatus } from "../../shared/crew-status";
import type { CronReportRow, CronRun } from "../../automation/cron/store";
import type {
  HistoryEntriesInput,
  HistoryEntryPage,
  HistorySession,
  HistorySessionPage,
} from "../../shared/session-history";
import type { JobStatus } from "../../gateway/job-status";

/** JSON shapes served by the fleet dashboard. Additive changes only. */
export type QueueCounts = Record<JobStatus, number>;

export type DashboardTransport =
  | {
      kind: "irc";
      host: string;
      port: number;
      tls: boolean;
      network?: string;
      account: string;
      nick: string;
      channels: string[];
      access: {
        allowedAccounts?: string[];
        deniedAccounts: string[];
        deniedChannels: string[];
        channelRequests?: string;
        wakeChannels?: string[];
        humanWakeChannels?: {
          channel: string;
          replies: "all" | "participating";
        }[];
        peerCaptains: string[];
      };
    }
  | { kind: "teams"; tenantId: string; botClientId: string };

export type DashboardCaptain = {
  /** Display grouping only; never an alias for session or queue ownership. */
  key: string;
  id: string;
  name: string;
  registrations: {
    id: string;
    name: string;
    transport: "slack" | DashboardTransport["kind"];
  }[];
};

export type DashboardCrewMember = {
  id: string;
  name: string;
  contexts: CrewStatus["members"];
};

export type ShipSummary = {
  /** Configured registration ID; existing routes keep their own scope. */
  id: string;
  name: string;
  backend: "opencode" | "pi-durable" | "claude" | "codex" | "module";
  transport?: DashboardTransport["kind"];
  agent?: string;
  /** Null when this backend has no crew or its status read failed. */
  crew: {
    /** Legacy totals count member/project contexts, not distinct people. */
    total: number;
    busy: number;
    busyPartial?: true;
    people?: { total: number; busy: number; partial?: true };
  } | null;
  captain?: DashboardCaptain;
  queue: QueueCounts;
  cronjobs: number;
};

export type FleetView = { generatedAt: number; ships: ShipSummary[] };

/** Prompt and reply text stay out of the queue view; open the session. */
export type JobView = {
  id: number;
  status: JobStatus;
  channel: string;
  thread: string;
  user: string;
  failure?: string;
  deferred: boolean;
};

export type CronRunView = {
  id: string;
  name: string;
  status: CronRun["status"];
  dueAt: number;
  finishedAt: number | null;
  manual: boolean;
  report: "immediate" | "daily";
};

export type ShipView = {
  generatedAt: number;
  id: string;
  name: string;
  bot: {
    id: string;
    slack?: { appId: string; team: string; user: string };
    transport?: DashboardTransport;
    access?: {
      users: string[];
      channels: string[];
      deniedUsers: string[];
      deniedChannels: string[];
      mentionOnly?: boolean;
    };
    backend: {
      type: "opencode" | "pi-durable" | "claude" | "codex" | "module";
      directory?: string;
      agent?: string;
      model?: string;
    };
    concurrency: number;
    turnTimeoutMs: number;
  };
  /** Null when unavailable; `crewError` then holds a safe reason. */
  crew: CrewStatus | null;
  crewMembers?: DashboardCrewMember[];
  captain?: DashboardCaptain;
  crewError?: string;
  queue: { counts: QueueCounts; recent: JobView[] };
  cron: {
    /** False means only legacy Slack schedules exist for this bot. */
    fileBacked: boolean;
    dailyReport?: { channel: string; time: string; timezone: string };
    jobs: CronReportRow[];
    runs: CronRunView[];
  };
  /** Captain first, then crew, then this bot's other conversations by use. */
  sessions: HistorySession[];
  /** True when older conversation roots exist beyond this bounded list. */
  sessionsMore: boolean;
  sessionsError?: string;
};

/**
 * Everything the HTTP layer may read. `undefined` means unknown ship or a
 * session outside that ship; the server answers 404 for both.
 */
export interface DashboardSource {
  fleet(signal: AbortSignal): Promise<FleetView>;
  ship(id: string, signal: AbortSignal): Promise<ShipView | undefined>;
  children(
    ship: string,
    input: {
      parentID: string;
      cursor?: string;
      updatedSince?: number;
      limit?: number;
    },
    signal: AbortSignal,
  ): Promise<HistorySessionPage | undefined>;
  entries(
    ship: string,
    input: HistoryEntriesInput,
    signal: AbortSignal,
  ): Promise<HistoryEntryPage | undefined>;
}
