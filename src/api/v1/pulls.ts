import { Schema } from "effect";
import { redactCredentials } from "../../credentials";
import { readCommand } from "./command";
import type { V1PullRequest } from "./types";

const ttl = 60_000;
const timeout = 4_000;
const candidateLimit = 50;
const pullNumber = Schema.Int.check(Schema.isGreaterThan(0));
const checks = Schema.Struct({
  status: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
});
const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    number: pullNumber,
    url: Schema.String,
    title: Schema.String,
    state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
    isDraft: Schema.Boolean,
    statusCheckRollup: Schema.NullOr(Schema.Array(checks)),
  }),
);
const decodeCandidate = Schema.decodeUnknownOption(
  Schema.Struct({
    number: pullNumber,
    repository: Schema.NullOr(Schema.String),
  }),
);
const decodeHead = Schema.decodeUnknownSync(
  Schema.Struct({
    headRefName: Schema.String,
    headRepository: Schema.Struct({ name: Schema.String }),
    headRepositoryOwner: Schema.Struct({ login: Schema.String }),
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
    { expiresAt: number; value: V1PullRequest | null | undefined }
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
    if (!executable) return undefined;
    const owner = repository.slice(0, repository.indexOf("/"));
    const result = await run(
      [
        executable,
        "api",
        `repos/${repository}/pulls`,
        "--method",
        "GET",
        "--jq",
        "map({number, repository: .head.repo.full_name})",
        "--raw-field",
        "state=all",
        "--raw-field",
        `per_page=${candidateLimit}`,
        "--raw-field",
        `head=${owner}:${branch}`,
      ],
      { env, timeout },
    );
    if (result?.code !== 0) return undefined;
    try {
      const list: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(list)) return undefined;
      let incomplete = list.length >= candidateLimit;
      for (const entry of list) {
        const candidate = decodeCandidate(entry);
        if (candidate._tag === "None") {
          incomplete = true;
          continue;
        }
        const { number, repository: head } = candidate.value;
        if (head?.toLowerCase() !== repository) continue;
        const details = await run(
          [
            executable,
            "pr",
            "view",
            String(number),
            "--repo",
            repository,
            "--json",
            "number,url,title,state,isDraft,statusCheckRollup,headRefName,headRepository,headRepositoryOwner",
          ],
          { env, timeout },
        );
        if (details?.code !== 0) return undefined;
        const input: unknown = JSON.parse(details.stdout);
        const { headRefName, headRepository, headRepositoryOwner } =
          decodeHead(input);
        if (
          headRefName !== branch ||
          `${headRepositoryOwner.login}/${headRepository.name}`.toLowerCase() !==
            repository
        )
          return undefined;
        const pr = mapPullRequest(input, repository);
        return pr?.number === number ? pr : undefined;
      }
      return incomplete ? undefined : null;
    } catch {
      return undefined;
    }
  }

  return (repository: string, branch: string) => {
    const target = repository.toLowerCase();
    const key = JSON.stringify([target, branch]);
    const saved = cache.get(key);
    if (
      (!saved || saved.expiresAt <= now()) &&
      !pending.has(key) &&
      pending.size < 2
    ) {
      pending.add(key);
      void refresh(target, branch)
        .catch(() => undefined)
        .then((value) => {
          // A failed refresh leaves the last settled lookup intact.
          cache.delete(key);
          if (cache.size >= 500) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
          }
          cache.set(key, {
            value: value === undefined ? saved?.value : value,
            expiresAt: now() + ttl,
          });
          pending.delete(key);
        });
    }
    return saved?.value;
  };
}
