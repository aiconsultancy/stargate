import { expect, test } from "bun:test";
import {
  connectHistoryAPI,
  historyVisible,
} from "../src/coordination/crew/history/api";
import { defaultTeam, profileTeam } from "../src/coordination/crew/team";

test("history scope excludes other teams and requires explicit project access", () => {
  const options = {
    team: defaultTeam,
    namespace: "one",
    captainDirectory: "/captain",
    projectDirectory: "/project",
    worktrees: { mario: "/crew/mario" },
  };

  const session = {
    id: "ses_captain",
    agent: "bowser",
    location: { directory: "/captain" },
  };

  expect(historyVisible(options, null, session)).toBe(true);

  const prior = {
    ...session,
    id: "ses_prior",
    agent: "build",
    location: { directory: "/project" },
  };

  expect(historyVisible(options, null, prior)).toBe(false);

  const project = {
    ...options,
    team: { ...defaultTeam, historyScope: "project" as const },
  };

  expect(historyVisible(project, null, prior)).toBe(true);
  expect(
    historyVisible(project, null, {
      ...prior,
      metadata: { stargateCrew: { namespace: "other" } },
    }),
  ).toBe(false);
  expect(
    historyVisible(project, null, {
      ...prior,
      location: { directory: "/project-other" },
    }),
  ).toBe(false);

  const peer = {
    crewID: "mario",
    sessionID: "ses_mario",
    status: "ready" as const,
  };

  const worker = {
    ...prior,
    id: peer.sessionID,
    agent: "mario",
    location: { directory: "/crew/mario" },
    metadata: { stargateCrew: { namespace: "one", crewID: "mario" } },
  };

  expect(historyVisible(options, peer, worker)).toBe(true);
  const mapped = { ...options, team: profileTeam(defaultTeam, "ship") };
  expect(historyVisible(mapped, null, session)).toBe(true);
  expect(
    historyVisible(mapped, null, { ...session, agent: "ship-captain-bowser" }),
  ).toBe(true);
  expect(historyVisible(mapped, peer, worker)).toBe(true);
  expect(
    historyVisible(mapped, peer, { ...worker, agent: "ship-crew-mario" }),
  ).toBe(true);
  expect(historyVisible(mapped, peer, { ...worker, id: "foreign" })).toBe(
    false,
  );
  expect(
    historyVisible(mapped, peer, {
      ...worker,
      metadata: { stargateCrew: { namespace: "other", crewID: "mario" } },
    }),
  ).toBe(false);
  expect(historyVisible(options, peer, { ...worker, agent: "bowser" })).toBe(
    false,
  );
});

test("server history scope includes other namespaces, workers and projects", () => {
  const base = {
    namespace: "one",
    captainDirectory: "/captain",
    projectDirectory: "/project",
    worktrees: { mario: "/crew/mario" },
  };

  const peer = {
    crewID: "mario",
    sessionID: "worker",
    status: "ready" as const,
  };

  const candidates = [
    {
      id: "other-team",
      agent: "other-captain",
      location: { directory: "/project" },
      metadata: { stargateCrew: { namespace: "other" } },
    },
    {
      id: "worker-child",
      parentID: "other-root",
      agent: "other-worker",
      location: { directory: "/crew/other-worker" },
      metadata: {
        stargateCrew: { namespace: "other", crewID: "other-worker" },
      },
    },
    {
      id: "other-project",
      agent: "build",
      location: { directory: "/unrelated-project" },
    },
  ];

  for (const candidate of candidates) {
    for (const caller of [null, peer]) {
      expect(
        historyVisible({ ...base, team: defaultTeam }, caller, candidate),
      ).toBe(false);
      expect(
        historyVisible(
          { ...base, team: { ...defaultTeam, historyScope: "project" } },
          caller,
          candidate,
        ),
      ).toBe(false);
      expect(
        historyVisible(
          { ...base, team: { ...defaultTeam, historyScope: "server" } },
          caller,
          candidate,
        ),
      ).toBe(true);
    }
  }
});

test("history uses authenticated API and rejects a server with a different caller identity", async () => {
  const session = {
    id: "ses_captain",
    agent: "bowser",
    location: { directory: "/captain" },
  };

  let directory = "/captain";
  let authenticated = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      authenticated =
        request.headers.get("authorization") === "Bearer fixture-only";

      return Response.json({ data: { ...session, location: { directory } } });
    },
  });

  const envName = "STARGATE_HISTORY_FIXTURE_AUTH";
  const previous = process.env[envName];
  process.env[envName] = "Bearer fixture-only";

  try {
    const team = {
      ...defaultTeam,
      historyAPI: {
        url: server.url.href,
        headersEnv: { authorization: envName },
      },
    };

    await connectHistoryAPI(team, session, new AbortController().signal);
    expect(authenticated).toBe(true);
    directory = "/unrelated";
    await expect(
      connectHistoryAPI(team, session, new AbortController().signal),
    ).rejects.toThrow("same OpenCode server");
    delete process.env[envName];
    await expect(
      connectHistoryAPI(team, session, new AbortController().signal),
    ).rejects.toThrow("environment");
  } finally {
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }

    await server.stop(true);
  }
});
