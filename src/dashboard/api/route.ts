import { Schema } from "effect";
import { settingsStruct } from "../../settings-schema";

export type ApiAuthorization<Caller> =
  | { readonly allowed: true; readonly caller: Caller }
  | { readonly allowed: false; readonly response: Response };

/** Trusted startup descriptors, not request-selected modules. */
export interface ApiRoute<Caller = unknown> {
  readonly owner: string;
  readonly method: "POST";
  readonly path: string;
  readonly limits: {
    readonly maxBodyBytes: number;
    readonly timeoutMs: number;
    readonly maxConcurrent: number;
  };
  /** Synchronous and headers-only. Never reads a body. */
  authorize(headers: Headers): ApiAuthorization<Caller>;
  handle(
    request: Request,
    caller: Caller,
    signal: AbortSignal,
  ): Promise<Response>;
}

const positive = Schema.Int.check(Schema.isGreaterThan(0));
const descriptor = settingsStruct({
  owner: Schema.String.check(
    Schema.isPattern(/^notify\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  ),
  method: Schema.Literal("POST"),
  path: Schema.String.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^\/v1\/notifications\/[A-Za-z0-9][A-Za-z0-9_-]*$/),
  ),
  limits: settingsStruct({
    maxBodyBytes: positive.check(Schema.isLessThanOrEqualTo(64 * 1024)),
    timeoutMs: positive.check(Schema.isLessThanOrEqualTo(20_000)),
    maxConcurrent: positive.check(Schema.isLessThanOrEqualTo(4)),
  }),
});

/** Validate before binding. Reserved namespaces cannot pass this allowlist. */
export function apiRoutes(routes: readonly ApiRoute[]) {
  const owners = new Set<string>();
  const paths = new Set<string>();
  return routes.map((route) => {
    const parsed = Schema.decodeUnknownSync(descriptor)({
      owner: route.owner,
      method: route.method,
      path: route.path,
      limits: route.limits,
    });
    const key = `${parsed.method} ${parsed.path}`;
    if (owners.has(parsed.owner) || paths.has(key))
      throw new Error("Duplicate API route owner or method/path");
    owners.add(parsed.owner);
    paths.add(key);
    return Object.freeze({
      ...parsed,
      limits: Object.freeze(parsed.limits),
      authorize: route.authorize.bind(route),
      handle: route.handle.bind(route),
    });
  });
}
