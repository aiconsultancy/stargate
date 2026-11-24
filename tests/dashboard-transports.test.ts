import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Effect, Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { configSchema } from "../src/config";
import { type IrcRegistration, IrcShip } from "../src/transports/irc/ship";
import { conversationKey } from "../src/gateway/routing";
import { type RuntimeDependencies, serve } from "../src/app/runtime";
import { openStore } from "../src/app/open-store";
import {
  flockCommand,
  setDefaultLockCommandForTests,
} from "../src/lib/unix-socket";
import { bot } from "./fixtures";
import { FakeIrcServer } from "./irc-fixture";

const cleanup: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const lock = (path: string) => ({
  command: "python3",
  args: [
    "-u",
    "-c",
    "import fcntl,sys;f=open(sys.argv[1]);fcntl.flock(f,fcntl.LOCK_EX);print('R',flush=True);sys.stdin.read()",
    path,
  ],
});

async function runtime(transports: "irc" | "teams" | "both") {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-dashboard-transports-")),
  );

  await chmod(directory, 0o700);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const irc = new FakeIrcServer({ accounts: { captain: "fixture" } });
  irc.start();
  cleanup.push(() => irc.stop());
  setDefaultLockCommandForTests(lock);
  cleanup.push(() => setDefaultLockCommandForTests(flockCommand));

  const config = Schema.decodeUnknownSync(configSchema)({
    dataDirectory: directory,
    dashboard: true,
    irc:
      transports === "teams"
        ? []
        : [
            {
              id: "captain",
              server: { host: "127.0.0.1", port: irc.port, tls: false },
              account: "captain",
              passwordEnv: "IRC_TEST_PASSWORD",
              channels: ["#ship"],
              access: {
                allowedAccounts: ["human"],
                deniedAccounts: ["excluded"],
                channelRequests: "nick-mention",
              },
              backend: {
                type: "opencode",
                url: "http://127.0.0.1:4101",
                directory: "/project/irc",
                sessionID: "ses_irc",
              },
            },
          ],
    teams:
      transports === "irc"
        ? []
        : [
            {
              id: "captain-teams",
              botClientId: "11111111-2222-4333-8444-555555555555",
              tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              socketPath: join(directory, "teams.sock"),
              access: { users: ["99999999-8888-4777-8666-555555555555"] },
              backend: {
                type: "opencode",
                url: "http://127.0.0.1:4102",
                directory: "/project/teams",
                sessionID: "ses_teams",
              },
            },
          ],
  });

  const built: string[] = [],
    closed: string[] = [],
    turns: string[] = [];

  const registrations: IrcRegistration[] = [];
  const ready = Promise.withResolvers<void>();

  const log = pino(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, done) {
        if (String(chunk).includes('"msg":"Stargate ready"')) {
          ready.resolve();
        }

        done();
      },
    }),
  );

  const dependencies: RuntimeDependencies = {
    slack() {
      throw new Error("No Slack connection belongs to this configuration");
    },
    async backend(config) {
      const id = config.type === "opencode" ? config.sessionID : undefined;

      if (!id) {
        throw new Error("Missing fixture pin");
      }

      built.push(id);

      return {
        sessionID: id,
        async createSession() {
          turns.push("create");
          throw new Error("Dashboard cannot create native sessions");
        },
        async prompt() {
          turns.push("prompt");
          throw new Error("Dashboard cannot run models");
        },
        async close() {
          closed.push(id);
        },
        history: {
          async roots() {
            return [];
          },
          async describe(ids) {
            return ids.map((id) => ({
              id,
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
                  id: "visible-entry",
                  role: "assistant" as const,
                  parts: [{ type: "text" as const, text: sessionID }],
                },
              ],
            };
          },
        },
      } satisfies AgentBackend;
    },
    async irc(config, store, log) {
      const ship = await IrcShip.create(config, store, log, {
        env: { IRC_TEST_PASSWORD: "fixture" },
        timing: { intervalMs: 2, reconnectMinMs: 10, reconnectMaxMs: 30 },
        readyMs: 1000,
        crewLink: null,
      });

      registrations.push(...ship.registrations);

      return ship;
    },
  };

  const abort = new AbortController();

  const work = Effect.runPromise(
    serve(config, log, abort.signal, dependencies),
  );

  cleanup.push(async () => {
    abort.abort();
    await work;
  });
  await Promise.race([
    ready.promise,
    work.then(() => {
      throw new Error("Runtime stopped before readiness");
    }),
  ]);

  const get = async (path: string, method = "GET") =>
    fetch("http://dashboard" + path, {
      unix: join(directory, "dashboard.sock"),
      method,
    });

  return { config, directory, built, closed, turns, registrations, get };
}

for (const transport of ["irc", "teams", "both"] as const) {
  test(`${transport} runtime dashboard uses real transports without extra backends, sessions or Slack`, async () => {
    const f = await runtime(transport);

    const data = Schema.decodeUnknownSync(
      Schema.Struct({
        ships: Schema.Array(
          Schema.Struct({ id: Schema.String, transport: Schema.String }),
        ),
      }),
    )(await (await f.get("/api/fleet")).json());

    expect(data.ships.map((s) => s.id).sort()).toEqual(
      transport === "both"
        ? ["captain", "captain-teams"]
        : transport === "irc"
          ? ["captain"]
          : ["captain-teams"],
    );
    expect(f.built).toHaveLength(transport === "both" ? 2 : 1);

    for (const ship of data.ships) {
      const detail = Schema.decodeUnknownSync(
        Schema.Struct({
          bot: Schema.Struct({
            slack: Schema.optional(Schema.Unknown),
            transport: Schema.Struct({ kind: Schema.String }),
          }),
          sessions: Schema.Array(Schema.Struct({ id: Schema.String })),
        }),
      )(await (await f.get("/api/ships/" + ship.id)).json());

      expect(detail.bot.slack).toBeUndefined();
      expect(detail.bot.transport.kind).toBe(ship.transport);
      expect(detail.sessions[0]?.id).toBe(
        ship.transport === "irc" ? "ses_irc" : "ses_teams",
      );
      expect(
        (await f.get(`/api/ships/${ship.id}/entries?session=ses_foreign`))
          .status,
      ).toBe(404);
      expect(
        (
          await f.get(
            `/api/ships/${ship.id}/entries?session=${ship.transport === "irc" ? "ses_teams" : "ses_irc"}`,
          )
        ).status,
      ).toBe(404);
      expect((await f.get("/api/ships/" + ship.id, "POST")).status).toBe(405);
    }

    if (transport !== "teams") {
      const registration = f.registrations[0];

      if (!registration) {
        throw new Error("Missing real IRC registration");
      }

      const store = openStore(join(f.directory, "stargate.sqlite"));

      try {
        const conversation = conversationKey(
          registration.key,
          "#ship",
          "thread",
        );

        const job = store.enqueue({
          eventId: "dashboard-fixture",
          botKey: registration.key,
          conversation,
          channel: "#ship",
          thread: "thread",
          user: "human",
          text: "not shown in summary",
        });

        if (!job) {
          throw new Error("Missing fixture job");
        }

        const retained = store.queuedJob(registration.key, "dashboard-fixture");

        if (!retained) {
          throw new Error("Missing retained job");
        }

        store.finish(retained.id, "failed");
        store.saveSession(conversation, "ses_mapped_irc");
      } finally {
        store.close();
      }

      const own = Schema.decodeUnknownSync(
        Schema.Struct({
          queue: Schema.Struct({
            counts: Schema.Struct({ failed: Schema.Finite }),
          }),
        }),
      )(await (await f.get("/api/ships/captain")).json());

      expect(own.queue.counts.failed).toBe(1);
      expect(
        (await f.get("/api/ships/captain/entries?session=ses_mapped_irc"))
          .status,
      ).toBe(200);

      if (transport === "both") {
        expect(
          (
            await f.get(
              "/api/ships/captain-teams/entries?session=ses_mapped_irc",
            )
          ).status,
        ).toBe(404);
      }
    }

    expect(f.turns).toEqual([]);
  });
}

test("shared dashboard configuration is explicit, normalised and requires dashboard enablement", () => {
  const base = { bots: [bot()] };
  expect(
    Schema.decodeUnknownSync(configSchema)(base).dashboardSocket,
  ).toBeUndefined();

  for (const dashboardSocket of [
    { path: "relative.sock", groupAccess: true },
    { path: "/run/../dashboard.sock", groupAccess: true },
    { path: "/run/dashboard.sock" },
    { path: "/run/dashboard.sock", groupAccess: false },
    { path: "/run/dashboard.sock", groupAccess: true, mode: 0o666 },
  ]) {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(configSchema)({
          ...base,
          dashboard: true,
          dashboardSocket,
        }),
      ),
    ).toBe(false);
  }

  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({
        ...base,
        dashboardSocket: { path: "/run/dashboard.sock", groupAccess: true },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({
        ...base,
        dashboard: true,
        dashboardSocket: { path: "/run/dashboard.sock", groupAccess: true },
      }),
    ),
  ).toBe(true);
});

test("shared dashboard cannot expose its private gateway data directory", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-dashboard-isolation-")),
  );

  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const config = Schema.decodeUnknownSync(configSchema)({
    dataDirectory: directory,
    dashboard: true,
    dashboardSocket: {
      path: join(directory, "operator", "http.sock"),
      groupAccess: true,
    },
    bots: [bot()],
  });

  const dependencies: RuntimeDependencies = {
    slack() {
      throw new Error("No transport may start");
    },
    async backend() {
      throw new Error("No backend may start");
    },
  };

  await expect(
    Effect.runPromise(
      serve(
        config,
        pino({ enabled: false }),
        new AbortController().signal,
        dependencies,
      ),
    ),
  ).rejects.toThrow("outside");
});
