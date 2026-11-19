import { Schema } from "effect";
import { redactCredentials } from "../../credentials";
import { readCommand } from "./command";
import type { V1PullRequest } from "./types";

const ttl = 60_000;
const timeout = 4_000;
const checks = Schema.Struct({
  status: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
});
const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    url: Schema.String,
    title: Schema.String,
    state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
    isDraft: Schema.Boolean,
    statusCheckRollup: Schema.NullOr(Schema.Array(checks)),
  }),
);
const failures = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const completed = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

export function mapPullRequest(
  input: unknown,
  repository: string,
): V1PullRequest | null {
  try {
    const pr = decode(input);
    const url = new URL(pr.url);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.toLowerCase() !==
        `/${repository.toLowerCase()}/pull/${pr.number}`
    )
      return null;
    let result: V1PullRequest["checks"] = "none";
    for (const check of pr.statusCheckRollup ?? []) {
      const status =
        check.state ??
        (check.status === "COMPLETED" ? check.conclusion : undefined);
      if (status && failures.has(status)) {
        result = "failing";
        break;
      }
      if (!status || !completed.has(status)) result = "running";
      else if (result === "none") result = "passing";
    }
    return {
      number: pr.number,
      url: url.href,
      title: redactCredentials(pr.title, 180),
      state:
        pr.state === "OPEN"
          ? pr.isDraft
            ? "draft"
            : "open"
          : pr.state === "MERGED"
            ? "merged"
            : "closed",
      checks: result,
    };
  } catch {
    return null;
  }
}

/** Cached PR lookup. The caller always returns before auth or network I/O. */
export function createPullReader(
  now: () => number = Date.now,
  { run = readCommand, which = Bun.which } = {},
) {
  const cache = new Map<
    string,
    { expiresAt: number; value: V1PullRequest | null }
  >();
  const pending = new Set<string>();
  let auth:
    | { expiresAt: number; executable: Promise<string | null> }
    | undefined;
  const env = {
    ...process.env,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  };

  async function authenticate() {
    const executable = which("gh");
    if (!executable) return null;
    const result = await run(
      [executable, "auth", "status", "--hostname", "github.com"],
      { env, timeout },
    );
    return result?.code === 0 ? executable : null;
  }

  async function refresh(repository: string, branch: string) {
    if (!auth || auth.expiresAt <= now())
      auth = { expiresAt: now() + ttl, executable: authenticate() };
    const executable = await auth.executable;
    if (!executable) return null;
    const result = await run(
      [
        executable,
        "pr",
        "view",
        "--repo",
        repository,
        "--json",
        "number,url,title,state,isDraft,statusCheckRollup",
        "--",
        branch,
      ],
      { env, timeout },
    );
    if (result?.code !== 0) return null;
    try {
      return mapPullRequest(JSON.parse(result.stdout), repository);
    } catch {
      return null;
    }
  }

  return (repository: string, branch: string) => {
    const key = JSON.stringify([repository.toLowerCase(), branch]);
    const saved = cache.get(key);
    if (
      (!saved || saved.expiresAt <= now()) &&
      !pending.has(key) &&
      pending.size < 2
    ) {
      pending.add(key);
      void refresh(repository, branch)
        .catch(() => null)
        .then((value) => {
          // Keep a stale value during refresh. A later poll can fill a free slot.
          cache.delete(key);
          if (cache.size >= 500) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
          }
          cache.set(key, { value, expiresAt: now() + ttl });
          pending.delete(key);
        });
    }
    return saved?.value ?? null;
  };
}
