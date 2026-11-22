/**
 * Every Subspace API route and query spelling that agent dispatch uses, in
 * one place. Both API implementations serve the same JSON under `/api/v1`.
 */
const prefix = "/api/v1";
const segment = (value: string) => encodeURIComponent(value);

export const pageLimit = 100;

export const dispatchRoutes = {
  /** The authenticated identity: the rear admiral agent. */
  me: () => `${prefix}/me`,
  /** A fleet by slug or UUID, with its agents' rank and availability. */
  fleet: (reference: string) => `${prefix}/fleets/${segment(reference)}`,
  initiatives: (cursor?: string) => `${prefix}/initiatives?${page(cursor)}`,
  projects: (cursor?: string) => `${prefix}/projects?${page(cursor)}`,
  /** Behaviour 1: issues assigned to these agents, changed since a time. */
  assignedIssues: (
    assignees: readonly string[],
    updatedSince: string | undefined,
    cursor?: string,
  ) => {
    const query = new URLSearchParams();

    for (const id of assignees) query.append("assignee", id);

    if (updatedSince !== undefined) query.set("updatedSince", updatedSince);

    return `${prefix}/issues?${query.toString()}&${page(cursor)}`;
  },
  /** Behaviour 2: unassigned issues flagged Ready for agents. */
  readyIssues: (cursor?: string) => {
    const query = new URLSearchParams({
      readyForAgents: "true",
      assignee: "none",
    });

    return `${prefix}/issues?${query.toString()}&${page(cursor)}`;
  },
  /** One issue by UUID or identifier; PATCH it with `version` to edit. */
  issue: (reference: string) => `${prefix}/issues/${segment(reference)}`,
  comments: (reference: string) =>
    `${prefix}/issues/${segment(reference)}/comments`,
} as const;

/** Body fields of the versioned issue edit. */
export const issueEdit = {
  assign: (version: number, assigneeId: string) => ({ version, assigneeId }),
  clearReady: (version: number) => ({ version, readyForAgents: false }),
} as const;

export const commentBody = (body: string) => ({ body });

function page(cursor: string | undefined) {
  const query = new URLSearchParams({ limit: String(pageLimit) });

  if (cursor !== undefined) query.set("cursor", cursor);

  return query.toString();
}
