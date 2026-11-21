import { afterEach, expect, test } from "bun:test";
import type { AgentDispatcher } from "../src/dispatch/dispatcher";
import { DispatchLedger } from "../src/dispatch/ledger";
import {
  answer,
  CAPTAIN_A,
  CAPTAIN_B,
  CAPTAIN_C,
  CREW_A,
  type Fixture,
  FLEET,
  fixture,
  HOUR,
  HUMAN,
  MINUTE,
  OTHER_FLEET,
  OUTSIDE,
  REAR_ADMIRAL,
  removeDirectories,
  signal,
} from "./agent-dispatch-fixture";

afterEach(removeDirectories);

test("first start records existing assignments without sending anything", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: CAPTAIN_A });
  f.api.add({ id: "i2", identifier: "PRJ-2", assigneeId: CAPTAIN_B });
  await f.dispatcher.step(signal);
  expect(f.chat.lines).toEqual([]);
  expect(f.ledger.initialised).toBe(true);
  expect(f.ledger.notified("i1", CAPTAIN_A)).toBe(true);
  expect(f.api.calls).toContain("assigned since=-");
});

test("polls with a since-cursor and notifies a direct assignment once", async () => {
  const f = await fixture();
  f.api.add({ id: "i0", identifier: "PRJ-0", assigneeId: CAPTAIN_A });
  await f.dispatcher.step(signal);
  const cursor = f.ledger.cursor;
  expect(cursor).toBeDefined();
  f.clock.advance(2 * MINUTE);
  f.api.add({ id: "i1", identifier: "PRJ-1" });
  f.api.change("i1", { assigneeId: CAPTAIN_A });
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual(["assigned PRJ-1 -> example-captain-a"]);
  // The cursor moved to the newest server time; the query overlaps it a little.
  expect(f.ledger.cursor).toBe(f.api.issues.get("i1")?.updatedAt);
  const since = f.api.calls
    .filter((call) => call.startsWith("assigned"))
    .at(-1);
  expect(since).toBe(
    `assigned since=${new Date(Date.parse(cursor ?? "") - 5 * MINUTE).toISOString()}`,
  );
  f.clock.advance(2 * MINUTE);
  f.api.change("i1", { title: "Renamed" });
  await f.dispatcher.step(signal);
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual(["assigned PRJ-1 -> example-captain-a"]);
});

test("reassignment to a different captain notifies that captain", async () => {
  const f = await fixture();
  await f.dispatcher.step(signal);
  f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: CAPTAIN_A });
  f.clock.advance(MINUTE);
  await f.dispatcher.step(signal);
  f.clock.advance(MINUTE);
  f.api.change("i1", { assigneeId: CAPTAIN_B });
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual([
    "assigned PRJ-1 -> example-captain-a",
    "assigned PRJ-1 -> example-captain-b",
  ]);
});

test("assignments to the rear admiral, crew or people send nothing", async () => {
  const f = await fixture();
  await f.dispatcher.step(signal);
  f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: REAR_ADMIRAL });
  f.api.add({ id: "i2", identifier: "PRJ-2", assigneeId: CREW_A });
  f.api.add({ id: "i3", identifier: "PRJ-3", assigneeId: HUMAN });
  f.clock.advance(MINUTE);
  await f.dispatcher.step(signal);
  expect(f.chat.lines).toEqual([]);
});

test("an unreachable captain's notice waits for a later poll", async () => {
  const f = await fixture();
  await f.dispatcher.step(signal);
  f.chat.offline.add("example-captain-a");
  f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: CAPTAIN_A });
  f.clock.advance(MINUTE);
  await f.dispatcher.step(signal);
  expect(f.chat.lines).toEqual([]);
  f.chat.offline.delete("example-captain-a");
  f.clock.advance(HOUR);
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual(["assigned PRJ-1 -> example-captain-a"]);
});

test("offers rotate the first captain per issue and skip unavailable captains", async () => {
  const f = await fixture();
  f.api.agent(CAPTAIN_B).available = false;
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.api.add({ id: "i2", identifier: "PRJ-2", readyForAgents: true });
  f.clock.advance(MINUTE);
  await f.dispatcher.step(signal);
  f.api.add({ id: "i3", identifier: "PRJ-3", readyForAgents: true });
  f.clock.advance(MINUTE);
  await f.dispatcher.step(signal);
  // Captains in user ID order: captain-a, captain-b (unavailable), captain-c.
  expect(
    f.chat.offers().map((offer) => `${offer.issue} -> ${offer.account}`),
  ).toEqual([
    "PRJ-1 -> example-captain-a",
    "PRJ-2 -> example-captain-c",
    "PRJ-3 -> example-captain-c",
  ]);
});

test("issues outside the fleet's projects are never offered", async () => {
  const f = await fixture();
  f.api.add({
    id: "i1",
    identifier: "OUT-1",
    readyForAgents: true,
    projectId: OUTSIDE,
  });
  await f.dispatcher.step(signal);
  expect(f.chat.lines).toEqual([]);
});

test("no answer within the timeout counts as a decline", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.clock.advance(5 * MINUTE - 1);
  await f.dispatcher.tick(signal);
  expect(f.chat.offers()).toHaveLength(1);
  f.clock.advance(1);
  await f.dispatcher.tick(signal);
  await f.dispatcher.tick(signal);
  expect(f.chat.transcript()).toEqual([
    "offer PRJ-1 -> example-captain-a",
    "timeout PRJ-1",
    "offer PRJ-1 -> example-captain-b",
  ]);
});

test("fixture evidence: a flagged issue accepted by the second captain", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  await answer(f, "decline");
  f.clock.advance(MINUTE);
  await answer(f, "accept");
  expect(f.chat.transcript()).toEqual([
    "offer PRJ-1 -> example-captain-a",
    "offer PRJ-1 -> example-captain-b",
    "accepted PRJ-1",
  ]);
  expect(f.api.issues.get("i1")).toMatchObject({
    assigneeId: CAPTAIN_B,
    readyForAgents: false,
  });
  expect(f.api.edits).toEqual([
    { issue: "i1", body: { version: 1, assigneeId: CAPTAIN_B } },
  ]);
  // The acceptance is not announced again as a direct assignment.
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toHaveLength(3);
});

test("a version conflict re-reads the issue and retries the assignment", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.api.beforeAssign = (issue) => {
    issue.version += 1;
  };
  await answer(f, "accept");
  expect(f.api.issues.get("i1")?.assigneeId).toBe(CAPTAIN_A);
  expect(f.chat.statuses()).toEqual(["accepted"]);
});

test("acceptance after someone else took the issue stops and says so", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.api.beforeAssign = (issue) => {
    issue.assigneeId = HUMAN;
    issue.readyForAgents = false;
    issue.version += 1;
  };
  await answer(f, "accept");
  expect(f.api.issues.get("i1")?.assigneeId).toBe(HUMAN);
  expect(f.chat.statuses()).toEqual(["taken"]);
  await f.dispatcher.tick(signal);
  expect(f.chat.offers()).toHaveLength(1);
});

test("a failed assignment write is retried and reported once", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.api.failAssign = 2;
  await answer(f, "accept").catch(() => {});
  await f.dispatcher.tick(signal);
  expect(f.chat.statuses()).toEqual(["retrying"]);
  // A failed step waits for the next poll interval, never sooner.
  await f.dispatcher.tick(signal);
  expect(f.api.issues.get("i1")?.assigneeId).toBeNull();
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.tick(signal);
  expect(f.api.issues.get("i1")?.assigneeId).toBe(CAPTAIN_A);
  expect(f.chat.statuses()).toEqual(["retrying", "accepted"]);
});

test("ladder: rounds wait 1, 3, 6 and 12 hours from the end of the previous round", async () => {
  const f = await fixture();
  f.api.agents = f.api.agents.filter(
    (agent) => agent.userId !== CAPTAIN_B && agent.userId !== CAPTAIN_C,
  );
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  const rounds: number[] = [];
  const start = f.clock.now();
  for (let minute = 0; minute <= 23 * 60; minute++) {
    const before = f.chat.offers().length;
    await f.dispatcher.tick(signal);
    if (f.chat.offers().length > before)
      rounds.push((f.clock.now() - start) / MINUTE);
    f.clock.advance(MINUTE);
  }
  // Offers at 0 (from step), then each round 5 minutes of asking plus the wait.
  expect(rounds).toEqual([5 + 60, 65 + 5 + 180, 250 + 5 + 360, 615 + 5 + 720]);
  expect(f.chat.statuses().at(-1)).toBe("gave-up");
});

test("fixture evidence: nobody takes it, a shortened ladder ends in a comment and a cleared flag", async () => {
  const f = await fixture({ ladder: [MINUTE, 2 * MINUTE] });
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  for (let step = 0; step < 60; step++) {
    f.clock.advance(MINUTE);
    const offer = f.chat.offers().at(-1);
    if (offer && f.dispatcher && step % 7 === 0) await answer(f, "decline");
    await f.dispatcher.tick(signal);
  }
  expect(f.api.comments).toHaveLength(1);
  expect(f.api.comments[0]?.body).toContain(
    "No captain in this fleet could take this issue after 3 rounds",
  );
  expect(f.api.issues.get("i1")?.readyForAgents).toBe(false);
  expect(f.chat.offers()).toHaveLength(9);
  expect(f.chat.statuses().at(-1)).toBe("gave-up");
  expect(f.ledger.tracked("i1")?.state).toBe("done");
  // Still unflagged: the next polls do nothing.
  await f.dispatcher.step(signal);
  expect(f.chat.offers()).toHaveLength(9);
  // A person flags it again: it starts over.
  f.api.change("i1", { readyForAgents: true });
  await f.dispatcher.step(signal);
  expect(f.chat.offers()).toHaveLength(10);
});

test("an issue assigned, unflagged, closed or archived under an open offer is withdrawn", async () => {
  for (const [patch, reason] of [
    [{ assigneeId: HUMAN }, "it is now assigned"],
    [{ readyForAgents: false }, "it is no longer ready for agents"],
    [{ stateType: "completed", readyForAgents: false }, "it is closed"],
    [{ archived: true }, "it was archived"],
  ] as const) {
    const f = await fixture();
    f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
    await f.dispatcher.step(signal);
    f.api.change("i1", patch);
    f.clock.advance(MINUTE);
    await f.dispatcher.step(signal);
    const last = f.chat.lines.at(-1);
    expect(last?.kind === "status" && last.event.kind).toBe("withdrawn");
    expect(last?.kind === "status" && last.event.text).toContain(reason);
    // A late acceptance does nothing.
    await answer(f, "accept");
    expect(f.api.edits).toEqual([]);
  }
});

test("fixture evidence: a restart mid-offer keeps waiting for the same offer", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  const offer = f.chat.lastOffer();
  f.ledger.close();
  f.clock.advance(2 * MINUTE);
  const restarted = f.open();
  await restarted.step(signal);
  // No second offer after the restart, and the original answer still counts.
  expect(f.chat.offers()).toHaveLength(1);
  await restarted.answer(
    {
      account: offer.account,
      offerID: offer.offerID,
      answer: "accept",
      replyTo: offer.messageID,
      at: f.clock.now(),
    },
    signal,
  );
  expect(f.api.issues.get("i1")?.assigneeId).toBe(CAPTAIN_A);
});

test("a restart after a deadline passed moves on to the next captain", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.ledger.close();
  f.clock.advance(10 * MINUTE);
  const restarted = f.open();
  await restarted.step(signal);
  expect(f.chat.transcript()).toEqual([
    "offer PRJ-1 -> example-captain-a",
    "timeout PRJ-1",
    "offer PRJ-1 -> example-captain-b",
  ]);
});

test("untrusted or uncorrelated answers are ignored", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  const offer = f.chat.lastOffer();
  await answer(f, "accept", { account: "example-captain-b" });
  await answer(f, "accept", { replyTo: "msg-other" });
  await answer(f, "accept", { offerID: "offer-0000000000000000" });
  await answer(f, "accept", { at: f.clock.now() + 5 * MINUTE + 1 });
  await answer(f, "decline", { account: "EXAMPLE-CAPTAIN_B" });
  expect(f.api.edits).toEqual([]);
  expect(f.chat.offers()).toHaveLength(1);
  // Account names compare without case under IRC folding.
  await answer(f, "accept", { account: offer.account.toUpperCase() });
  expect(f.api.issues.get("i1")?.assigneeId).toBe(CAPTAIN_A);
  // A second answer to a finished offer changes nothing.
  await answer(f, "decline");
  expect(f.chat.statuses()).toEqual(["accepted"]);
});

test("captains whose chat account is not enrolled are never addressed", async () => {
  const f = await fixture({ enrolled: ["example-captain-b"] });
  await f.dispatcher.step(signal);
  f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: CAPTAIN_A });
  f.api.add({ id: "i2", identifier: "PRJ-2", readyForAgents: true });
  f.clock.advance(MINUTE);
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual(["offer PRJ-2 -> example-captain-b"]);
});

test("an older API without readyForAgents runs direct assignments only", async () => {
  const f = await fixture();
  f.api.legacy = true;
  f.api.add({ id: "i1", identifier: "PRJ-1" });
  await f.dispatcher.step(signal);
  f.api.change("i1", { assigneeId: CAPTAIN_A });
  f.clock.advance(MINUTE);
  await f.dispatcher.step(signal);
  expect(f.dispatcher.readyForAgentsAvailable).toBe(false);
  expect(f.chat.transcript()).toEqual(["assigned PRJ-1 -> example-captain-a"]);
  expect(f.chat.offers()).toEqual([]);
});

test("a token that is not this fleet's rear admiral turns dispatch off", async () => {
  const f = await fixture();
  f.api.identity = {
    userId: HUMAN,
    kind: "human",
    agentRank: null,
    fleetId: null,
  };
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.api.identity = {
    userId: REAR_ADMIRAL,
    kind: "agent",
    agentRank: "rearAdmiral",
    fleetId: OTHER_FLEET,
  };
  await f.dispatcher.step(signal);
  expect(f.chat.lines).toEqual([]);
  expect(f.api.calls.filter((call) => call.startsWith("assigned"))).toEqual([]);
});

test("run: polls once per interval, keeps going after a failed poll and never hot-loops", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  let advance = (_ms: number) => {};
  const f = await fixture({
    wait: async (ms) => {
      waits.push(ms);
      advance(ms);
      if (waits.length === 5) controller.abort();
    },
  });
  advance = (ms) => f.clock.advance(ms);
  const polls: number[] = [];
  f.api.beforeFleet = async () => {
    polls.push(f.clock.now());
    if (polls.length === 2) throw new Error("Subspace API unreachable");
  };
  await f.dispatcher.run(controller.signal);
  // Every pause is one poll interval, including the one after the failure.
  expect(waits).toEqual(Array(5).fill(2 * MINUTE));
  const start = polls[0] ?? 0;
  expect(polls.map((at) => (at - start) / MINUTE)).toEqual([0, 2, 4, 6, 8]);
  // The poll after the failure read assignments again.
  expect(
    f.api.calls.filter((call) => call.startsWith("assigned")),
  ).toHaveLength(4);
});

test("run: an abort during an API call stops the loop without an error", async () => {
  const f = await fixture({
    wait: async () => {
      throw new Error("no pause expected");
    },
  });
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  f.api.beforeFleet = (requestSignal) =>
    new Promise<void>((_, reject) => {
      started.resolve();
      requestSignal.addEventListener(
        "abort",
        () => reject(requestSignal.reason),
        { once: true },
      );
    });
  const running = f.dispatcher.run(controller.signal);
  await started.promise;
  controller.abort();
  await running;
  expect(f.api.calls).toEqual(["fleet example-fleet"]);
});

test("run: a pending answer wakes the pause so the next step is not late", async () => {
  const controller = new AbortController();
  const woken = Promise.withResolvers<void>();
  let pauses = 0;
  const f = await fixture({
    wait: (_ms, pauseSignal) =>
      new Promise<void>((resolve) => {
        pauses++;
        if (pauseSignal.aborted) return resolve();
        pauseSignal.addEventListener(
          "abort",
          () => {
            woken.resolve();
            resolve();
          },
          { once: true },
        );
      }),
  });
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  const running = f.dispatcher.run(controller.signal);
  while (f.chat.offers().length === 0) await Bun.sleep(1);
  await answer(f, "decline");
  await woken.promise;
  expect(f.chat.transcript()).toEqual([
    "offer PRJ-1 -> example-captain-a",
    "offer PRJ-1 -> example-captain-b",
  ]);
  controller.abort();
  await running;
  expect(pauses).toBeGreaterThanOrEqual(1);
});

test("an outage of the rear admiral's own chat connection holds the offer without using a round", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  f.chat.down = true;
  for (let poll = 0; poll < 5; poll++) {
    await f.dispatcher.step(signal);
    f.clock.advance(2 * MINUTE);
  }
  expect(f.chat.lines).toEqual([]);
  expect(f.ledger.tracked("i1")).toMatchObject({
    state: "asking",
    round: 1,
    position: 0,
  });
  f.chat.down = false;
  await f.dispatcher.step(signal);
  // The first captain is asked; nobody was skipped while the link was down.
  expect(f.chat.transcript()).toEqual(["offer PRJ-1 -> example-captain-a"]);
  expect(f.ledger.tracked("i1")?.round).toBe(1);
  await answer(f, "accept");
  expect(f.api.issues.get("i1")?.assigneeId).toBe(CAPTAIN_A);
});

test("a decline whose next offer could not be sent moves on before the old deadline", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.chat.down = true;
  await expect(answer(f, "decline")).rejects.toThrow("IRC unavailable");
  f.chat.down = false;
  f.clock.advance(MINUTE);
  await f.dispatcher.tick(signal);
  expect(f.chat.transcript()).toEqual([
    "offer PRJ-1 -> example-captain-a",
    "offer PRJ-1 -> example-captain-b",
  ]);
});

test("first start waits for the fleet's first captain before it records and notifies", async () => {
  const f = await fixture();
  const captains = f.api.agents;
  f.api.agents = captains.filter((agent) => agent.rank !== "captain");
  f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: CAPTAIN_A });
  await f.dispatcher.step(signal);
  expect(f.ledger.initialised).toBe(false);
  f.api.agents = captains;
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.step(signal);
  expect(f.ledger.initialised).toBe(true);
  expect(f.chat.lines).toEqual([]);
  f.clock.advance(2 * MINUTE);
  f.api.add({ id: "i2", identifier: "PRJ-2", assigneeId: CAPTAIN_A });
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual(["assigned PRJ-2 -> example-captain-a"]);
});

test("an older API: an open offer is withdrawn once the issue read lacks readyForAgents", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.api.legacy = true;
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.step(signal);
  expect(f.dispatcher.readyForAgentsAvailable).toBe(false);
  expect(f.chat.transcript()).toEqual([
    "offer PRJ-1 -> example-captain-a",
    "withdrawn PRJ-1",
  ]);
  expect(f.api.calls).toContain("issue i1");
  await answer(f, "accept");
  expect(f.api.edits).toEqual([]);
  // Nothing more is read or sent while the field is missing.
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.step(signal);
  expect(f.chat.lines).toHaveLength(2);
});

/** The asked captain accepts the last offer, through `dispatcher`. */
function accept(f: Fixture, dispatcher: AgentDispatcher) {
  const offer = f.chat.lastOffer();
  return dispatcher.answer(
    {
      account: offer.account,
      offerID: offer.offerID,
      answer: "accept",
      replyTo: offer.messageID,
      at: f.clock.now(),
    },
    signal,
  );
}

test("an identity without a fleet, or of another fleet, is not this fleet's rear admiral", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  for (const fleetId of [null, OTHER_FLEET]) {
    f.api.identity = { ...f.api.identity, fleetId };
    await f.dispatcher.step(signal);
  }
  expect(f.chat.lines).toEqual([]);
  expect(
    f.api.calls.filter(
      (call) => call.startsWith("assigned") || call === "ready",
    ),
  ).toEqual([]);
  f.api.identity = { ...f.api.identity, fleetId: FLEET };
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual(["offer PRJ-1 -> example-captain-a"]);
});

test("an answer after a restart writes nothing until this process confirms its API identity", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.ledger.close();
  // The restarted process holds another fleet's rear admiral credential.
  f.api.identity = { ...f.api.identity, fleetId: OTHER_FLEET };
  const ledger = new DispatchLedger(f.path);
  const restarted = f.open(ledger);
  f.api.calls.length = 0;
  await accept(f, restarted);
  // The identity is checked first; the issue is not even read.
  expect(f.api.calls).toEqual(["fleet example-fleet", "me"]);
  expect(f.api.edits).toEqual([]);
  // The acceptance is kept for a confirmed identity, not lost.
  expect(ledger.tracked("i1")).toMatchObject({ state: "accepting" });
  f.clock.advance(2 * MINUTE);
  await restarted.step(signal);
  expect(f.api.edits).toEqual([]);
  f.api.identity = { ...f.api.identity, fleetId: FLEET };
  f.clock.advance(2 * MINUTE);
  await restarted.step(signal);
  expect(f.api.issues.get("i1")?.assigneeId).toBe(CAPTAIN_A);
  expect(f.api.edits).toHaveLength(1);
  expect(f.chat.statuses()).toEqual(["accepted"]);
  ledger.close();
});

test("an answer before the first poll confirms the identity, then assigns", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.ledger.close();
  const ledger = new DispatchLedger(f.path);
  const restarted = f.open(ledger);
  f.api.calls.length = 0;
  await accept(f, restarted);
  expect(f.api.calls.slice(0, 2)).toEqual(["fleet example-fleet", "me"]);
  expect(f.api.issues.get("i1")?.assigneeId).toBe(CAPTAIN_A);
  ledger.close();
});

test("unknown fleet membership defers an offer, and after a restart is read before the acceptance write", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  // Membership cannot be read: nothing is offered rather than permitted.
  f.api.failProjects = 1;
  await f.dispatcher.step(signal);
  expect(f.chat.lines).toEqual([]);
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual(["offer PRJ-1 -> example-captain-a"]);
  f.ledger.close();
  // The issue's project left the fleet while the gateway restarted.
  f.api.fleetProjectIDs = new Set();
  const ledger = new DispatchLedger(f.path);
  const restarted = f.open(ledger);
  await accept(f, restarted);
  expect(f.api.edits).toEqual([]);
  expect(ledger.tracked("i1")).toMatchObject({
    state: "done",
    outcome: "withdrawn:moved",
  });
  expect(f.chat.statuses()).toEqual(["withdrawn"]);
  ledger.close();
});

test("membership older than one poll interval is read again before the acceptance write; a failed read defers it", async () => {
  const f = await fixture();
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  // No poll for longer than the interval; the answer is still in time.
  f.clock.advance(3 * MINUTE);
  f.api.failProjects = 1;
  await answer(f, "accept").catch(() => {});
  expect(f.api.edits).toEqual([]);
  expect(f.ledger.tracked("i1")?.state).toBe("accepting");
  // The project leaves the fleet before membership can be read again.
  f.api.fleetProjectIDs = new Set();
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.step(signal);
  expect(f.api.edits).toEqual([]);
  expect(f.ledger.tracked("i1")).toMatchObject({
    state: "done",
    outcome: "withdrawn:moved",
  });
});

test("a first start too long for one poll records existing assignments over several polls, without blocking offers", async () => {
  const f = await fixture();
  f.api.listingLimit = 2;
  for (let n = 1; n <= 5; n++)
    f.api.add({ id: `i${n}`, identifier: `PRJ-${n}`, assigneeId: CAPTAIN_A });
  f.api.add({ id: "r1", identifier: "PRJ-R", readyForAgents: true });
  await f.dispatcher.step(signal);
  expect(f.ledger.initialised).toBe(false);
  expect(f.ledger.assignmentWalk).toMatchObject({ cursor: "2" });
  // The rest of the poll is not blocked by the unfinished listing.
  expect(f.chat.transcript()).toEqual(["offer PRJ-R -> example-captain-a"]);
  // A restart goes on from the saved cursor.
  f.ledger.close();
  const ledger = new DispatchLedger(f.path);
  const restarted = f.open(ledger);
  for (let poll = 0; poll < 2; poll++) {
    f.clock.advance(2 * MINUTE);
    await restarted.step(signal);
  }
  expect(ledger.initialised).toBe(true);
  expect(ledger.assignmentWalk).toBeUndefined();
  expect(f.api.calls.filter((call) => call.startsWith("assigned"))).toEqual([
    "assigned since=-",
    "assigned since=- from=2",
    "assigned since=- from=4",
  ]);
  for (let n = 1; n <= 5; n++)
    expect(ledger.notified(`i${n}`, CAPTAIN_A)).toBe(true);
  expect(f.chat.transcript()).toEqual(["offer PRJ-R -> example-captain-a"]);
  // A later listing longer than one poll still reaches a new assignment.
  f.clock.advance(2 * MINUTE);
  f.api.add({ id: "i6", identifier: "PRJ-6", assigneeId: CAPTAIN_B });
  for (let poll = 0; poll < 4; poll++) {
    await restarted.step(signal);
    f.clock.advance(2 * MINUTE);
  }
  expect(
    f.chat.transcript().filter((line) => line.startsWith("assigned")),
  ).toEqual(["assigned PRJ-6 -> example-captain-b"]);
  ledger.close();
});
