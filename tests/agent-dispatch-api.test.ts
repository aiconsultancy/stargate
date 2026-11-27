import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DispatchApiError,
  SubspaceApi,
} from "../src/coordination/fleet/dispatch/api";
import {
  ACCESS,
  answer,
  CAPTAIN_A,
  CAPTAIN_B,
  CAPTAIN_C,
  capturedLog,
  type FetchFailure,
  FLEET,
  fixture,
  MINUTE,
  PROJECT,
  REAR_ADMIRAL,
  type RouteKind,
  removeDirectories,
  signal,
  TOKEN,
} from "./agent-dispatch-fixture";

afterEach(removeDirectories);

function client(
  f: Awaited<ReturnType<typeof fixture>>,
  env: NodeJS.ProcessEnv = { T: TOKEN, A: ACCESS },
) {
  return new SubspaceApi({
    baseUrl: "https://subspace.example.test/api/",
    tokenEnv: "T",
    headersEnv: { "X-Access-Id": "A" },
    env,
    fetch: f.http.fetch,
    timeoutMs: 20,
  });
}

test("the dispatch client uses the enrolled officer's Unix proxy without a bearer in the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-api-"));
  const socketPath = join(directory, "officer.sock");

  const server = Bun.serve({
    unix: socketPath,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/v1/me");
      expect(request.headers.has("authorization")).toBe(false);

      return Response.json({
        userId: REAR_ADMIRAL,
        kind: "agent",
        agentRank: "rearAdmiral",
        fleetId: FLEET,
      });
    },
  });

  try {
    const api = new SubspaceApi({ socketPath, env: {} });
    expect(await api.me(signal)).toEqual({
      userId: REAR_ADMIRAL,
      kind: "agent",
      agentRank: "rearAdmiral",
      fleetId: FLEET,
    });
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

/** No log line may carry a credential value or an authorisation header. */
function expectNoSecrets(lines: readonly string[]) {
  const text = lines.join("\n");
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain("Bearer ");
  expect(text.toLowerCase()).not.toContain("authorization");
}

function warnings(lines: readonly string[]) {
  return lines.flatMap((line) => {
    const entry: { level?: number; msg?: string } = JSON.parse(line);

    return entry.level === 40 && entry.msg ? [entry.msg] : [];
  });
}

test("the client sends the bearer and zero-trust headers, reads the wire shapes and never follows a redirect", async () => {
  const f = await fixture({ http: true });
  const api = client(f);
  f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: CAPTAIN_A });
  f.api.add({ id: "i2", identifier: "PRJ-2", readyForAgents: true });
  expect(await api.me(signal)).toEqual({
    userId: REAR_ADMIRAL,
    kind: "agent",
    agentRank: "rearAdmiral",
    fleetId: FLEET,
  });
  const roster = await api.fleet("example-fleet", signal);
  expect(roster.agents.map((agent) => agent.rank)).toEqual([
    "rearAdmiral",
    "captain",
    "captain",
    "captain",
    "crew",
  ]);
  expect([...(await api.fleetProjects(FLEET, signal))]).toEqual([PROJECT]);
  const since = "2026-11-21T08:00:00.000Z";

  const assigned = await api.assignedIssues(
    [CAPTAIN_A, CAPTAIN_B],
    since,
    undefined,
    signal,
  );

  expect(assigned.next).toBeUndefined();
  expect(
    assigned.items.map((issue) => [
      issue.identifier,
      issue.assignee?.kind,
      issue.assignee?.rank,
      issue.readyForAgents,
    ]),
  ).toEqual([["PRJ-1", "agent", "captain", false]]);
  expect(
    (await api.readyIssues(undefined, signal)).items.map((issue) => issue.id),
  ).toEqual(["i2"]);
  expect(await api.issue("missing", signal)).toBeUndefined();
  expect(await api.assign("i2", 1, CAPTAIN_B, signal)).toEqual({
    conflict: false,
    version: 2,
  });
  expect(await api.assign("i2", 1, CAPTAIN_C, signal)).toEqual({
    conflict: true,
  });
  await api.comment("i1", "A note.", signal);
  expect(f.api.comments).toEqual([{ issue: "i1", body: "A note." }]);

  const requests = f.http.requests.map((request) => {
    const url = new URL(`https://subspace.example.test${request.path}`);

    return `${request.method} ${url.pathname}`;
  });

  expect(requests).toEqual([
    "GET /api/v1/me",
    "GET /api/v1/fleets/example-fleet",
    "GET /api/v1/initiatives",
    "GET /api/v1/projects",
    "GET /api/v1/issues",
    "GET /api/v1/issues",
    "GET /api/v1/issues/missing",
    "PATCH /api/v1/issues/i2",
    "PATCH /api/v1/issues/i2",
    "POST /api/v1/issues/i1/comments",
  ]);

  const query = (index: number) =>
    new URL(`https://subspace.example.test${f.http.requests[index]?.path}`)
      .searchParams;

  expect(query(4).getAll("assignee")).toEqual([CAPTAIN_A, CAPTAIN_B]);
  expect(query(4).get("updatedSince")).toBe(since);
  expect(query(5).get("readyForAgents")).toBe("true");
  expect(query(5).get("assignee")).toBe("none");

  for (const request of f.http.requests) {
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get("x-access-id")).toBe(ACCESS);
    expect(request.headers.get("content-type")).toBe(
      request.method === "GET" ? null : "application/json",
    );
    expect(request.redirect).toBe("error");
  }
});

test("an issue listing longer than one call's page budget returns a cursor to go on, never an error", async () => {
  const f = await fixture({ http: true });
  const api = client(f);
  f.http.pageSize = 2;

  for (let n = 0; n < 120; n++) {
    f.api.add({ id: `i${n}`, identifier: `PRJ-${n}`, assigneeId: CAPTAIN_A });
  }

  // 50 pages of 2 per call; the API's cursor continues the listing.
  const first = await api.assignedIssues(
    [CAPTAIN_A],
    undefined,
    undefined,
    signal,
  );

  expect(first.items).toHaveLength(100);
  expect(first.next).toBe("100");

  const rest = await api.assignedIssues(
    [CAPTAIN_A],
    undefined,
    first.next,
    signal,
  );

  expect(rest.items).toHaveLength(20);
  expect(rest.next).toBeUndefined();
  expect(
    new Set([...first.items, ...rest.items].map((issue) => issue.id)).size,
  ).toBe(120);

  // Membership needs whole listings, which read past the issue budget.
  for (let n = 0; n < 120; n++) {
    f.api.fleetProjectIDs.add(`project-${n}`);
  }

  expect((await api.fleetProjects(FLEET, signal)).size).toBe(121);
});

test("a first start longer than one poll's page budget initialises over several polls and sends nothing", async () => {
  const f = await fixture({ http: true });
  f.http.pageSize = 1;

  for (let n = 0; n < 60; n++) {
    f.api.add({ id: `i${n}`, identifier: `PRJ-${n}`, assigneeId: CAPTAIN_A });
  }

  await f.dispatcher.step(signal);
  expect(f.ledger.initialised).toBe(false);
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.step(signal);
  expect(f.ledger.initialised).toBe(true);

  for (let n = 0; n < 60; n++) {
    expect(f.ledger.notified(`i${n}`, CAPTAIN_A)).toBe(true);
  }

  expect(f.chat.lines).toEqual([]);
  f.clock.advance(2 * MINUTE);
  f.api.add({ id: "new", identifier: "PRJ-NEW", assigneeId: CAPTAIN_B });
  await f.dispatcher.step(signal);
  f.clock.advance(2 * MINUTE);
  await f.dispatcher.step(signal);
  expect(f.chat.transcript()).toEqual([
    "assigned PRJ-NEW -> example-captain-b",
  ]);
});

test("a missing token or header variable fails before any request is made", async () => {
  const f = await fixture({ http: true });

  for (const env of [{ A: ACCESS }, { T: TOKEN }, { T: "  ", A: ACCESS }]) {
    const error = await client(f, env)
      .me(signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DispatchApiError);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(ACCESS);
  }

  expect(f.http.requests).toEqual([]);
});

test("every API failure is a status-only error that names no credential", async () => {
  const f = await fixture({ http: true });
  const api = client(f);

  const cases: [FetchFailure | 401 | 403, number | undefined][] = [
    ["refused", undefined],
    ["timeout", undefined],
    ["5xx", 503],
    ["malformed", 200],
    [401, 401],
    [403, 403],
  ];

  for (const [failure, status] of cases) {
    f.http.failures.clear();
    f.http.credentialStatus = undefined;

    if (typeof failure === "number") {
      f.http.credentialStatus = failure;
    } else {
      f.http.failures.set("fleet", failure);
    }

    const error = await api
      .fleet("example-fleet", signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DispatchApiError);

    if (!(error instanceof DispatchApiError)) {
      throw new Error("unexpected");
    }

    expect(error.status).toBe(status);

    for (const text of [error.message, JSON.stringify(error), String(error)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(ACCESS);
    }
  }
});

test("the caller's abort cancels a request with an abort, not an API error", async () => {
  const f = await fixture({ http: true });

  const api = new SubspaceApi({
    baseUrl: "https://subspace.example.test",
    tokenEnv: "T",
    headersEnv: { "X-Access-Id": "A" },
    env: { T: TOKEN, A: ACCESS },
    fetch: f.http.fetch,
    timeoutMs: 60_000,
  });

  f.http.failures.set("me", "timeout");
  const controller = new AbortController();
  const pending = api.me(controller.signal).catch((caught: unknown) => caught);
  controller.abort();
  const error = await pending;
  expect(error).not.toBeInstanceOf(DispatchApiError);
  expect(controller.signal.aborted).toBe(true);
});

test("an older API's issues decode with readyForAgents unknown, in lists and single reads", async () => {
  const f = await fixture({ http: true });
  const api = client(f);
  f.api.legacy = true;
  f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: CAPTAIN_A });
  f.api.add({ id: "i2", identifier: "PRJ-2" });

  const [assigned] = (
    await api.assignedIssues([CAPTAIN_A], undefined, undefined, signal)
  ).items;

  const [listed] = (await api.readyIssues(undefined, signal)).items;
  const single = await api.issue("i2", signal);

  for (const issue of [assigned, listed, single]) {
    expect(issue).toBeDefined();
    expect(issue?.readyForAgents).toBeUndefined();
  }

  expect(single?.identifier).toBe("PRJ-2");
});

test("a write's 2xx counts even with an unreadable body; a 409 is a lost race", async () => {
  const f = await fixture({ http: true });
  const api = client(f);
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  f.http.failures.set("assign", "malformed");
  expect(await api.assign("i1", 1, CAPTAIN_A, signal)).toEqual({
    conflict: false,
    version: undefined,
  });
  expect(f.api.issues.get("i1")?.assigneeId).toBe(CAPTAIN_A);
  f.http.failures.clear();
  expect(await api.clearReady("i1", 1, signal)).toEqual({ conflict: true });
  f.http.failures.set("comment", "malformed");
  await api.comment("i1", "Recorded.", signal);
  expect(f.api.comments).toHaveLength(1);
});

const reads: RouteKind[] = [
  "me",
  "fleet",
  "initiatives",
  "projects",
  "assigned",
  "ready",
  "issue",
];

for (const mode of ["refused", "timeout", "5xx", "malformed"] as const) {
  test(`API ${mode} during each kind of poll: no crash, no duplicate notice, ledger intact, recovers`, async () => {
    for (const route of reads) {
      const { log, lines } = capturedLog();
      const f = await fixture({ http: true, log });
      f.api.add({ id: "i0", identifier: "PRJ-0", assigneeId: CAPTAIN_A });

      if (route === "me") {
        // Identity is confirmed once per process, before anything else.
        f.http.failures.set("me", mode);

        for (let poll = 0; poll < 2; poll++) {
          await f.dispatcher.step(signal);
          f.clock.advance(2 * MINUTE);
        }

        expect(f.ledger.initialised).toBe(false);
        expect(f.chat.lines).toEqual([]);
        f.http.failures.clear();
      }

      await f.dispatcher.step(signal);
      expect(f.ledger.initialised).toBe(true);
      f.clock.advance(2 * MINUTE);
      f.api.add({ id: "i1", identifier: "PRJ-1", assigneeId: CAPTAIN_B });
      f.api.add({ id: "i2", identifier: "PRJ-2", readyForAgents: true });

      if (route !== "me") {
        f.http.failures.set(route, mode);
      }

      for (let poll = 0; poll < 2; poll++) {
        await f.dispatcher.step(signal);
        f.clock.advance(2 * MINUTE);
      }

      const during = f.chat.transcript();
      expect(new Set(during).size).toBe(during.length);
      f.http.failures.clear();
      await f.dispatcher.step(signal);
      expect([...f.chat.transcript()].sort()).toEqual([
        "assigned PRJ-1 -> example-captain-b",
        "offer PRJ-2 -> example-captain-a",
      ]);
      // First start recorded the older assignment; it was never announced.
      expect(f.ledger.notified("i0", CAPTAIN_A)).toBe(true);
      expect(f.ledger.notified("i1", CAPTAIN_B)).toBe(true);
      expect(f.ledger.active().map((tracked) => tracked.issue)).toEqual(["i2"]);
      expect(f.ledger.tracked("i2")).toMatchObject({
        state: "asking",
        round: 1,
        position: 0,
      });
      // Each problem is logged once, however many polls it lasts.
      const warned = warnings(lines);
      expect(warned.length).toBeGreaterThan(0);
      expect(new Set(warned).size).toBe(warned.length);
      expectNoSecrets(lines);
      f.ledger.close();
    }
  });
}

for (const mode of [
  "refused",
  "timeout",
  "5xx",
  "malformed",
  "lost",
] as const) {
  test(`API ${mode} during the acceptance write: one assignment, no duplicate notice`, async () => {
    const { log, lines } = capturedLog();
    const f = await fixture({ http: true, log });
    f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
    await f.dispatcher.step(signal);
    f.http.failures.set("assign", mode);
    await answer(f, "accept").catch(() => {});
    f.http.failures.clear();
    // A second copy of the same answer changes nothing.
    await answer(f, "accept").catch(() => {});
    f.clock.advance(2 * MINUTE);
    await f.dispatcher.step(signal);
    f.clock.advance(2 * MINUTE);
    await f.dispatcher.step(signal);
    expect(f.api.issues.get("i1")).toMatchObject({
      assigneeId: CAPTAIN_A,
      readyForAgents: false,
    });
    expect(
      f.api.edits.filter((edit) => "assigneeId" in edit.body),
    ).toHaveLength(1);
    // A 2xx is the outcome even when its body cannot be read.
    expect(f.chat.statuses()).toEqual(
      mode === "malformed" ? ["accepted"] : ["retrying", "accepted"],
    );
    expect(f.chat.transcript()).toEqual(
      mode === "malformed"
        ? ["offer PRJ-1 -> example-captain-a", "accepted PRJ-1"]
        : [
            "offer PRJ-1 -> example-captain-a",
            "retrying PRJ-1",
            "accepted PRJ-1",
          ],
    );
    expect(f.ledger.tracked("i1")).toMatchObject({
      state: "done",
      outcome: "accepted",
    });
    expectNoSecrets(lines);
  });
}

/** One round with one available captain, then give up. */
async function giveUpFixture(log: ReturnType<typeof capturedLog>["log"]) {
  const f = await fixture({ http: true, log, ladder: [] });
  f.api.agent(CAPTAIN_B).available = false;
  f.api.agent(CAPTAIN_C).available = false;
  f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
  await f.dispatcher.step(signal);
  f.clock.advance(5 * MINUTE);

  return f;
}

for (const write of ["comment", "clear"] as const) {
  for (const mode of [
    "refused",
    "timeout",
    "5xx",
    "malformed",
    "lost",
  ] as const) {
    // A lost answer to the comment can repeat it; docs/agent-dispatch.md.
    if (write === "comment" && mode === "lost") {
      continue;
    }

    test(`API ${mode} during the give-up ${write}: one comment, flag cleared, one chat line`, async () => {
      const { log, lines } = capturedLog();
      const f = await giveUpFixture(log);
      f.http.failures.set(write, mode);
      await f.dispatcher.tick(signal);
      f.http.failures.clear();

      for (let poll = 0; poll < 2; poll++) {
        f.clock.advance(2 * MINUTE);
        await f.dispatcher.step(signal);
      }

      expect(f.api.comments).toHaveLength(1);
      expect(f.api.issues.get("i1")?.readyForAgents).toBe(false);
      expect(f.chat.statuses()).toEqual(["timeout", "gave-up"]);
      expect(f.ledger.tracked("i1")).toMatchObject({
        state: "done",
        outcome: "gave-up",
      });
      expectNoSecrets(lines);
    });
  }
}

for (const status of [401, 403] as const) {
  test(`a refused credential (${status}) is logged once and plainly, without spinning or leaking`, async () => {
    const { log, lines } = capturedLog();
    const controller = new AbortController();
    const waits: number[] = [];
    let advance = (_ms: number) => {};

    const f = await fixture({
      http: true,
      log,
      wait: async (ms) => {
        waits.push(ms);
        advance(ms);

        if (waits.length === 3) {
          controller.abort();
        }
      },
    });

    advance = (ms) => f.clock.advance(ms);
    f.api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
    f.http.credentialStatus = status;
    await f.dispatcher.run(controller.signal);
    // One roster read per poll interval; nothing else is tried.
    expect(waits).toEqual([2 * MINUTE, 2 * MINUTE, 2 * MINUTE]);
    expect(f.http.requests.map((request) => request.path)).toEqual(
      Array(3).fill("/api/v1/fleets/example-fleet"),
    );

    const refused = lines.filter((line) =>
      line.includes("refused the rear admiral's credential"),
    );

    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0] ?? "{}")).toMatchObject({ level: 40, status });
    expectNoSecrets(lines);
    expect(f.chat.lines).toEqual([]);
    // A replaced credential is picked up by the next poll.
    f.http.credentialStatus = undefined;
    await f.dispatcher.step(signal);
    expect(f.chat.transcript()).toEqual(["offer PRJ-1 -> example-captain-a"]);
  });
}

for (const variant of ["field missing", "filter refused"] as const) {
  test(`an older API (${variant}): direct assignments only, logged once`, async () => {
    const { log, lines } = capturedLog();
    const f = await fixture({ http: true, log });
    f.api.legacy = true;
    f.http.rejectReadyFilter = variant === "filter refused";
    f.api.add({ id: "i1", identifier: "PRJ-1" });

    for (let poll = 0; poll < 4; poll++) {
      await f.dispatcher.step(signal);
      f.clock.advance(2 * MINUTE);
    }

    f.api.change("i1", { assigneeId: CAPTAIN_A });
    await f.dispatcher.step(signal);
    expect(f.dispatcher.readyForAgentsAvailable).toBe(false);
    expect(f.chat.transcript()).toEqual([
      "assigned PRJ-1 -> example-captain-a",
    ]);

    const notice = lines.filter((line) =>
      line.includes("round robin offers of ready issues are unavailable"),
    );

    expect(notice).toHaveLength(1);
    // Once detected, the ready list is not asked for again.
    expect(
      f.http.requests.filter((request) =>
        request.path.includes("readyForAgents"),
      ),
    ).toHaveLength(1);
  });
}
