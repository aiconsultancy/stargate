import type { Logger } from "pino";
import { type DispatchApi, DispatchApiError, type DispatchIssue } from "./api";
import type { DispatchLedger } from "./ledger";
import { type CaptainRef, isMarkerIssue } from "./protocol";

export interface AssignmentRequests {
  hasCapacity(captain: CaptainRef, signal: AbortSignal): Promise<boolean>;
  ask(
    captain: CaptainRef,
    issue: DispatchIssue,
    signal: AbortSignal,
  ): Promise<boolean | "skip">;
}

function waiting(issue: DispatchIssue) {
  return (
    isMarkerIssue(issue.identifier) &&
    issue.type !== "tracker" &&
    !issue.archived &&
    (issue.stateType === "backlog" || issue.stateType === "unstarted")
  );
}

const capacityChecksAtOnce = 4;

type Candidate = { issue: DispatchIssue; priority: number };

export class AssignedWork {
  private running: Promise<void> | undefined;
  private cursor: string | undefined;
  private rosterKey: string | undefined;

  public constructor(
    private readonly options: {
      api: Pick<DispatchApi, "assignedIssues" | "issue">;
      ledger: DispatchLedger;
      requests: AssignmentRequests;
      reminderMs: number;
      answerMs: number;
      readyOffers?: boolean;
      log: Logger;
      now?: () => number;
    },
  ) {}

  public start(captains: readonly CaptainRef[], signal: AbortSignal) {
    if (this.running || signal.aborted) {
      return;
    }

    this.running = this.poll(captains, signal)
      .catch((error: unknown) => {
        if (!signal.aborted) {
          this.options.log.warn(
            {
              status:
                error instanceof DispatchApiError ? error.status : undefined,
            },
            "Agent dispatch could not read assigned work",
          );
        }
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  public async drain() {
    await this.running;
  }

  public async poll(captains: readonly CaptainRef[], signal: AbortSignal) {
    const { api, ledger, reminderMs, answerMs, now = Date.now } = this.options;

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

    const candidates = new Map<CaptainRef, Candidate[]>();

    for (const issue of page.items) {
      signal.throwIfAborted();

      const user =
        issue.assignee?.kind === "agent" ? issue.assignee.userId : undefined;

      const captain = user ? byId.get(user) : undefined;

      if (!captain || !waiting(issue)) {
        continue;
      }

      const last = ledger.lastAssignmentRequest(issue.id, captain.userId);
      const recent = ledger.lastRequestForCaptain(captain.userId);
      const offer = ledger.tracked(issue.id);

      if (
        (last !== undefined && now() - last < reminderMs) ||
        (recent !== undefined && now() - recent < answerMs) ||
        (this.options.readyOffers !== false &&
          offer?.state === "accepting" &&
          offer.offer?.captain === captain.userId)
      ) {
        continue;
      }

      const priority = last ?? Number.NEGATIVE_INFINITY;
      const queue = candidates.get(captain) ?? [];
      queue.push({ issue, priority });
      candidates.set(captain, queue);
    }

    const pending = candidates.entries();
    await Promise.all(
      Array.from(
        { length: Math.min(capacityChecksAtOnce, candidates.size) },
        async () => {
          for (const [captain, queue] of pending) {
            await this.request(captain, queue, signal);
          }
        },
      ),
    );
  }

  private async request(
    captain: CaptainRef,
    queue: Candidate[],
    signal: AbortSignal,
  ) {
    const { api, ledger, requests, log, now = Date.now } = this.options;

    try {
      if (signal.aborted || !(await requests.hasCapacity(captain, signal))) {
        return;
      }

      queue.sort((a, b) => a.priority - b.priority);

      for (const { issue } of queue) {
        signal.throwIfAborted();
        const current = await api.issue(issue.id, signal);

        if (
          !current ||
          !waiting(current) ||
          current.assignee?.kind !== "agent" ||
          current.assignee.userId !== captain.userId
        ) {
          continue;
        }

        const sent = await requests.ask(captain, current, signal);

        if (sent === "skip") {
          continue;
        }

        if (sent) {
          ledger.recordAssignmentRequest(
            current.id,
            captain.userId,
            current.identifier,
            now(),
          );
        }

        return;
      }
    } catch {
      if (!signal.aborted) {
        log.warn(
          { captain: captain.userId },
          "Assigned work request can be retried",
        );
      }
    }
  }
}
