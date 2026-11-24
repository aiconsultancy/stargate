import { randomUUID } from "node:crypto";
import { Effect, Predicate, Result, Schema } from "effect";
import {
  type NotifyConfig,
  equalCredential,
  producerCredentials,
} from "./config";
import {
  NotificationInput,
  type PublishError,
  type ShuttingDown,
  Source,
} from "./model";
import type { NotificationCore } from "./notifications";

type NotificationRoute = {
  readonly owner: string;
  readonly method: "POST";
  readonly path: string;
  readonly limits: {
    readonly maxBodyBytes: number;
    readonly timeoutMs: number;
    readonly maxConcurrent: number;
  };
  authorize(
    headers: Headers,
  ):
    | { readonly allowed: true; readonly caller: unknown }
    | { readonly allowed: false; readonly response: Response };
  handle(
    request: Request,
    caller: unknown,
    signal: AbortSignal,
  ): Promise<Response>;
};

function failure(status: number, code: string, retry = 1) {
  return Response.json(
    { code, correlationId: randomUUID() },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(status === 401 && { "WWW-Authenticate": "Bearer" }),
        ...((status === 429 || status === 503) && {
          "Retry-After": String(retry),
        }),
      },
    },
  );
}

// Typed as the last member only: a new publish failure fails typecheck here.
function shuttingDownFailure(_failure: ShuttingDown) {
  return failure(503, "shutting_down");
}

function publishFailure(failed: PublishError) {
  if (Predicate.isTagged(failed, "InvalidNotification")) {
    return failure(400, "invalid_notification");
  }

  if (Predicate.isTagged(failed, "TopicNotGranted")) {
    return failure(403, "topic_not_granted");
  }

  if (Predicate.isTagged(failed, "QueueFull")) {
    return failure(503, "queue_full");
  }

  if (Predicate.isTagged(failed, "StoreUnavailable")) {
    return failure(503, "store_unavailable");
  }

  return shuttingDownFailure(failed);
}

/** Header-only policy; body bounds and work reservations belong to the host. */
export function notificationRoutes(
  config: NotifyConfig,
  environment: NodeJS.ProcessEnv,
  operatorToken: string,
  core: Pick<NotificationCore, "publish">,
  now = performance.now.bind(performance),
) {
  const credentials = producerCredentials(config, environment, operatorToken);
  let open = true;
  const routes: NotificationRoute[] = [];

  for (const [name, adapter] of Object.entries(config.adapters)) {
    if (!adapter.enabled) {
      continue;
    }

    const sources = credentials
      .filter((entry) => entry.adapter === name)
      .map((entry) => ({
        token: entry.token,
        source: {
          adapter: name,
          principal: entry.source.id,
          audience: entry.source.audience,
          topics: entry.source.topics,
        },
        rate: entry.source.perMinute,
        count: 0,
        expires: 0,
      }));

    routes.push({
      owner: `notify/${name}`,
      method: "POST",
      path: adapter.path,
      limits: { maxBodyBytes: 64 * 1024, timeoutMs: 20_000, maxConcurrent: 4 },
      authorize(headers) {
        if (!open) {
          return { allowed: false, response: failure(503, "shutting_down") };
        }

        if (headers.has("Origin")) {
          return { allowed: false, response: failure(403, "forbidden") };
        }

        const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(
          headers.get("Authorization") ?? "",
        )?.[1];

        const matches = sources.filter((entry) =>
          equalCredential(entry.token, token ?? ""),
        );

        const entry = matches.length === 1 ? matches[0] : undefined;

        if (!token || !entry) {
          return { allowed: false, response: failure(401, "unauthorized") };
        }

        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            headers.get("Content-Type") ?? "",
          )
        ) {
          return {
            allowed: false,
            response: failure(415, "unsupported_media_type"),
          };
        }

        const time = now();

        if (time >= entry.expires) {
          entry.count = 0;
          entry.expires = time + 60_000;
        }

        if (entry.count >= entry.rate) {
          return {
            allowed: false,
            response: failure(
              429,
              "rate_limited",
              Math.max(1, Math.ceil((entry.expires - time) / 1000)),
            ),
          };
        }

        entry.count++;

        return { allowed: true, caller: entry.source };
      },
      async handle(request, caller, signal) {
        if (!open) {
          return failure(503, "shutting_down");
        }

        const source = Schema.decodeUnknownResult(Source)(caller);

        if (Result.isFailure(source)) {
          return failure(401, "unauthorized");
        }

        let input: unknown;

        try {
          input = await request.json();
        } catch {
          return failure(400, "invalid_notification");
        }

        // The core decoder is authoritative and rejects all producer identity claims.
        const decoded = Schema.decodeUnknownResult(NotificationInput)(input);

        if (Result.isFailure(decoded)) {
          return failure(400, "invalid_notification");
        }

        try {
          const result = await Effect.runPromise(
            core.publish(source.success, decoded.success).pipe(Effect.result),
            { signal },
          );

          if (Result.isSuccess(result)) {
            return Response.json(result.success, {
              status: 202,
              headers: {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            });
          }

          return publishFailure(result.failure);
        } catch {
          return failure(503, "unavailable");
        }
      },
    });
  }

  return {
    routes,
    closeAdmission: () => {
      open = false;
    },
  };
}
