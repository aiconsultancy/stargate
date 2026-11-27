import { afterEach, expect, test } from "bun:test";
import pino from "pino";
import { AssignedWork } from "../src/coordination/fleet/dispatch/assigned-work";
import type { DispatchIssue } from "../src/coordination/fleet/dispatch/api";
import { DispatchLedger } from "../src/coordination/fleet/dispatch/ledger";
import {
  CAPTAIN_A,
  CAPTAIN_B,
  Clock,
  HOUR,
  MINUTE,
  answer,
  fixture,
  removeDirectories,
} from "./agent-dispatch-fixture";

afterEach(removeDirectories);

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

  const archived = pending({
    id: "archived-issue",
    identifier: "EX-2",
    archived: true,
  });

  let capacity = false;
  let probes = 0;
  const asks: string[] = [];

  const work = new AssignedWork({
    offersEnabled: true,
    api: {
      async assignedIssues(accounts, since, _cursor, _signal, filter) {
        expect(accounts).toEqual([CAPTAIN_A]);
        expect(since).toBeUndefined();
        expect(filter?.waitingOnly).toBe(true);

        return { items: [archived, issue], next: undefined };
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

        return "unconfirmed";
      },
    },
    ledger,
    reminderMs: 4 * HOUR,
    captainIntervalMs: HOUR / 12,
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
    offersEnabled: true,
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
    captainIntervalMs: HOUR / 12,
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

test("a stalled capacity check leaves other captains and Ready for agents answers free to proceed", async () => {
  const f = await fixture();
  f.api.add({
    id: "slow",
    identifier: "PRJ-1",
    assigneeId: CAPTAIN_A,
    stateType: "backlog",
  });
  f.api.add({
    id: "ready",
    identifier: "PRJ-2",
    assigneeId: CAPTAIN_B,
    stateType: "unstarted",
  });
  f.api.add({ id: "offer", identifier: "PRJ-3", readyForAgents: true });
  const slow = Promise.withResolvers<boolean>();
  const sent = Promise.withResolvers<string>();

  const work = new AssignedWork({
    offersEnabled: true,
    api: f.api,
    ledger: f.ledger,
    reminderMs: 4 * HOUR,
    captainIntervalMs: 5 * MINUTE,
    requests: {
      async hasCapacity(target) {
        return target.userId === CAPTAIN_A ? slow.promise : true;
      },
      async ask(_target, ticket) {
        sent.resolve(ticket.identifier);

        return true;
      },
    },
    log: pino({ level: "silent" }),
    now: f.clock.now,
  });

  const dispatcher = f.open(f.ledger, true, work);

  try {
    await dispatcher.step(signal);
    expect(await sent.promise).toBe("PRJ-2");
    await answer({ ...f, dispatcher }, "accept");
    expect(f.api.issues.get("offer")?.assigneeId).toBe(CAPTAIN_A);
  } finally {
    slow.resolve(false);
    await work.drain();
    f.ledger.close();
  }
});

test("a new assignment comes before reminders on an earlier page", async () => {
  const clock = new Clock();
  const ledger = new DispatchLedger(":memory:");
  const old = pending();

  const fresh = pending({
    id: "tracker-2",
    identifier: "EX-2",
    type: "tracker",
  });

  const unreadable = pending({ id: "unreadable", identifier: "EX-4" });
  const oversized = pending({ id: "issue-3", identifier: "EX-3" });
  const asked: string[] = [];
  ledger.recordAssignmentRequest(
    old.id,
    captain.userId,
    old.identifier,
    clock.now() - 5 * HOUR,
  );

  const work = new AssignedWork({
    offersEnabled: true,
    api: {
      async assignedIssues(_accounts, _since, cursor) {
        return cursor
          ? { items: [fresh], next: undefined }
          : { items: [old, unreadable, oversized], next: "next" };
      },
      async issue(id) {
        if (id === unreadable.id) {
          throw new Error("fixture read failure");
        }

        return [old, oversized, fresh].find((candidate) => candidate.id === id);
      },
    },
    ledger,
    reminderMs: 4 * HOUR,
    captainIntervalMs: 5 * MINUTE,
    requests: {
      async hasCapacity() {
        return true;
      },
      async ask(_target, ticket) {
        if (ticket.id === oversized.id) {
          return "skip";
        }

        asked.push(ticket.identifier);

        return true;
      },
    },
    log: pino({ level: "silent" }),
    now: clock.now,
  });

  try {
    await work.poll([captain], signal);
    expect(asked).toEqual([]);
    await work.poll([captain], signal);
    expect(asked).toEqual(["EX-2"]);
    expect(
      ledger.lastAssignmentRequest(oversized.id, captain.userId),
    ).toBeUndefined();
    clock.advance(6 * MINUTE);
    await work.poll([captain], signal);
    await work.poll([captain], signal);
    expect(asked).toEqual(["EX-2", "EX-1"]);
  } finally {
    ledger.close();
  }
});
