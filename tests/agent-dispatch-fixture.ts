import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import {
  type DispatchApi,
  type DispatchIdentity,
  type DispatchIssue,
  type EditResult,
  type FleetRoster,
  SubspaceApi,
} from "../src/dispatch/api";
import {
  AgentDispatcher,
  type AgentDispatcherOptions,
  type CaptainRef,
  type DispatchEvent,
  type DispatchMessenger,
} from "../src/dispatch/dispatcher";
import { DispatchLedger } from "../src/dispatch/ledger";
import type { IssueLabel } from "../src/dispatch/protocol";

export const FLEET = "00000000-0000-4000-8000-0000000000f1";
export const OTHER_FLEET = "00000000-0000-4000-8000-0000000000f2";
export const INITIATIVE = "00000000-0000-4000-8000-0000000000b1";
export const PROJECT = "00000000-0000-4000-8000-0000000000a1";
export const OUTSIDE = "00000000-0000-4000-8000-0000000000a2";
export const REAR_ADMIRAL = "00000000-0000-4000-8000-000000000001";
export const CAPTAIN_A = "00000000-0000-4000-8000-000000000011";
export const CAPTAIN_B = "00000000-0000-4000-8000-000000000012";
export const CAPTAIN_C = "00000000-0000-4000-8000-000000000013";
export const CREW_A = "00000000-0000-4000-8000-000000000021";
export const HUMAN = "00000000-0000-4000-8000-000000000031";
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** Fake credential values: tests assert they never reach a log line. */
export const TOKEN = "synthetic-dispatch-token-0f9e";
export const ACCESS = "synthetic-access-secret-7c1d";

type Person = {
  userId: string;
  name: string;
  kind: "agent" | "human";
  rank?: string;
  fleetId?: string;
};
export const person: Record<string, Person> = {
  [CAPTAIN_A]: {
    userId: CAPTAIN_A,
    name: "captain-a",
    kind: "agent",
    rank: "captain",
    fleetId: FLEET,
  },
  [CAPTAIN_B]: {
    userId: CAPTAIN_B,
    name: "captain-b",
    kind: "agent",
    rank: "captain",
    fleetId: FLEET,
  },
  [CAPTAIN_C]: {
    userId: CAPTAIN_C,
    name: "captain-c",
    kind: "agent",
    rank: "captain",
    fleetId: FLEET,
  },
  [CREW_A]: {
    userId: CREW_A,
    name: "crew-a",
    kind: "agent",
    rank: "crew",
    fleetId: FLEET,
  },
  [REAR_ADMIRAL]: {
    userId: REAR_ADMIRAL,
    name: "rear-admiral",
    kind: "agent",
    rank: "rearAdmiral",
    fleetId: FLEET,
  },
  [HUMAN]: { userId: HUMAN, name: "Example Person", kind: "human" },
};

export class Clock {
  constructor(public time = Date.parse("2026-11-21T09:00:00.000Z")) {}
  now = () => this.time;
  advance(ms: number) {
    this.time += ms;
  }
}

export type StoredIssue = {
  id: string;
  identifier: string;
  title: string;
  projectId: string;
  version: number;
  updatedAt: string;
  assigneeId: string | null;
  readyForAgents: boolean;
  stateType: string;
  archived: boolean;
};

/** In-memory Subspace API with the server's ready-for-agents rules. */
export class FakeApi implements DispatchApi {
  issues = new Map<string, StoredIssue>();
  comments: { issue: string; body: string }[] = [];
  edits: { issue: string; body: object }[] = [];
  calls: string[] = [];
  agents = [
    {
      userId: REAR_ADMIRAL,
      name: "rear-admiral",
      rank: "rearAdmiral",
      available: true,
    },
    { userId: CAPTAIN_A, name: "captain-a", rank: "captain", available: true },
    { userId: CAPTAIN_B, name: "captain-b", rank: "captain", available: true },
    { userId: CAPTAIN_C, name: "captain-c", rank: "captain", available: true },
    { userId: CREW_A, name: "crew-a", rank: "crew", available: true },
  ];
  /** Simulates an older API without the field. */
  legacy = false;
  identity: DispatchIdentity = {
    userId: REAR_ADMIRAL,
    kind: "agent",
    agentRank: "rearAdmiral",
    fleetId: FLEET,
  };
  /** Runs before an assignment write: a concurrent change can win the race. */
  beforeAssign: ((issue: StoredIssue) => void) | undefined;
  /** Runs before each roster read; it may wait on, or fail, the request. */
  beforeFleet: ((signal: AbortSignal) => Promise<void>) | undefined;
  failAssign = 0;
  constructor(readonly clock: Clock) {}

  add(issue: Partial<StoredIssue> & { id: string; identifier: string }) {
    this.issues.set(issue.id, {
      title: `Title of ${issue.identifier}`,
      projectId: PROJECT,
      version: 1,
      updatedAt: new Date(this.clock.now()).toISOString(),
      assigneeId: null,
      readyForAgents: false,
      stateType: "unstarted",
      archived: false,
      ...issue,
    });
  }

  /** A change made by someone else, as the server would record it. */
  change(id: string, patch: Partial<StoredIssue>) {
    const issue = this.issues.get(id);
    if (!issue) throw new Error("unknown issue");
    Object.assign(issue, patch, {
      version: issue.version + 1,
      updatedAt: new Date(this.clock.now()).toISOString(),
    });
    if (issue.assigneeId) issue.readyForAgents = false;
  }

  agent(userId: string) {
    const agent = this.agents.find((entry) => entry.userId === userId);
    if (!agent) throw new Error("unknown agent");
    return agent;
  }

  view(issue: StoredIssue): DispatchIssue {
    const assignee = issue.assigneeId ? person[issue.assigneeId] : undefined;
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      projectId: issue.projectId,
      version: issue.version,
      updatedAt: issue.updatedAt,
      assignee: assignee
        ? {
            userId: assignee.userId,
            kind: assignee.kind,
            rank: assignee.rank,
            fleetId: assignee.fleetId,
          }
        : null,
      readyForAgents: this.legacy ? undefined : issue.readyForAgents,
      stateType: issue.stateType,
      archived: issue.archived,
    };
  }

  /** The issue as the HTTP API serialises it (a subset of IssueFields). */
  wire(issue: StoredIssue) {
    const assignee = issue.assigneeId ? person[issue.assigneeId] : undefined;
    return {
      id: issue.id,
      identifier: issue.identifier,
      projectId: issue.projectId,
      type: "issue",
      title: issue.title,
      state: { id: `${issue.stateType}-state`, type: issue.stateType },
      assignee: assignee
        ? {
            userId: assignee.userId,
            displayName: assignee.name,
            isFormerMember: false,
            kind: assignee.kind,
            agent:
              assignee.kind === "agent"
                ? {
                    rank: assignee.rank,
                    fleet: "example-fleet",
                    ship: null,
                    fleetId: assignee.fleetId ?? null,
                    shipId: null,
                  }
                : null,
          }
        : null,
      ...(this.legacy ? {} : { readyForAgents: issue.readyForAgents }),
      archivedAt: issue.archived ? issue.updatedAt : null,
      updatedAt: issue.updatedAt,
      version: issue.version,
    };
  }

  async me() {
    this.calls.push("me");
    return this.identity;
  }
  async fleet(reference: string, signal: AbortSignal): Promise<FleetRoster> {
    this.calls.push(`fleet ${reference}`);
    await this.beforeFleet?.(signal);
    return {
      id: FLEET,
      slug: "example-fleet",
      agents: this.agents.map((a) => ({ ...a })),
    };
  }
  async fleetProjects(fleetId: string) {
    this.calls.push("projects");
    return new Set(fleetId === FLEET ? [PROJECT] : []);
  }
  assignedRaw(assignees: readonly string[], since: string | undefined) {
    return [...this.issues.values()].filter(
      (issue) =>
        issue.assigneeId !== null &&
        assignees.includes(issue.assigneeId) &&
        !issue.archived &&
        (since === undefined || issue.updatedAt >= since),
    );
  }
  async assignedIssues(
    assignees: readonly string[],
    since: string | undefined,
  ) {
    this.calls.push(`assigned since=${since ?? "-"}`);
    return this.assignedRaw(assignees, since).map((issue) => this.view(issue));
  }
  readyRaw() {
    return [...this.issues.values()].filter(
      (issue) =>
        issue.assigneeId === null &&
        !issue.archived &&
        (this.legacy || issue.readyForAgents),
    );
  }
  async readyIssues() {
    this.calls.push("ready");
    return this.readyRaw().map((issue) => this.view(issue));
  }
  async issue(reference: string) {
    this.calls.push(`issue ${reference}`);
    const issue = this.issues.get(reference);
    return issue ? this.view(issue) : undefined;
  }
  async assign(
    reference: string,
    version: number,
    assigneeId: string,
  ): Promise<EditResult> {
    if (this.failAssign > 0) {
      this.failAssign--;
      throw new Error("API unavailable");
    }
    const issue = this.issues.get(reference);
    if (!issue) throw new Error("missing");
    this.beforeAssign?.(issue);
    this.beforeAssign = undefined;
    if (issue.version !== version) return { conflict: true };
    this.edits.push({ issue: reference, body: { version, assigneeId } });
    this.change(reference, { assigneeId });
    return { conflict: false, version: issue.version };
  }
  async clearReady(reference: string, version: number): Promise<EditResult> {
    const issue = this.issues.get(reference);
    if (!issue) throw new Error("missing");
    if (issue.version !== version) return { conflict: true };
    this.edits.push({
      issue: reference,
      body: { version, readyForAgents: false },
    });
    this.change(reference, { readyForAgents: false });
    return { conflict: false, version: issue.version };
  }
  async comment(reference: string, body: string) {
    this.comments.push({ issue: reference, body });
    const issue = this.issues.get(reference);
    if (issue) issue.updatedAt = new Date(this.clock.now()).toISOString();
  }
}

export type Line =
  | { kind: "assigned"; account: string; issue: string }
  | {
      kind: "offer";
      account: string;
      issue: string;
      offerID: string;
      messageID: string;
    }
  | { kind: "status"; event: DispatchEvent };

export class FakeChat implements DispatchMessenger {
  lines: Line[] = [];
  offline = new Set<string>();
  /** Our own chat connection is down: every send throws. */
  down = false;
  private sequence = 0;
  async assigned(captain: CaptainRef, issue: IssueLabel) {
    if (this.down) throw new Error("IRC unavailable");
    if (this.offline.has(captain.account)) return false;
    this.lines.push({
      kind: "assigned",
      account: captain.account,
      issue: issue.identifier,
    });
    return true;
  }
  async offer(captain: CaptainRef, offer: { id: string; issue: IssueLabel }) {
    if (this.down) throw new Error("IRC unavailable");
    if (this.offline.has(captain.account)) return undefined;
    const messageID = `msg-${++this.sequence}`;
    this.lines.push({
      kind: "offer",
      account: captain.account,
      issue: offer.issue.identifier,
      offerID: offer.id,
      messageID,
    });
    return { messageID };
  }
  async announce(event: DispatchEvent) {
    if (this.down) throw new Error("IRC unavailable");
    this.lines.push({ kind: "status", event });
  }
  offers() {
    return this.lines.flatMap((line) => (line.kind === "offer" ? [line] : []));
  }
  lastOffer() {
    const offer = this.offers().at(-1);
    if (!offer) throw new Error("no offer");
    return offer;
  }
  statuses() {
    return this.lines.flatMap((line) =>
      line.kind === "status" ? [line.event.kind] : [],
    );
  }
  /** A compact transcript for fixture evidence. */
  transcript() {
    return this.lines.map((line) =>
      line.kind === "assigned"
        ? `assigned ${line.issue} -> ${line.account}`
        : line.kind === "offer"
          ? `offer ${line.issue} -> ${line.account}`
          : `${line.event.kind} ${line.event.issue}`,
    );
  }
}

export type RouteKind =
  | "me"
  | "fleet"
  | "initiatives"
  | "projects"
  | "assigned"
  | "ready"
  | "issue"
  | "assign"
  | "clear"
  | "comment";
/**
 * `refused`: no connection. `timeout`: no answer until the client gives up.
 * `5xx`: a server error. `malformed`: a 200 whose body is not the JSON shape;
 * a write is applied first. `lost`: a write is applied, then the connection
 * drops before the answer.
 */
export type FetchFailure = "refused" | "timeout" | "5xx" | "malformed" | "lost";

/**
 * The fake API behind real `fetch` semantics, for the real `SubspaceApi`
 * client. JSON follows the API's wire shapes; failures are injected per route.
 */
export class FakeSubspaceHttp {
  requests: {
    method: string;
    path: string;
    headers: Headers;
    redirect: RequestRedirect | undefined;
  }[] = [];
  failures = new Map<RouteKind, FetchFailure>();
  /** Every request is refused with this status (a bad or revoked credential). */
  credentialStatus: 401 | 403 | undefined;
  /** An API that predates the filter answers 400 to `readyForAgents`. */
  rejectReadyFilter = false;
  constructor(readonly api: FakeApi) {}

  readonly fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    this.requests.push({
      method,
      path: url.pathname + url.search,
      headers,
      redirect: init.redirect,
    });
    const route = this.route(method, url, String(init.body ?? ""));
    const failure = route ? this.failures.get(route) : undefined;
    if (failure === "refused") throw new TypeError("fetch failed");
    if (failure === "timeout")
      return await new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    if (failure === "5xx")
      return new Response('{"title":"Unavailable"}', { status: 503 });
    if (this.credentialStatus)
      return new Response('{"title":"Refused"}', {
        status: this.credentialStatus,
      });
    if (
      headers.get("authorization") !== `Bearer ${TOKEN}` ||
      headers.get("x-access-id") !== ACCESS
    )
      return new Response("{}", { status: 401 });
    const response = await this.answer(route, url, String(init.body ?? ""));
    if (failure === "lost") throw new TypeError("connection reset");
    if (failure === "malformed")
      return new Response("{not json", { status: 200 });
    return response;
  }) as typeof fetch;

  private route(method: string, url: URL, body: string): RouteKind | undefined {
    const path = url.pathname;
    if (path === "/api/v1/me") return "me";
    if (path.startsWith("/api/v1/fleets/")) return "fleet";
    if (path === "/api/v1/initiatives") return "initiatives";
    if (path === "/api/v1/projects") return "projects";
    if (path === "/api/v1/issues")
      return url.searchParams.has("readyForAgents") ? "ready" : "assigned";
    if (path.endsWith("/comments")) return "comment";
    if (path.startsWith("/api/v1/issues/"))
      return method === "PATCH"
        ? body.includes('"assigneeId"')
          ? "assign"
          : "clear"
        : "issue";
    return;
  }

  private async answer(
    route: RouteKind | undefined,
    url: URL,
    body: string,
  ): Promise<Response> {
    const api = this.api;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    const page = (items: unknown[]) => json({ items, nextCursor: null });
    switch (route) {
      case "me":
        return json({
          ...api.identity,
          displayName: "rear-admiral",
          isAdmin: false,
        });
      case "fleet":
        return json({
          id: FLEET,
          slug: "example-fleet",
          name: "Example fleet",
          agents: api.agents.map((agent) => ({ ...agent, ship: null })),
        });
      case "initiatives":
        return page([{ id: INITIATIVE, parentId: null, fleetId: FLEET }]);
      case "projects":
        return page([
          { id: PROJECT, initiativeId: INITIATIVE },
          { id: OUTSIDE, initiativeId: null },
        ]);
      case "assigned":
        return page(
          api
            .assignedRaw(
              url.searchParams.getAll("assignee"),
              url.searchParams.get("updatedSince") ?? undefined,
            )
            .map((issue) => api.wire(issue)),
        );
      case "ready":
        if (this.rejectReadyFilter)
          return json({ title: "Unknown filter" }, 400);
        return page(api.readyRaw().map((issue) => api.wire(issue)));
      case "issue": {
        const issue = api.issues.get(lastSegment(url));
        return issue ? json(api.wire(issue)) : json({}, 404);
      }
      case "assign":
      case "clear": {
        const issue = api.issues.get(lastSegment(url));
        if (!issue) return json({}, 404);
        const edit = JSON.parse(body) as {
          version: number;
          assigneeId?: string;
          readyForAgents?: boolean;
        };
        if (edit.version !== issue.version) return json({}, 409);
        api.edits.push({ issue: issue.id, body: edit });
        api.change(
          issue.id,
          edit.assigneeId
            ? { assigneeId: edit.assigneeId }
            : { readyForAgents: false },
        );
        return json(api.wire(issue));
      }
      case "comment": {
        const id = url.pathname.split("/").at(-2) ?? "";
        const { body: text } = JSON.parse(body) as { body: string };
        await api.comment(id, text);
        return json({ id: "comment-1" }, 201);
      }
      default:
        return json({}, 404);
    }
  }
}

function lastSegment(url: URL) {
  return decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
}

/** A pino logger that keeps every line, so tests can look for secrets. */
export function capturedLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const log = pino(
    { level: "debug" },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  return { log, lines };
}

export const silent = pino({ level: "silent" });

const directories: string[] = [];
export async function removeDirectories() {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
}

export async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "stargate-dispatch-"));
  directories.push(directory);
  return directory;
}

export type FixtureOptions = {
  ladder?: number[];
  enrolled?: string[];
  path?: string;
  /** Use the real HTTP client over `FakeSubspaceHttp` instead of `FakeApi`. */
  http?: boolean;
  log?: Logger;
  wait?: AgentDispatcherOptions["wait"];
};

export async function fixture(options: FixtureOptions = {}) {
  const directory = await tempDirectory();
  const clock = new Clock();
  const api = new FakeApi(clock);
  const http = new FakeSubspaceHttp(api);
  const chat = new FakeChat();
  const path = options.path ?? join(directory, "agent-dispatch.sqlite");
  const enrolled = new Set(
    options.enrolled ?? [
      "example-captain-a",
      "example-captain-b",
      "example-captain-c",
      "example-rear-admiral",
    ],
  );
  const client = options.http
    ? new SubspaceApi({
        baseUrl: "https://subspace.example.test/api",
        tokenEnv: "DISPATCH_TOKEN",
        headersEnv: { "X-Access-Id": "DISPATCH_ACCESS" },
        env: { DISPATCH_TOKEN: TOKEN, DISPATCH_ACCESS: ACCESS },
        fetch: http.fetch,
        timeoutMs: 20,
      })
    : api;
  const open = (ledger = new DispatchLedger(path)) =>
    new AgentDispatcher({
      settings: {
        fleet: "example-fleet",
        pollIntervalMs: 2 * MINUTE,
        answerTimeoutMs: 5 * MINUTE,
        retryLadderMs: options.ladder ?? [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR],
        captainAccount: (name) => `example-${name}`,
        enrolled: (account) => enrolled.has(account),
      },
      api: client,
      messenger: chat,
      ledger,
      now: clock.now,
      log: options.log ?? silent,
      ...(options.wait ? { wait: options.wait } : {}),
    });
  const ledger = new DispatchLedger(path);
  const dispatcher = open(ledger);
  return { clock, api, http, chat, ledger, dispatcher, open, path, directory };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export const signal = new AbortController().signal;

export function answer(
  f: Fixture,
  kind: "accept" | "decline",
  overrides: Partial<{
    account: string;
    offerID: string;
    replyTo: string;
    at: number;
  }> = {},
) {
  const offer = f.chat.lastOffer();
  return f.dispatcher.answer(
    {
      account: offer.account,
      offerID: offer.offerID,
      answer: kind,
      replyTo: offer.messageID,
      at: f.clock.now(),
      ...overrides,
    },
    signal,
  );
}
