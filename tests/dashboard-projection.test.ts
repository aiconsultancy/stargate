import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import type { AgentBackend } from "../src/backends/backend";
import type { CrewStatus } from "../src/shared/crew-status";
import { CronStore } from "../src/automation/cron/store";
import type { DashboardTransport } from "../src/observability/dashboard/dashboard-model";
import {
  dashboardCrewMembers,
  dashboardCrewSummary,
} from "../src/observability/dashboard/dashboard-projection";
import {
  type DashboardShip,
  dashboardSource,
} from "../src/observability/dashboard/dashboard-source";
import { conversationKey } from "../src/gateway/routing";
import { openStore } from "../src/app/open-store";
import { bot } from "./fixtures";

const cleanup: { close(): unknown }[] = [];

afterEach(() => {
  for (const store of cleanup.splice(0)) {
    store.close();
  }
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
    dashboardCrewSummary({
      ...status,
      busy: 0,
      members: status.members.map((context) => ({ ...context, current: null })),
    }).people?.busy,
  ).toBe(0); // Queued-only work is not a current task.

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
  const store = openStore(":memory:");
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
  const store = openStore(":memory:");
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
  ]) {
    expect(
      (await dashboardSource(ships, store, cron).fleet(signal)).ships.every(
        (ship) => !ship.captain,
      ),
    ).toBe(true);
  }

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

test("a fleet request reads shared captain crew once and retries only a failed exact alias", async () => {
  const store = openStore(":memory:");
  const cron = new CronStore(":memory:");
  cleanup.push(store, cron);
  const irc = registration("captain", "irc");
  const teams = registration("captain-teams", "teams");
  let primaryCalls = 0;
  let aliasCalls = 0;
  let fail = false;
  irc.backend.crewStatus = async () => {
    primaryCalls++;

    if (fail) {
      throw new Error("Fixture unavailable");
    }

    return roster();
  };

  teams.backend.crewStatus = async () => {
    aliasCalls++;

    return roster();
  };

  const ships = [teams, irc];
  const source = dashboardSource(ships, store, cron);
  expect(
    (await source.fleet(signal)).ships.every(
      (ship) => ship.crew?.people?.total === 4,
    ),
  ).toBe(true);
  expect([primaryCalls, aliasCalls]).toEqual([1, 0]);
  fail = true;
  expect(
    (await source.fleet(signal)).ships.every(
      (ship) => ship.crew?.people?.total === 4,
    ),
  ).toBe(true);
  expect([primaryCalls, aliasCalls]).toEqual([2, 1]);
  // The grouping is rebuilt after a live registration reload.
  ships.splice(0, 1);
  expect((await source.fleet(signal)).ships[0]?.captain).toBeUndefined();
});

test("retiring a pinned captain alias aborts its read and discards its late sample", async () => {
  const store = openStore(":memory:");
  const cron = new CronStore(":memory:");
  cleanup.push(store, cron);
  const primary = registration("captain", "irc");
  const alias = registration("captain-teams", "teams");
  const started = Promise.withResolvers<AbortSignal>();
  const late = Promise.withResolvers<CrewStatus>();
  const recovery = Promise.withResolvers<CrewStatus>();
  primary.backend.crewStatus = async () => {
    throw new Error("Fixture unavailable");
  };

  alias.backend.crewStatus = async (_input, reading) => {
    started.resolve(reading);

    return late.promise;
  };

  const ships = [primary, alias];

  const source = dashboardSource(ships, store, cron, Date.now, {
    fleetCrewReadMs: 5,
    fleetCrewDeadlineMs: 500,
  });

  const read = () => source.fleetWithCrew(signal, new Set([primary.bot.id]));
  const first = read();

  try {
    const reading = await started.promise;
    source.invalidateFleetCrew();
    ships.pop();
    source.retireFleetBackend(alias.backend);
    expect(reading.aborted).toBe(true);
    late.resolve(roster());
    expect((await first).ships[0]).toMatchObject({
      error: "Crew status unavailable.",
      summary: { crew: null },
    });
    await Bun.sleep(0);

    primary.backend.crewStatus = () => recovery.promise;
    const next = read();
    expect(
      await Promise.race([
        next.then(() => "cached"),
        Bun.sleep(25).then(() => "waiting"),
      ]),
    ).toBe("waiting");
    recovery.resolve(roster());
    expect((await next).ships[0]?.error).toBeUndefined();
  } finally {
    late.resolve(roster());
    recovery.resolve(roster());
    await first;
  }
});

/** Execute the real page functions with a small DOM fixture; no browser/provider. */
async function page() {
  const html = await readFile(
    new URL("../templates/dashboard/index.html", import.meta.url),
    "utf8",
  );

  const script = /<script>([\s\S]*?)<\/script>/i.exec(html)?.[1];

  if (!script) {
    throw new Error("Missing dashboard script");
  }

  class Element {
    children: Element[] = [];
    dataset: { focus?: string; section?: string; context?: string } = {};
    attributes: Record<string, string> = {};
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    open = false;
    className = "";
    private value = "";
    constructor(readonly tagName: string) {}
    get textContent(): string {
      return (
        this.value + this.children.map((child) => child.textContent).join("")
      );
    }
    set textContent(value: string) {
      this.value = value;
      this.children = [];
    }
    get childNodes() {
      return this.children;
    }
    append(...nodes: Element[]) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes: Element[]) {
      this.children = nodes;
      this.value = "";
    }
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
    }
    addEventListener(
      key: string,
      value: (event: { preventDefault(): void }) => void,
    ) {
      this.listeners.set(key, value);
    }
    all(): Element[] {
      return this.children.flatMap((child) => [child, ...child.all()]);
    }
    querySelectorAll(selector: string) {
      return this.all().filter((node) =>
        selector === "[data-focus]"
          ? node.dataset.focus
          : node.tagName === "details" && node.dataset.section,
      );
    }
    contains(node: unknown) {
      return this === node || this.all().includes(node as Element);
    }
    focus() {
      document.activeElement = this;
    }
    click() {
      this.listeners.get("click")?.({ preventDefault() {} });
    }
  }

  const main = new Element("main");
  const breadcrumbs = new Element("nav");

  const document = {
    activeElement: null as Element | null,
    title: "",
    createElement: (tag: string) => new Element(tag),
    createTextNode: (value: string) => {
      const node = new Element("text");
      node.textContent = value;

      return node;
    },
    getElementById: (id: string) =>
      id === "content"
        ? main
        : id === "breadcrumbs"
          ? breadcrumbs
          : new Element(id),
  };

  const ui = runInNewContext(
    `${script.slice(0, script.lastIndexOf('refresh.addEventListener("click"'))}\n({ renderFleet, renderShip, renderCrew, replaceView, projectLabel });`,
    {
      document,
      window: { scrollX: 0, scrollY: 0, scrollTo() {} },
      AbortController,
      Node: Element,
    },
  ) as {
    renderFleet(data: unknown): void;
    renderShip(data: unknown): void;
    renderCrew(data: unknown): Element;
    replaceView(nodes: Element[]): void;
    projectLabel(context: unknown): string;
  };

  return { ui, main, document, breadcrumbs };
}

test("page retains exact context activity beyond a truncated page and registration focus", async () => {
  const { ui, main, document } = await page();
  const captain = { key: "shared", id: "captain", name: "IRC Captain" };

  const irc = {
    id: "captain",
    name: "IRC Captain",
    captain,
    transport: "irc",
    crew: null,
    queue: {},
    cronjobs: 0,
  };

  const teams = {
    ...irc,
    id: "captain-teams",
    name: "Teams Captain",
    transport: "teams",
    crew: { total: 42, busy: 1, people: { total: 20, busy: 0, partial: true } },
  };

  const fleet = { ships: [irc, teams] };
  ui.renderFleet(fleet);
  const fields = main.all().filter((node) => node.tagName === "dl")[0];
  const values = fields?.children ?? [];

  const value = (label: string) =>
    values[values.findIndex((node) => node.textContent === label) + 1]
      ?.textContent;

  expect(value("Recorded current contexts")).toBe("1");
  expect(value("Crew with current recorded tasks")).toBe("at least 0");

  const alias = main
    .all()
    .find((node) => node.dataset.focus === "registration-captain-teams");

  alias?.focus();
  ui.renderFleet(fleet);
  expect(document.activeElement).not.toBe(alias);
  expect(document.activeElement?.dataset.focus).toBe(
    "registration-captain-teams",
  );
});

test("project labels never infer a crew checkout from the captain directory; polls respect explicit choices", async () => {
  const { ui, main } = await page();
  expect(ui.projectLabel({ project: "default" })).toBe("Default project");
  expect(ui.projectLabel({})).toBe("Default project");
  expect(ui.projectLabel({ project: "desktop" })).toBe("desktop");
  const status = roster();
  const context = status.members[0];

  if (!context) {
    throw new Error("Missing fixture context");
  }

  // A legacy gateway response without crewMembers still preserves all contexts.
  const data = {
    crew: status,
    bot: { backend: { directory: "/unrelated/captain" } },
  };

  const render = () => {
    ui.replaceView([ui.renderCrew(data)]);

    const details = main
      .all()
      .find((node) => node.dataset.context === "project-7-default-stamets");

    if (!details) {
      throw new Error("Missing context");
    }

    return details;
  };

  expect(render().open).toBe(false);
  context.current = { ...task };
  expect(render().open).toBe(true);
  context.current = null;
  expect(render().open).toBe(false);
  context.queuedCount = 1;
  expect(render().open).toBe(true);
  context.queuedCount = 0;
  context.lastOutcome = { ...task, status: "uncertain" };
  const uncertain = render();
  expect(uncertain.open).toBe(true);
  uncertain.children[0]?.click();
  expect(render().open).toBe(false);
  const closed = render();
  closed.children[0]?.click();
  context.lastOutcome = null;
  expect(render().open).toBe(true);
  expect(main.all().filter((node) => node.dataset.context)).toHaveLength(20);
  expect(main.textContent).not.toContain("captain (default)");
});

test("selected registration heading, title, breadcrumb and focus remain consistent", async () => {
  const store = openStore(":memory:");
  const cron = new CronStore(":memory:");
  cleanup.push(store, cron);
  const irc = registration("captain", "irc");
  const teams = registration("captain-teams", "teams");
  irc.bot.displayName = "IRC Captain";
  teams.bot.displayName = "Teams Captain";

  const data = await dashboardSource([irc, teams], store, cron).ship(
    "captain-teams",
    signal,
  );

  const { ui, main, document, breadcrumbs } = await page();
  ui.renderShip(data);
  expect(main.children[0]?.textContent).toBe("Teams Captain");
  expect(document.title).toBe("Teams Captain | Stargate");
  expect(breadcrumbs.textContent).toBe("Fleet / Teams Captain");

  const alias = main
    .all()
    .find((node) => node.dataset.focus === "registration-captain-teams");

  expect(alias?.attributes["aria-current"]).toBe("page");
  alias?.focus();
  ui.renderShip(data);
  expect(document.activeElement?.dataset.focus).toBe(
    "registration-captain-teams",
  );
});
