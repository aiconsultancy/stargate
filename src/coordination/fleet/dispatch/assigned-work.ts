import type { Logger } from "pino";
import { type DispatchApi, DispatchApiError, type DispatchIssue } from "./api";
import type { DispatchLedger } from "./ledger";
import type { CaptainRef } from "./protocol";

export interface AssignmentRequests {
  hasCapacity(captain: CaptainRef, signal: AbortSignal): Promise<boolean>;
  ask(
    captain: CaptainRef,
    issue: DispatchIssue,
    signal: AbortSignal,
  ): Promise<boolean>;
}

function waiting(issue: DispatchIssue) {
  return (
    issue.type !== "tracker" &&
    !issue.archived &&
    (issue.stateType === "backlog" || issue.stateType === "unstarted")
  );
}

export class AssignedWork {
  private cursor: string | undefined;
  private rosterKey: string | undefined;

  public constructor(
    private readonly options: {
      api: Pick<DispatchApi, "assignedIssues" | "issue">;
      ledger: DispatchLedger;
      requests: AssignmentRequests;
      reminderMs: number;
      answerMs: number;
      log: Logger;
      now?: () => number;
    },
  ) {}

  public async poll(captains: readonly CaptainRef[], signal: AbortSignal) {
    const {
      api,
      ledger,
      requests,
      reminderMs,
      answerMs,
      log,
      now = Date.now,
    } = this.options;

    const byId = new Map(captains.map((captain) => [captain.userId, captain]));
    const ids = [...byId.keys()].toSorted();
    const rosterKey = JSON.stringify(ids);

    if (rosterKey !== this.rosterKey) {
      this.rosterKey = rosterKey;
      this.cursor = undefined;
    }

    if (ids.length === 0) {
      return;
    }

    const page = await api
      .assignedIssues(ids, undefined, this.cursor, signal, true)
      .catch((error: unknown) => {
        if (
          this.cursor &&
          error instanceof DispatchApiError &&
          error.status === 400
        ) {
          this.cursor = undefined;

          return api.assignedIssues(ids, undefined, undefined, signal, true);
        }

        throw error;
      });

    this.cursor = page.next;
    const checked = new Set<string>();

    for (const issue of page.items) {
      signal.throwIfAborted();

      const user =
        issue.assignee?.kind === "agent" ? issue.assignee.userId : undefined;

      const captain = user ? byId.get(user) : undefined;

      if (!captain || checked.has(captain.userId) || !waiting(issue)) {
        continue;
      }

      const last = ledger.lastAssignmentRequest(issue.id, captain.userId);
      const recent = ledger.lastRequestForCaptain(captain.userId);
      const offer = ledger.tracked(issue.id);

      if (
        (last !== undefined && now() - last < reminderMs) ||
        (recent !== undefined && now() - recent < answerMs) ||
        (offer?.state === "accepting" &&
          offer.offer?.captain === captain.userId)
      ) {
        continue;
      }

      checked.add(captain.userId);

      try {
        if (!(await requests.hasCapacity(captain, signal))) {
          continue;
        }

        const current = await api.issue(issue.id, signal);

        if (
          current &&
          waiting(current) &&
          current.assignee?.kind === "agent" &&
          current.assignee.userId === captain.userId &&
          (await requests.ask(captain, current, signal))
        ) {
          ledger.recordAssignmentRequest(
            current.id,
            captain.userId,
            current.identifier,
            now(),
          );
        }
      } catch {
        signal.throwIfAborted();
        log.warn(
          { issue: issue.identifier },
          "Assigned work request can be retried",
        );
      }
    }
  }
}
