import { afterEach, expect, test } from "bun:test";
import type { AgentBackend } from "../src/backend";
import type { CrewStatus } from "../src/crew-status";
import { CronStore } from "../src/cron-store";
import type { DashboardTransport } from "../src/dashboard-model";
import {
  dashboardCrewMembers,
  dashboardCrewSummary,
} from "../src/dashboard-projection";
import { type DashboardShip, dashboardSource } from "../src/dashboard-source";
import { conversationKey } from "../src/routing";
import { Store } from "../src/store";
import { bot } from "./fixtures";

const cleanup: { close(): unknown }[] = [];
afterEach(() => {
  for (const store of cleanup.splice(0)) store.close();
});
const signal = new AbortController().signal;
const task = {
  id: "active-task",
  status: "running" as const,
  kind: "assignment" as const,
  summary: "Fixture work",
  phase: "building",
  progress: "Local checks",
  createdAt: 1,
  startedAt: 1,
  updatedAt: 2,
  finishedAt: null,
};
function roster(): CrewStatus {
  return {
    total: 20,
    busy: 2,
    truncated: false,
    members: ["default", "desktop", "api", "irc", "gateway"].flatMap(
      (project) =>
        ["stamets", "reno", "tilly", "adira"].map((id) => ({
          id,
          name: id,
          project,
          backend: "opencode" as const,
          provisioned:
            id === "stamets" ? ("ready" as const) : ("unprovisioned" as const),
          observed: false,
          current:
            id === "stamets" && ["desktop", "api"].includes(project)
              ? { ...task, id: `${project}-active` }
              : null,
          queuedCount: project === "gateway" && id === "tilly" ? 1 : 0,
          queued:
            project === "gateway" && id === "tilly"
              ? [{ ...task, id: "queued", status: "queued" as const }]
              : [],
          lastOutcome:
            project === "irc" && id === "adira"
              ? { ...task, id: "old", status: "completed" as const }
              : null,
          recent:
            project === "irc" && id === "adira"
              ? [{ ...task, id: "old", status: "completed" as const }]
              : [],
          recentCount: project === "irc" && id === "adira" ? 1 : 0,
        })),
    ),
  };
}

test("four people retain twenty project contexts and independent active/history rows", () => {
  const status = roster();
  const snapshot = JSON.stringify(status);
  const people = dashboardCrewMembers(status);
  expect(people).toHaveLength(4);
  expect(people.every((person) => person.contexts.length === 5)).toBe(true);
  expect(people[0]?.contexts.filter((context) => context.current)).toHaveLength(
    2,
  );
  expect(people[2]?.contexts.flatMap((context) => context.queued)).toHaveLength(
    1,
  );
  expect(people[3]?.contexts.flatMap((context) => context.recent)).toHaveLength(
    1,
  );
  expect(dashboardCrewSummary(status)).toEqual({
    total: 20,
    busy: 2,
    people: { total: 4, busy: 1 },
  });
  expect(JSON.stringify(status)).toBe(snapshot);
  expect(
    dashboardCrewSummary({ ...status, total: 40, truncated: true }).people,
  ).toEqual({ total: 4, busy: 1, partial: true });
});

function transport(
  kind: "irc" | "teams",
  tenant = "tenant-a",
): DashboardTransport {
  return kind === "teams"
    ? { kind, tenantId: tenant, botClientId: `app-${tenant}` }
    : {
        kind,
        host: "irc.example.test",
        port: 6697,
        tls: true,
        account: "captain",
        nick: "captain",
        channels: ["#ship"],
        access: { deniedAccounts: [], deniedChannels: [], peerCaptains: [] },
      };
}
function registration(
  id: string,
  kind: "irc" | "teams",
  tenant = "tenant-a",
  url = "http://127.0.0.1:4101",
): DashboardShip {
  const config = bot(id);
  config.backend = {
    type: "opencode",
    url,
    directory: "/project/shared",
    sessionID: "ses_shared",
    headersEnv: {},
    permissions: [],
  };
  const backend: AgentBackend = {
    sessionID: "ses_shared",
    async createSession() {
      throw new Error("No dashboard session creation");
    },
    async prompt() {
      throw new Error("No dashboard model work");
    },
    async close() {},
    async crewStatus() {
      return roster();
    },
    history: {
      async roots() {
        return [];
      },
      async describe(ids) {
        return ids.map((session) => ({
          id: session,
          harness: "opencode" as const,
          kind: "conversation" as const,
        }));
      },
      async children() {
        return { sessions: [] };
      },
      async entries({ sessionID }) {
        return {
          entries: [
            {
              id: "entry",
              role: "assistant" as const,
              parts: [{ type: "text" as const, text: sessionID }],
            },
          ],
        };
      },
    },
  };
  return {
    bot: config,
    backend,
    transport: transport(kind, tenant),
    key: `${kind}:${tenant}:${id}`,
    identity: { team: tenant, user: id },
  };
}

test("shared captain display keeps both registration aliases and never unions conversation scope", async () => {
  const store = new Store(":memory:");
  const cron = new CronStore(":memory:");
  cleanup.push(store, cron);
  const irc = registration("captain", "irc");
  const teams = registration("captain-teams", "teams");
  for (const ship of [irc, teams]) {
    const conversation = conversationKey(ship.key, "channel", "thread");
    store.enqueue({
      botKey: ship.key,
      conversation,
      eventId: ship.key,
      channel: "channel",
      thread: "thread",
      user: "human",
      text: "not returned",
    });
    store.saveSession(conversation, `ses_${ship.bot.id}_only`);
  }
  const source = dashboardSource([teams, irc], store, cron);
  const fleet = await source.fleet(signal);
  expect(fleet.ships).toHaveLength(2);
  expect(fleet.ships[0]?.captain?.key).toBe(fleet.ships[1]?.captain?.key);
  expect(fleet.ships[0]?.captain?.id).toBe("captain");
  expect(
    fleet.ships[0]?.captain?.registrations.map((value) => value.id),
  ).toEqual(["captain", "captain-teams"]);
  expect((await source.ship("captain-teams", signal))?.id).toBe(
    "captain-teams",
  );
  expect((await source.ship("captain", signal))?.crewMembers).toHaveLength(4);
  const input = {
    sessionID: "ses_captain-teams_only",
    order: "desc" as const,
    detail: "summary" as const,
    limit: 30,
  };
  expect(await source.entries("captain", input, signal)).toBeUndefined();
  expect(
    await source.entries(
      "captain-teams",
      { ...input, sessionID: "ses_captain_only" },
      signal,
    ),
  ).toBeUndefined();
  expect(
    await source.entries(
      "captain",
      { ...input, sessionID: "ses_shared" },
      signal,
    ),
  ).toBeDefined();
});

test("different tenants, endpoints or unpinned backends never acquire a display alias", async () => {
  const store = new Store(":memory:");
  const cron = new CronStore(":memory:");
  cleanup.push(store, cron);
  for (const ships of [
    [
      registration("team-a", "teams", "tenant-a"),
      registration("team-b", "teams", "tenant-b"),
    ],
    [
      registration("irc", "irc"),
      registration("teams", "teams", "tenant-a", "http://127.0.0.1:4102"),
    ],
    [
      registration("irc", "irc"),
      registration("team-a", "teams", "tenant-a"),
      registration("team-b", "teams", "tenant-b"),
    ],
  ])
    expect(
      (await dashboardSource(ships, store, cron).fleet(signal)).ships.every(
        (ship) => !ship.captain,
      ),
    ).toBe(true);
  const original = registration("teams", "teams");
  const unpinned = {
    ...original,
    backend: { ...original.backend, sessionID: undefined },
  };
  const ships = [registration("irc", "irc"), unpinned];
  expect(
    (await dashboardSource(ships, store, cron).fleet(signal)).ships.every(
      (ship) => !ship.captain,
    ),
  ).toBe(true);
});
