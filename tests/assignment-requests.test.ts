import { expect, test } from "bun:test";
import pino from "pino";
import { AssignedWork } from "../src/coordination/fleet/dispatch/assigned-work";
import type { DispatchIssue } from "../src/coordination/fleet/dispatch/api";
import { DispatchLedger } from "../src/coordination/fleet/dispatch/ledger";
import { CAPTAIN_A, CAPTAIN_B, Clock, HOUR } from "./agent-dispatch-fixture";

const captain = { userId: CAPTAIN_A, account: "captain-a", name: "captain-a" };
const signal = new AbortController().signal;

function pending(overrides: Partial<DispatchIssue> = {}): DispatchIssue {
  return {
    id: "issue-1",
    identifier: "EX-1",
    title: "Fixture issue",
    projectId: "project",
    version: 1,
    updatedAt: "2026-11-24T00:00:00Z",
    assignee: {
      userId: CAPTAIN_A,
      kind: "agent",
      rank: "captain",
      fleetId: "fleet",
    },
    readyForAgents: false,
    stateType: "backlog",
    archived: false,
    ...overrides,
  };
}

test("assigned work waits for crew and reminds a captain only while the issue is still waiting", async () => {
  const clock = new Clock();
  const ledger = new DispatchLedger(":memory:");
  let issue = pending();

  const tracker = pending({
    id: "tracker",
    identifier: "EX-2",
    type: "tracker",
  });

  let capacity = false;
  let probes = 0;
  const asks: string[] = [];

  const work = new AssignedWork({
    api: {
      async assignedIssues(accounts, since, _cursor, _signal, waitingOnly) {
        expect(accounts).toEqual([CAPTAIN_A]);
        expect(since).toBeUndefined();
        expect(waitingOnly).toBe(true);

        return { items: [tracker, issue], next: undefined };
      },
      async issue(id) {
        expect(id).toBe(issue.id);

        return issue;
      },
    },
    requests: {
      async hasCapacity(target) {
        expect(target).toEqual(captain);
        probes++;

        return capacity;
      },
      async ask(target, ticket) {
        expect(target).toEqual(captain);
        asks.push(ticket.identifier);

        return true;
      },
    },
    ledger,
    reminderMs: 4 * HOUR,
    answerMs: HOUR / 12,
    log: pino({ level: "silent" }),
    now: clock.now,
  });

  try {
    await work.poll([captain], signal);
    expect(probes).toBe(1);
    expect(asks).toEqual([]);

    capacity = true;
    await work.poll([captain], signal);
    expect(asks).toEqual(["EX-1"]);

    clock.advance(4 * HOUR - 1);
    await work.poll([captain], signal);
    expect(probes).toBe(2);

    clock.advance(1);
    issue = { ...issue, stateType: "unstarted" };
    await work.poll([captain], signal);
    expect(asks).toEqual(["EX-1", "EX-1"]);

    clock.advance(4 * HOUR);
    issue = { ...issue, stateType: "started" };
    await work.poll([captain], signal);
    expect(asks).toHaveLength(2);
  } finally {
    ledger.close();
  }
});

test("an issue reassigned during the capacity probe is not sent to its former captain", async () => {
  const ledger = new DispatchLedger(":memory:");
  const issue = pending();
  let asked = false;

  const work = new AssignedWork({
    api: {
      async assignedIssues() {
        return { items: [issue], next: undefined };
      },
      async issue() {
        return {
          ...issue,
          assignee: {
            userId: CAPTAIN_B,
            kind: "agent",
            rank: "captain",
            fleetId: "fleet",
          },
        };
      },
    },
    requests: {
      async hasCapacity() {
        return true;
      },
      async ask() {
        asked = true;

        return true;
      },
    },
    ledger,
    reminderMs: 4 * HOUR,
    answerMs: HOUR / 12,
    log: pino({ level: "silent" }),
  });

  try {
    await work.poll([captain], signal);
    expect(
      ledger.lastAssignmentRequest(issue.id, captain.userId),
    ).toBeUndefined();
    expect(asked).toBe(false);
  } finally {
    ledger.close();
  }
});
