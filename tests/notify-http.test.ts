import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { request } from "node:http";
import { join } from "node:path";
import { Effect, Exit, Schema, Scope } from "effect";
import { startApiServer } from "../src/dashboard/api/server";
import { notifySchema } from "../src/notifications/ingest/config";
import { notificationRoutes } from "../src/notifications/ingest/http";
import type { Destination } from "../src/notifications/ingest/model";
import { makeNotifications } from "../src/notifications/ingest/notifications";
import {
  envelope,
  notificationConfig,
  producerToken,
  temporary,
  unixRequest,
} from "./notify-runtime-fixture";

const destination: Destination = {
  transport: "slack",
  registrationId: "helper",
  appId: "A123",
  workspaceId: "T123",
  botUserId: "UHELPER",
  channel: "C123",
  audience: "internal",
};

test("Unix HTTP acknowledges committed SQLite; response loss and restart keep duplicate identity", async () => {
  const directory = await temporary();
  const path = join(directory, "notify.sqlite");

  const config = Schema.decodeUnknownSync(notifySchema)(
    notificationConfig(true),
  );

  let accepted: { signature: string; duplicate: boolean } | undefined;

  for (let n = 0; n < 2; n++) {
    const token =
      n === 0 ? producerToken : "rotated-notification-producer-credential-0002";

    const scope = Effect.runSync(Scope.make());

    const core = await Effect.runPromise(
      makeNotifications({
        path,
        destinations: { log: destination },
        subscriptions: config.subscriptions,
        sink: { allowed: () => true, send: async () => ({ state: "unknown" }) },
      }).pipe(Scope.provide(scope)),
    );

    const producer = notificationRoutes(
      config,
      { NOTIFY_CI: token },
      "operator-token",
      core,
    );

    const server = await startApiServer({
      listen: { unix: join(directory, "api.sock") },
      routes: producer.routes,
      signal: new AbortController().signal,
      fleet: async () => Response.json({ fleet: true }),
    });

    try {
      const response = await unixRequest(
        join(directory, "api.sock"),
        undefined,
        { token },
      );

      expect(response.status).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.duplicate).toBe(n === 1);

      if (accepted) expect(body.signature).toBe(accepted.signature);
      accepted = body;
      const disk = new Database(path, { readonly: true });
      expect(
        disk
          .query<{ n: number }, []>("SELECT count(*) AS n FROM notify_dedup")
          .get()?.n,
      ).toBe(1);
      expect(
        disk
          .query<{ n: number }, []>("SELECT count(*) AS n FROM notify_outbox")
          .get()?.n,
      ).toBe(1);
      disk.close();
    } finally {
      producer.closeAdmission();
      server.closeAdmission();
      core.closeAdmission();
      await server.stop();
      await core.shutdown();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }
});

test("lost original HTTP response replays as duplicate after restart without another admission", async () => {
  const directory = await temporary();
  const path = join(directory, "notify.sqlite");

  const config = Schema.decodeUnknownSync(notifySchema)(
    notificationConfig(true),
  );

  const committed = Promise.withResolvers<void>();
  let signature = "";

  for (let n = 0; n < 2; n++) {
    const scope = Effect.runSync(Scope.make());

    const core = await Effect.runPromise(
      makeNotifications({
        path,
        destinations: { log: destination },
        subscriptions: config.subscriptions,
        sink: { allowed: () => true, send: async () => ({ state: "unknown" }) },
      }).pipe(Scope.provide(scope)),
    );

    const producer = notificationRoutes(
      config,
      { NOTIFY_CI: producerToken },
      "operator-token",
      core,
    );

    const routes = producer.routes.map((route) => ({
      ...route,
      async handle(input: Request, caller: unknown, signal: AbortSignal) {
        const result = await route.handle(input, caller, signal);

        if (n === 0 && result.status === 202) {
          committed.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });

            if (signal.aborted) resolve();
          });
        }

        return result;
      },
    }));

    const server = await startApiServer({
      listen: { unix: join(directory, "api.sock") },
      routes,
      signal: new AbortController().signal,
      fleet: async () => Response.json({ fleet: true }),
    });

    try {
      if (n === 0) {
        const requestLost = Promise.withResolvers<void>();

        const req = request(
          {
            socketPath: join(directory, "api.sock"),
            path: "/v1/notifications/local",
            method: "POST",
            headers: {
              Authorization: `Bearer ${producerToken}`,
              "Content-Type": "application/json",
            },
          },
          () => requestLost.reject(new Error("Unexpected response")),
        );

        req.on("error", () => requestLost.resolve());
        req.end(JSON.stringify(envelope()));
        await committed.promise;
        const disk = new Database(path, { readonly: true });
        signature =
          disk
            .query<{ signature: string }, []>(
              "SELECT signature FROM notify_dedup",
            )
            .get()?.signature ?? "";
        disk.close();
        expect(signature).toStartWith("v1:");
        req.destroy(new Error("Fixture response loss"));
        await requestLost.promise;
      } else {
        const response = await unixRequest(join(directory, "api.sock"));
        expect(response.status).toBe(202);
        expect(JSON.parse(response.body)).toEqual({
          signature,
          duplicate: true,
        });
        expect(core.counters.accepted).toBe(0);
        expect(core.counters.duplicate).toBe(1);
      }
    } finally {
      server.closeAdmission();
      core.closeAdmission();
      await server.stop();
      await core.shutdown();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }
});

test("full real outbox maps to 503 without partial admission; duplicate still succeeds", async () => {
  const directory = await temporary();
  const path = join(directory, "notify.sqlite");

  const config = Schema.decodeUnknownSync(notifySchema)(
    notificationConfig(true),
  );

  const scope = Effect.runSync(Scope.make());
  const started = Promise.withResolvers<void>();

  const core = await Effect.runPromise(
    makeNotifications({
      path,
      limits: { outboxRows: 1 },
      destinations: { log: destination },
      subscriptions: config.subscriptions,
      sink: {
        allowed: () => true,
        send: async (_destination, _payload, signal) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });

            if (signal.aborted) resolve();
          });

          return { state: "unknown" };
        },
      },
    }).pipe(Scope.provide(scope)),
  );

  const producer = notificationRoutes(
    config,
    { NOTIFY_CI: producerToken },
    "operator-token",
    core,
  );

  const server = await startApiServer({
    listen: { unix: join(directory, "api.sock") },
    routes: producer.routes,
    signal: new AbortController().signal,
    fleet: async () => Response.json({ fleet: true }),
  });

  try {
    expect((await unixRequest(join(directory, "api.sock"))).status).toBe(202);
    await started.promise;

    const failed = await unixRequest(join(directory, "api.sock"), undefined, {
      body: JSON.stringify(envelope("Different event")),
    });

    expect(failed.status).toBe(503);
    expect(failed.headers["retry-after"]).toBe("1");
    expect(JSON.parse(failed.body).code).toBe("store_unavailable");
    const disk = new Database(path, { readonly: true });
    expect(
      disk
        .query<{ n: number }, []>("SELECT count(*) AS n FROM notify_dedup")
        .get()?.n,
    ).toBe(1);
    expect(
      disk
        .query<{ n: number }, []>("SELECT count(*) AS n FROM notify_outbox")
        .get()?.n,
    ).toBe(1);
    disk.close();
    const repeated = await unixRequest(join(directory, "api.sock"));
    expect(repeated.status).toBe(202);
    expect(JSON.parse(repeated.body).duplicate).toBe(true);
  } finally {
    await server.stop();
    await core.shutdown();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

test("real host rejects credentials, Origin, media, identity claims and topic; source rate is bounded", async () => {
  const directory = await temporary();
  const raw = notificationConfig(true);
  const otherToken = "other-notification-producer-credential-0002";

  const config = Schema.decodeUnknownSync(notifySchema)({
    ...raw,
    adapters: {
      ...raw.adapters,
      alerts: {
        ...raw.adapters.local,
        path: "/v1/notifications/alerts",
        sources: [
          {
            id: "alert-ci",
            tokenEnv: "OTHER_CI",
            topics: ["alerts.*"],
            audience: "internal",
          },
        ],
      },
    },
  });

  const scope = Effect.runSync(Scope.make());

  const core = await Effect.runPromise(
    makeNotifications({
      path: join(directory, "notify.sqlite"),
      destinations: { log: destination },
      subscriptions: config.subscriptions,
      sink: { allowed: () => true, send: async () => ({ state: "unknown" }) },
    }).pipe(Scope.provide(scope)),
  );

  const producer = notificationRoutes(
    config,
    { NOTIFY_CI: producerToken, OTHER_CI: otherToken },
    "operator-token",
    core,
    () => 1000,
  );

  const server = await startApiServer({
    listen: { unix: join(directory, "api.sock") },
    routes: producer.routes,
    signal: new AbortController().signal,
    fleet: async () => Response.json({ fleet: true }),
  });

  try {
    expect(
      (
        await unixRequest(
          join(directory, "api.sock"),
          "/v1/notifications/alerts",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await unixRequest(join(directory, "api.sock"), undefined, {
          token: otherToken,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await unixRequest(
          join(directory, "api.sock"),
          "/v1/notifications/alerts",
          { token: otherToken },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await unixRequest(
          join(directory, "api.sock"),
          "/v1/notifications/alerts",
          {
            token: otherToken,
            body: JSON.stringify({ ...envelope(), topic: "alerts.host" }),
          },
        )
      ).status,
    ).toBe(202);

    for (const [options, status] of [
      [{ token: "operator-token" }, 401],
      [{ token: "x" }, 401],
      [{ headers: { Origin: "null" } }, 403],
      [{ headers: { Origin: "subspace://space" }, method: "OPTIONS" }, 404],
      [{ headers: { "Content-Type": "text/plain" } }, 415],
      [{ body: "{" }, 400],
      [
        {
          body: JSON.stringify({
            ...envelope(),
            source: "other",
            signature: "claimed",
            destinations: ["other"],
          }),
        },
        400,
      ],
      [{ body: JSON.stringify({ ...envelope(), topic: "other.topic" }) }, 403],
      [{ body: "x".repeat(65 * 1024) }, 413],
    ] as const) {
      const response = await unixRequest(
        join(directory, "api.sock"),
        undefined,
        options,
      );

      expect(response.status).toBe(status);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.body).not.toContain(producerToken);
      expect(response.body).not.toContain("claimed");
    }

    let response = await unixRequest(join(directory, "api.sock"));
    expect(response.status).toBe(202);

    for (let n = 0; n < 60; n++)
      response = await unixRequest(join(directory, "api.sock"));
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("60");
    producer.closeAdmission();
    response = await unixRequest(join(directory, "api.sock"));
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
  } finally {
    await server.stop();
    await core.shutdown();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
