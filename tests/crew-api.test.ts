import { expect, test } from "bun:test";
import { connectHistoryAPI, historyVisible } from "../src/crew/api";
import { defaultTeam } from "../src/crew/team";

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
      metadata: { pogoCrew: { namespace: "other" } },
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
    metadata: { pogoCrew: { namespace: "one", crewID: "mario" } },
  };
  expect(historyVisible(options, peer, worker)).toBe(true);
  expect(historyVisible(options, peer, { ...worker, agent: "bowser" })).toBe(
    false,
  );
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
  const envName = "POGO_HISTORY_FIXTURE_AUTH";
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
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await server.stop(true);
  }
});
