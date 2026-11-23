import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Effect } from "effect";
import pino from "pino";
import { ConfigReload, readReloadCandidate } from "../src/app/config-reload";
import { readReady } from "../src/maintenance/nightly/update/ready";
import { NotifyStore } from "../src/notifications/ingest/store";
import { lockInstance, serve } from "../src/app/runtime";
import { SlackConnection } from "../src/transports/slack/slack";
import {
  envelope,
  producerToken,
  runtimeConfig,
  runtimeDependencies,
  temporary,
  unixRequest,
  until,
} from "./notify-runtime-fixture";

const log = pino({ enabled: false });

test("production start preserves companion credentials overlapping disabled sources without exporting active producer-only secrets", async () => {
  const environmentBefore = { ...process.env };

  for (const activeProducer of [false, true]) {
    const directory = await temporary();
    const config = runtimeConfig(directory, false);
    const adapter = config.notify?.adapters["local"];
    const source = adapter?.sources[0];

    if (!source || !config.notify || !adapter)
      throw new Error("Missing credential fixture");
    source.tokenEnv = "BOT_TOKEN";

    if (activeProducer)
      config.notify = {
        ...config.notify,
        adapters: {
          ...config.notify.adapters,
          active: {
            ...adapter,
            enabled: true,
            path: "/v1/notifications/active",
            sources: [{ ...source, id: "active-ci", tokenEnv: "NOTIFY_CI" }],
          },
        },
      };
    await writeFile(join(directory, "stargate.json"), JSON.stringify(config), {
      mode: 0o600,
    });
    await writeFile(
      join(directory, "stargate.json.env"),
      `APP_TOKEN=xapp-companion-fixture\nBOT_TOKEN=xoxb-companion-fixture\n${activeProducer ? `NOTIFY_CI=${producerToken}\n` : ""}`,
      { mode: 0o600 },
    );

    const child = Bun.spawn(
      [
        process.execPath,
        "tests/notify-runtime-fixture.ts",
        directory,
        "start-credentials",
      ],
      {
        env: {
          PATH: process.env["PATH"],
          HOME: process.env["HOME"],
          TMPDIR: process.env["TMPDIR"],
          XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
          XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"],
          XDG_DATA_HOME: process.env["XDG_DATA_HOME"],
          XDG_STATE_HOME: process.env["XDG_STATE_HOME"],
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [output, errors, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exit).toBe(0);
    expect(errors).toBe("");
    expect(JSON.parse(output.trim().split("\n").at(-1) ?? "null")).toEqual({
      initiallyAbsent: true,
      appProjected: true,
      botProjected: true,
      producerOnlyAbsent: true,
      authCalls: 1,
      correctAuthorization: true,
      unexpectedRequest: false,
      refused: true,
    });
  }

  expect(process.env).toEqual(environmentBefore);
});

for (const reference of [
  "BOT_TOKEN",
  "APP_TOKEN",
  "DECLARED_HEADER",
] as const) {
  test(`production start preserves enabled shared ${reference} and excludes producer-only credentials`, async () => {
    const environmentBefore = { ...process.env };
    const directory = await temporary();
    const config = runtimeConfig(directory);
    const adapter = config.notify?.adapters["local"];
    const source = adapter?.sources[0];
    const backend = config.bots[0]?.backend;

    if (!source || !config.notify || !adapter || backend?.type !== "opencode")
      throw new Error("Missing shared credential fixture");
    source.tokenEnv = reference;
    backend.headersEnv = { "X-Fixture-Header": "DECLARED_HEADER" };
    config.notify = {
      ...config.notify,
      adapters: {
        ...config.notify.adapters,
        local: {
          ...adapter,
          sources: [
            source,
            { ...source, id: "producer-only", tokenEnv: "NOTIFY_CI" },
          ],
        },
      },
    };
    await writeFile(join(directory, "stargate.json"), JSON.stringify(config), {
      mode: 0o600,
    });
    await writeFile(
      join(directory, "stargate.json.env"),
      `APP_TOKEN=xapp-${"b".repeat(40)}\nBOT_TOKEN=xoxb-${"a".repeat(40)}\nDECLARED_HEADER=fixture-declared-backend-header-credential\nNOTIFY_CI=${producerToken}\n`,
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = { PATH: process.env["PATH"] };

    for (const name of [
      "HOME",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]) {
      const path = join(directory, name.toLowerCase());
      await mkdir(path, { mode: 0o700 });
      environment[name] = path;
    }

    const child = Bun.spawn(
      [
        process.execPath,
        "tests/notify-runtime-fixture.ts",
        directory,
        "start-shared-credentials",
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" },
    );

    const [output, errors, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exit).toBe(0);
    expect(errors).toBe("");
    expect(JSON.parse(output.trim().split("\n").at(-1) ?? "null")).toEqual({
      initiallyAbsent: true,
      appProjected: true,
      botProjected: true,
      declaredHeaderProjected: true,
      producerOnlyAbsent: true,
      authCalls: 1,
      correctAuthorization: true,
      unexpectedRequest: false,
      refused: true,
    });
    expect(process.env).toEqual(environmentBefore);
  });
}

test("runtime composes Unix producer/core/fake Slack without any notification-origin agent input", async () => {
  const directory = await temporary();
  const delivered = Promise.withResolvers<URLSearchParams>();

  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      delivered.resolve(new URLSearchParams(await request.text()));

      return Response.json({ ok: true, ts: "1.000" });
    },
  });

  const f = runtimeDependencies(fake.url.href);
  const controller = new AbortController();

  const running = Effect.runPromise(
    serve(runtimeConfig(directory), log, controller.signal, f.dependencies),
  );

  try {
    await until(async () => (await readReady(directory)) !== null);
    const response = await unixRequest(join(directory, "api.sock"));
    expect(response.status).toBe(202);
    expect((await delivered.promise).get("text")).toBe("Released");
    expect(f.calls).toEqual([]);

    const operator = (
      await readFile(join(directory, "api-token"), "utf8")
    ).trim();

    expect(
      (
        await unixRequest(join(directory, "api.sock"), undefined, {
          token: operator,
        })
      ).status,
    ).toBe(401);

    for (const path of [
      "/api/v1/fleet",
      "/api/v1/ships/helper",
      "/api/v1/ships/helper/crew/shaw",
      "/api/v1/events",
    ])
      expect(
        (
          await unixRequest(join(directory, "api.sock"), path, {
            method: "GET",
            body: "",
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await unixRequest(join(directory, "api.sock"), "/api/v1/fleet", {
          method: "HEAD",
          token: operator,
          body: "",
        })
      ).status,
    ).toBe(200);
  } finally {
    controller.abort();
    await running;
    await fake.stop(true);
  }

  const lock = lockInstance(join(directory, "instance.sqlite"));
  lock.close();
});

test("disabled notify leaves no store, mount, worker or Slack call; Fleet remains active", async () => {
  const directory = await temporary();
  let sends = 0;

  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      sends++;

      return Response.json({ ok: true, ts: "1.000" });
    },
  });

  const f = runtimeDependencies(fake.url.href);
  const controller = new AbortController();

  const running = Effect.runPromise(
    serve(
      runtimeConfig(directory, false),
      log,
      controller.signal,
      f.dependencies,
    ),
  );

  try {
    await until(async () => (await readReady(directory)) !== null);
    expect(existsSync(join(directory, "notify.sqlite"))).toBe(false);
    expect((await unixRequest(join(directory, "api.sock"))).status).toBe(404);

    const operator = (
      await readFile(join(directory, "api-token"), "utf8")
    ).trim();

    expect(
      (
        await unixRequest(join(directory, "api.sock"), "/api/v1/fleet", {
          method: "HEAD",
          token: operator,
          body: "",
        })
      ).status,
    ).toBe(200);
    expect(sends).toBe(0);
    expect(f.calls).toEqual([]);
  } finally {
    controller.abort();
    await running;
    await fake.stop(true);
  }
});

test("startup connection failure starts no notification store/send and releases instance lock", async () => {
  const directory = await temporary();
  const f = runtimeDependencies("http://127.0.0.1:1/", { fail: true });
  await expect(
    Effect.runPromise(
      serve(
        runtimeConfig(directory),
        log,
        new AbortController().signal,
        f.dependencies,
      ),
    ),
  ).rejects.toThrow();
  expect(existsSync(join(directory, "notify.sqlite"))).toBe(false);
  const lock = lockInstance(join(directory, "instance.sqlite"));
  lock.close();
  expect(f.calls).toEqual([]);
});

test("core failure is supervised into runtime shutdown, not a detached log", async () => {
  const directory = await temporary();
  const f = runtimeDependencies("http://127.0.0.1:1/");
  const controller = new AbortController();

  const running = Effect.runPromise(
    serve(runtimeConfig(directory), log, controller.signal, f.dependencies),
  ).then(
    () => "resolved",
    () => "failed",
  );

  try {
    await until(async () => (await readReady(directory)) !== null);
    const disk = new Database(join(directory, "notify.sqlite"));
    disk.exec("DROP TABLE notify_outbox");
    disk.close();
    expect(await running).toBe("failed");
    const lock = lockInstance(join(directory, "instance.sqlite"));
    lock.close();
  } finally {
    controller.abort();
    await running;
  }
});

test("live reload revokes a retained row; failed candidate cannot advance CURRENT bindings", async () => {
  const directory = await temporary();
  const path = join(directory, "stargate.json");
  const config = runtimeConfig(directory);
  const first = Promise.withResolvers<void>();
  let sends = 0;

  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      sends++;
      first.resolve();

      return new Response("unknown", { status: 500 });
    },
  });

  const f = runtimeDependencies(fake.url.href);

  const environment = {
    APP_TOKEN: "xapp-fixture",
    BOT_TOKEN: "xoxb-fixture",
    NOTIFY_CI: producerToken,
  };

  const reload = new ConfigReload(
    { config, environment },
    () => readReloadCandidate(path, environment, true),
    log,
  );

  const controller = new AbortController();

  const running = Effect.runPromise(
    serve(config, log, controller.signal, f.dependencies, reload),
  );

  try {
    await until(async () => (await readReady(directory)) !== null);
    expect((await unixRequest(join(directory, "api.sock"))).status).toBe(202);
    await first.promise;
    await writeFile(
      path,
      JSON.stringify({
        ...config,
        notify: { ...config.notify, limits: { outboxRows: 1 } },
      }),
    );
    expect((await reload.request()).status).toBe("restart-required");
    expect(reload.current.config).toBe(config);
    const denied = structuredClone(config);
    const sender = denied.bots[0];

    if (!sender) throw new Error("Missing fixture bot");
    sender.access.deniedChannels = ["C123"];
    await writeFile(path, JSON.stringify(denied));
    expect((await reload.request()).status).toBe("applied");
    await until(() => {
      const disk = new Database(join(directory, "notify.sqlite"), {
        readonly: true,
      });

      try {
        return (
          disk
            .query<{ n: number }, []>("SELECT count(*) AS n FROM notify_outbox")
            .get()?.n === 0
        );
      } finally {
        disk.close();
      }
    });
    expect(sends).toBe(1);
    expect(f.calls).toEqual([]);
  } finally {
    controller.abort();
    await running;
    await fake.stop(true);
  }
});

test("shutdown aborts underlying Slack HTTP and retains store/lock until actual local settlement", async () => {
  const directory = await temporary();
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();

  const fake = createServer((request, response) => {
    request.resume();
    request.on("end", () => started.resolve());
    response.on("close", () => disconnected.resolve());
  });

  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();

  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const url = `http://127.0.0.1:${address.port}/`;

  const real = new SlackConnection("fixture-app", "fixture-bot", log, {
    slackApiUrl: url,
    fetch: async (url, init) => {
      try {
        return await fetch(url, init);
      } catch (error) {
        aborted.resolve();
        await settle.promise;
        throw error;
      }
    },
  });

  const f = runtimeDependencies(url);
  let backendClosed = false;

  const dependencies = {
    ...f.dependencies,
    slack: (
      bot: Parameters<typeof f.dependencies.slack>[0],
      logger: Parameters<typeof f.dependencies.slack>[1],
    ) => ({
      ...f.dependencies.slack(bot, logger),
      notification: real.notification.bind(real),
    }),
    backend: async (
      config: Parameters<typeof f.dependencies.backend>[0],
      context: Parameters<typeof f.dependencies.backend>[1],
    ) => {
      const backend = await f.dependencies.backend(config, context);

      return {
        ...backend,
        close: async () => {
          backendClosed = true;
          await backend.close();
        },
      };
    },
  };

  const controller = new AbortController();

  const running = Effect.runPromise(
    serve(runtimeConfig(directory), log, controller.signal, dependencies),
  );

  try {
    await until(async () => (await readReady(directory)) !== null);
    expect((await unixRequest(join(directory, "api.sock"))).status).toBe(202);
    await started.promise;
    controller.abort();
    await aborted.promise;
    await disconnected.promise;
    expect(() => lockInstance(join(directory, "instance.sqlite"))).toThrow(
      "already using",
    );
    expect(backendClosed).toBe(false);

    const disk = new Database(join(directory, "notify.sqlite"), {
      readonly: true,
    });

    expect(
      disk.query<{ state: string }, []>("SELECT state FROM notify_outbox").get()
        ?.state,
    ).toBe("leased");
    disk.close();
    settle.resolve();
    await running;
    expect(backendClosed).toBe(true);
    const lock = lockInstance(join(directory, "instance.sqlite"));
    lock.close();

    const retained = new Database(join(directory, "notify.sqlite"), {
      readonly: true,
    });

    expect(
      retained
        .query<{ attempts: number; state: string }, []>(
          "SELECT attempts,state FROM notify_outbox",
        )
        .get(),
    ).toEqual({ attempts: 1, state: "pending" });
    retained.close();
  } finally {
    controller.abort();
    settle.resolve();
    await running;
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});

test("nonsettling real child holds instance lock until referenced hard exit; retained attempt reopens", async () => {
  const directory = await temporary();

  const child = Bun.spawn(
    [process.execPath, "tests/notify-runtime-fixture.ts", directory],
    {
      env: {
        PATH: process.env["PATH"],
        HOME: process.env["HOME"],
        TMPDIR: process.env["TMPDIR"],
        XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
        XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"],
        XDG_DATA_HOME: process.env["XDG_DATA_HOME"],
        XDG_STATE_HOME: process.env["XDG_STATE_HOME"],
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const messages: string[] = [];

  const output = (async () => {
    for await (const bytes of child.stdout)
      messages.push(new TextDecoder().decode(bytes));
  })();

  try {
    await until(() => messages.join("").includes("ready"));
    expect(
      (
        await unixRequest(join(directory, "api.sock"), undefined, {
          body: JSON.stringify(envelope("Retained")),
          token: producerToken,
        })
      ).status,
    ).toBe(202);
    await until(() => messages.join("").includes("attempt-started"));
    expect(() => lockInstance(join(directory, "instance.sqlite"))).toThrow(
      "already using",
    );
    child.kill("SIGTERM");
    await until(() => messages.join("").includes("shutdown-requested"));
    expect(() => lockInstance(join(directory, "instance.sqlite"))).toThrow(
      "already using",
    );
    expect(await child.exited).toBe(1);
    await output;
    const lock = lockInstance(join(directory, "instance.sqlite"));
    lock.close();

    const disk = new Database(join(directory, "notify.sqlite"), {
      readonly: true,
    });

    expect(
      disk
        .query<{ state: string; attempts: number }, []>(
          "SELECT state,attempts FROM notify_outbox",
        )
        .all(),
    ).toEqual([{ state: "leased", attempts: 1 }]);

    const admittedAt = disk
      .query<{ admittedAt: number }, []>("SELECT admittedAt FROM notify_outbox")
      .get()?.admittedAt;

    disk.close();
    const recovered = new NotifyStore(join(directory, "notify.sqlite"));

    try {
      recovered.recover(Date.now());
      const claim = recovered.claim(Date.now());
      expect(claim?.attempts).toBe(2);
      expect(claim?.admittedAt).toBe(admittedAt);
      expect(claim?.payload.title).toBe("Retained");

      if (claim) recovered.settle(claim, { state: "unknown" }, Date.now());
    } finally {
      recovered.close();
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await output;
    await new Response(child.stderr).text();
  }
}, 10_000);
