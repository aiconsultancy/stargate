import { Result, Schema } from "effect";
import { commentBody, dispatchRoutes, issueEdit } from "./routes";

/** A PATCH body built by `issueEdit`. */
type IssueEdit = ReturnType<(typeof issueEdit)[keyof typeof issueEdit]>;

export type AgentRank = "rearAdmiral" | "captain" | "crew";

export type FleetAgent = {
  userId: string;
  name: string;
  rank: string;
  available: boolean;
  ircNick?: string;
};

export type FleetRoster = { id: string; slug: string; agents: FleetAgent[] };

export type DispatchIssue = {
  id: string;
  identifier: string;
  title: string;
  projectId: string;
  version: number;
  updatedAt: string;
  assignee: {
    userId: string;
    kind: string;
    rank: string | undefined;
    fleetId: string | undefined;
  } | null;
  /** Undefined when the API predates the field. */
  readyForAgents: boolean | undefined;
  stateType: string;
  archived: boolean;
};

export type DispatchIdentity = {
  userId: string;
  kind: string;
  agentRank: string | null;
  fleetId: string | null;
};

/**
 * One poll's stretch of an issue listing: at most a page budget, so no
 * listing is too long to make progress. `next` continues it at a later poll
 * (the API's cursor, bound to the same filter); undefined at the end.
 */
export type ListingPart<T> = { items: T[]; next: string | undefined };

/** A versioned edit either applied (with the new version when returned) or lost a race. */
export type EditResult =
  | { conflict: false; version: number | undefined }
  | { conflict: true };

const decisionOutcomeSchema = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  identifier: Schema.String.check(
    Schema.isPattern(/^D-[0-9]{5,19}-[A-Z][A-Z0-9]{1,4}$/u),
  ),
  recordedByUserId: Schema.String.check(Schema.isUUID()),
  status: Schema.Literals(["accepted", "rejected"]),
});

export type DecisionOutcome = typeof decisionOutcomeSchema.Type;

/** The API surface the dispatcher needs; tests supply a fake. */
export interface DispatchApi {
  me(signal: AbortSignal): Promise<DispatchIdentity>;
  fleet(reference: string, signal: AbortSignal): Promise<FleetRoster>;
  /** Projects whose initiative, or nearest ancestor with a fleet, is this fleet's. */
  fleetProjects(fleetId: string, signal: AbortSignal): Promise<Set<string>>;
  /** Issues assigned to these agents, from `cursor` (the start when undefined). */
  assignedIssues(
    assignees: readonly string[],
    updatedSince: string | undefined,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<ListingPart<DispatchIssue>>;
  readyIssues(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<ListingPart<DispatchIssue>>;
  decisionOutcomes?(
    fleetId: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<ListingPart<DecisionOutcome>>;
  acknowledgeDecisionOutcome?(
    fleetId: string,
    outcomeId: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Undefined when the issue is gone or no longer readable. */
  issue(
    reference: string,
    signal: AbortSignal,
  ): Promise<DispatchIssue | undefined>;
  assign(
    reference: string,
    version: number,
    assigneeId: string,
    signal: AbortSignal,
  ): Promise<EditResult>;
  clearReady(
    reference: string,
    version: number,
    signal: AbortSignal,
  ): Promise<EditResult>;
  comment(reference: string, body: string, signal: AbortSignal): Promise<void>;
}

/** Status only: response bodies, headers and credentials are never kept. */
export class DispatchApiError extends Error {
  public constructor(
    public readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DispatchApiError";
  }
}

const nullableString = Schema.optional(Schema.NullOr(Schema.String));

const issueSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  version: Schema.Finite,
  updatedAt: Schema.String,
  assignee: Schema.NullOr(
    Schema.Struct({
      userId: Schema.String,
      kind: Schema.String,
      agent: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ rank: Schema.String, fleetId: nullableString }),
        ),
      ),
    }),
  ),
  readyForAgents: Schema.optional(Schema.Boolean),
  state: Schema.Struct({ type: Schema.String }),
  archivedAt: nullableString,
});

const pageSchema = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const fleetSchema = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  agents: Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      name: Schema.String,
      rank: Schema.String,
      available: Schema.optional(Schema.Boolean),
      ircNick: nullableString,
    }),
  ),
});

const meSchema = Schema.Struct({
  userId: Schema.String,
  kind: Schema.String,
  agentRank: Schema.optional(Schema.NullOr(Schema.String)),
  fleetId: nullableString,
});

const initiativeSchema = Schema.Struct({
  id: Schema.String,
  parentId: nullableString,
  fleetId: nullableString,
});

const projectSchema = Schema.Struct({
  id: Schema.String,
  initiativeId: nullableString,
});

function decode<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  value: unknown,
  what: string,
): S["Type"] {
  const result = Schema.decodeUnknownResult(schema)(value);

  if (Result.isFailure(result)) {
    throw new DispatchApiError(undefined, `Unexpected ${what} from the API`);
  }

  return result.success;
}

export function toDispatchIssue(value: unknown): DispatchIssue {
  const issue = decode(issueSchema, value, "issue");

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    projectId: issue.projectId,
    version: issue.version,
    updatedAt: issue.updatedAt,
    assignee: issue.assignee
      ? {
          userId: issue.assignee.userId,
          kind: issue.assignee.kind,
          rank: issue.assignee.agent?.rank,
          fleetId: issue.assignee.agent?.fleetId ?? undefined,
        }
      : null,
    readyForAgents: issue.readyForAgents,
    stateType: issue.state.type,
    archived: issue.archivedAt !== undefined && issue.archivedAt !== null,
  };
}

function json(status: number, text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DispatchApiError(status, "API response is not JSON");
  }
}

/**
 * Pages of an issue listing read in one call; a longer listing continues at
 * the next poll from the returned cursor, so its size never blocks a poll.
 */
const issuePageBudget = 50;

/**
 * Initiatives and projects are needed whole for fleet membership. Bound the
 * walk anyway, so a misbehaving cursor never loops forever; a longer listing
 * leaves membership unknown, which defers offers rather than permitting them.
 */
const maxReferencePages = 500;
const maxBodyBytes = 8 * 1024 * 1024;

export type SubspaceApiOptions = {
  /** API origin, optionally ending in `/api`; routes add `/api/v1`. */
  baseUrl: string;
  /** Environment variable holding the rear admiral's bearer token. */
  tokenEnv: string;
  /** Extra request headers, each read from an environment variable. */
  headersEnv: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/** HTTPS client for the Subspace API. Never logs requests or responses. */
export class SubspaceApi implements DispatchApi {
  private readonly base: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  public constructor(private readonly options: SubspaceApiOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
    this.env = options.env ?? process.env;
    this.fetcher = options.fetch ?? fetch;
  }

  private headers(body: boolean) {
    const token = this.env[this.options.tokenEnv]?.trim();

    if (!token) {
      throw new DispatchApiError(
        undefined,
        "The agent dispatch API token is not set",
      );
    }

    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${token}`,
    });

    if (body) {
      headers.set("content-type", "application/json");
    }

    for (const [name, variable] of Object.entries(this.options.headersEnv)) {
      const value = this.env[variable]?.trim();

      if (!value) {
        throw new DispatchApiError(
          undefined,
          "An agent dispatch API header variable is not set",
        );
      }

      headers.set(name, value);
    }

    return headers;
  }

  /**
   * One request. A 404 or 409 is returned for the caller to interpret; any
   * other failure is a DispatchApiError carrying the status only.
   */
  private async request(
    method: "GET" | "PATCH" | "POST",
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    let response: Response;

    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
        ]),
      });
    } catch (error) {
      if (error instanceof DispatchApiError) {
        throw error;
      }

      signal.throwIfAborted();
      throw new DispatchApiError(undefined, "The Subspace API is unreachable");
    }

    let text: string;

    try {
      text = await response.text();
    } catch {
      signal.throwIfAborted();

      // A successful write status is the outcome; its body is optional.
      if (method !== "GET" && response.ok) {
        return { status: response.status, text: "" };
      }

      throw new DispatchApiError(
        response.status,
        "The Subspace API response was cut short",
      );
    }

    if (text.length > maxBodyBytes) {
      throw new DispatchApiError(response.status, "API response too large");
    }

    if (response.status === 409 || response.status === 404) {
      return { status: response.status, text: "" };
    }

    if (!response.ok) {
      throw new DispatchApiError(
        response.status,
        `The Subspace API answered HTTP ${response.status}`,
      );
    }

    return { status: response.status, text };
  }

  private async get(path: string, signal: AbortSignal) {
    const { status, text } = await this.request("GET", path, signal);

    if (status === 404 || status === 409) {
      throw new DispatchApiError(status, `The Subspace API answered ${status}`);
    }

    return json(status, text);
  }

  /** Up to `budget` pages from `from`; `next` is where the listing goes on. */
  private async walk(
    route: (cursor?: string) => string,
    from: string | undefined,
    budget: number,
    signal: AbortSignal,
  ): Promise<ListingPart<unknown>> {
    const items: unknown[] = [];
    let cursor = from;

    for (let page = 0; page < budget; page++) {
      const result = decode(
        pageSchema,
        await this.get(route(cursor), signal),
        "page",
      );

      items.push(...result.items);

      if (!result.nextCursor) {
        return { items, next: undefined };
      }

      if (result.nextCursor === cursor) {
        throw new DispatchApiError(undefined, "API listing cursor repeated");
      }

      cursor = result.nextCursor;
    }

    return { items, next: cursor };
  }

  /** A whole listing, or an error when it exceeds the reference bound. */
  private async pages(
    route: (cursor?: string) => string,
    signal: AbortSignal,
  ): Promise<unknown[]> {
    const { items, next } = await this.walk(
      route,
      undefined,
      maxReferencePages,
      signal,
    );

    if (next !== undefined) {
      throw new DispatchApiError(
        undefined,
        "API listing exceeded its page bound",
      );
    }

    return items;
  }

  private async issueListing(
    route: (cursor?: string) => string,
    from: string | undefined,
    signal: AbortSignal,
  ): Promise<ListingPart<DispatchIssue>> {
    const part = await this.walk(route, from, issuePageBudget, signal);

    return { items: part.items.map(toDispatchIssue), next: part.next };
  }

  public async me(signal: AbortSignal): Promise<DispatchIdentity> {
    const me = decode(
      meSchema,
      await this.get(dispatchRoutes.me(), signal),
      "identity",
    );

    return {
      userId: me.userId,
      kind: me.kind,
      agentRank: me.agentRank ?? null,
      fleetId: me.fleetId ?? null,
    };
  }

  public async fleet(
    reference: string,
    signal: AbortSignal,
  ): Promise<FleetRoster> {
    const fleet = decode(
      fleetSchema,
      await this.get(dispatchRoutes.fleet(reference), signal),
      "fleet",
    );

    return {
      id: fleet.id,
      slug: fleet.slug,
      agents: fleet.agents.map((agent) => ({
        userId: agent.userId,
        name: agent.name,
        rank: agent.rank,
        available: agent.available ?? true,
        ...(agent.ircNick && { ircNick: agent.ircNick }),
      })),
    };
  }

  public async fleetProjects(fleetId: string, signal: AbortSignal) {
    const initiatives = new Map(
      (await this.pages(dispatchRoutes.initiatives, signal)).map((item) => {
        const value = decode(initiativeSchema, item, "initiative");

        return [value.id, value] as const;
      }),
    );

    const owner = (id: string | null | undefined) => {
      const seen = new Set<string>();
      let current = id ? initiatives.get(id) : undefined;

      while (current && !seen.has(current.id)) {
        if (current.fleetId) {
          return current.fleetId;
        }

        seen.add(current.id);
        current = current.parentId
          ? initiatives.get(current.parentId)
          : undefined;
      }

      return;
    };

    const projects = new Set<string>();

    for (const item of await this.pages(dispatchRoutes.projects, signal)) {
      const project = decode(projectSchema, item, "project");

      if (owner(project.initiativeId) === fleetId) {
        projects.add(project.id);
      }
    }

    return projects;
  }

  public async assignedIssues(
    assignees: readonly string[],
    updatedSince: string | undefined,
    cursor: string | undefined,
    signal: AbortSignal,
  ) {
    if (assignees.length === 0) {
      return { items: [], next: undefined };
    }

    return this.issueListing(
      (page) => dispatchRoutes.assignedIssues(assignees, updatedSince, page),
      cursor,
      signal,
    );
  }

  public readyIssues(cursor: string | undefined, signal: AbortSignal) {
    return this.issueListing(dispatchRoutes.readyIssues, cursor, signal);
  }

  public async decisionOutcomes(
    fleetId: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<ListingPart<DecisionOutcome>> {
    const page = await this.walk(
      (next) => dispatchRoutes.decisionOutcomes(fleetId, next),
      cursor,
      1,
      signal,
    );

    return {
      items: page.items.map((item) =>
        decode(decisionOutcomeSchema, item, "decision outcome"),
      ),
      next: page.next,
    };
  }

  public async acknowledgeDecisionOutcome(
    fleetId: string,
    outcomeId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { status } = await this.request(
      "POST",
      dispatchRoutes.decisionOutcomeDelivered(fleetId, outcomeId),
      signal,
    );

    if (status !== 204) {
      throw new DispatchApiError(
        status,
        "The API refused the decision delivery receipt",
      );
    }
  }

  public async issue(reference: string, signal: AbortSignal) {
    const { status, text } = await this.request(
      "GET",
      dispatchRoutes.issue(reference),
      signal,
    );

    if (status === 404) {
      return;
    }

    if (status === 409) {
      throw new DispatchApiError(status, `The Subspace API answered ${status}`);
    }

    return toDispatchIssue(json(status, text));
  }

  private async edit(
    reference: string,
    body: IssueEdit,
    signal: AbortSignal,
  ): Promise<EditResult> {
    const { status, text } = await this.request(
      "PATCH",
      dispatchRoutes.issue(reference),
      signal,
      body,
    );

    if (status === 404) {
      throw new DispatchApiError(404, "The issue is no longer available");
    }

    if (status === 409) {
      return { conflict: true };
    }

    // A 2xx means the write was applied; an unreadable body only hides the
    // New version, which the next read supplies.
    const version = Schema.decodeUnknownResult(
      Schema.fromJsonString(Schema.Struct({ version: Schema.Finite })),
    )(text);

    return {
      conflict: false,
      version: Result.isSuccess(version) ? version.success.version : undefined,
    };
  }

  public assign(
    reference: string,
    version: number,
    assigneeId: string,
    signal: AbortSignal,
  ) {
    return this.edit(reference, issueEdit.assign(version, assigneeId), signal);
  }

  public clearReady(reference: string, version: number, signal: AbortSignal) {
    return this.edit(reference, issueEdit.clearReady(version), signal);
  }

  /** A 2xx is a recorded comment; its body is not needed. */
  public async comment(reference: string, body: string, signal: AbortSignal) {
    const { status } = await this.request(
      "POST",
      dispatchRoutes.comments(reference),
      signal,
      commentBody(body),
    );

    if (status === 404 || status === 409) {
      throw new DispatchApiError(status, "The comment was not recorded");
    }
  }
}
