import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "pino";
import type { Config } from "../config";
import { checkCredentials, readConfiguration } from "./setup";

/** A fully validated configuration and its effective environment. */
export interface ReloadCandidate {
  readonly config: Config;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Reads and validates `path` with the `stargate config check` rules: schema,
 * Slack token presence/prefixes, IRC passwords and CA files. No provider is
 * called. `baseEnvironment` must be captured before the companion is loaded
 * into `process.env`, so changed and deleted companion values are visible.
 * The companion is read once; `process.env` is not changed.
 */
export async function readReloadCandidate(
  path: string,
  baseEnvironment: NodeJS.ProcessEnv,
  notificationReload = false,
): Promise<ReloadCandidate> {
  const config = await readConfiguration(path, notificationReload);

  const environment = await checkCredentials(
    path,
    config.bots,
    baseEnvironment,
    config.irc,
    config.notify,
    config.dataDirectory,
    config.agentDispatch,
    config.subspaceAgents,
  );

  return {
    config: {
      ...config,
      dataDirectory: resolve(dirname(resolve(path)), config.dataDirectory),
    },
    environment,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const child = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** Paths of differing leaves; arrays and type changes count as one leaf. */
function diff(current: unknown, next: unknown, path: string, out: string[]) {
  if (isRecord(current) && isRecord(next)) {
    for (const key of new Set([
      ...Object.keys(current),
      ...Object.keys(next),
    ])) {
      diff(current[key], next[key], child(path, key), out);
    }
  } else if (!isDeepStrictEqual(current, next)) {
    out.push(path);
  }
}

function fields(
  current: unknown,
  next: unknown,
  path: string,
  live: readonly string[],
  out: string[],
) {
  if (!isRecord(current) || !isRecord(next)) {
    diff(current, next, path, out);

    return;
  }

  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (!live.includes(key)) {
      diff(current[key], next[key], child(path, key), out);
    }
  }
}

/** Matches entries by id, so order is ignored. */
function byId<T extends { readonly id: string }>(
  path: string,
  current: readonly T[],
  next: readonly T[],
  compare: (path: string, current: T, next: T) => void,
  membership: "restart" | "live",
  out: string[],
) {
  const after = new Map(next.map((entry) => [entry.id, entry]));
  const before = new Set(current.map((entry) => entry.id));

  for (const entry of current) {
    const other = after.get(entry.id);

    if (other) {
      compare(`${path}[${entry.id}]`, entry, other);
    } else if (membership === "restart") {
      out.push(`${path}[${entry.id}]`);
    }
  }

  if (membership === "restart") {
    for (const id of after.keys()) {
      if (!before.has(id)) {
        out.push(`${path}[${id}]`);
      }
    }
  }
}

function compareIrcRegistration(
  path: string,
  before: Config["irc"][number],
  after: Config["irc"][number],
  out: string[],
) {
  fields(before, after, path, ["access", "transcription", "crew"], out);
  byId(
    `${path}.crew`,
    before.crew,
    after.crew,
    (member, a, b) => {
      diff(a, b, member, out);
    },
    "live",
    out,
  );
}

/**
 * Field paths, never values, that need a restart. Empty means the whole
 * candidate can be applied live. Live: an existing Slack bot's `access` and
 * `transcription`; an existing IRC registration's `access`, `transcription`
 * and crew additions/removals. Any other change, including a changed field of
 * an existing crew member, an added or removed bot or IRC registration, and
 * a changed or deleted environment value, is restart-only. New environment
 * names are allowed.
 */
export function restartRequired(
  current: ReloadCandidate,
  next: ReloadCandidate,
): string[] {
  const out: string[] = [];
  fields(current.config, next.config, "", ["bots", "irc"], out);
  byId(
    "bots",
    current.config.bots,
    next.config.bots,
    (path, before, after) => {
      fields(before, after, path, ["access", "transcription"], out);
    },
    "restart",
    out,
  );
  byId(
    "irc",
    current.config.irc,
    next.config.irc,
    (path, before, after) => {
      compareIrcRegistration(path, before, after, out);
    },
    "restart",
    out,
  );

  for (const [name, value] of Object.entries(current.environment)) {
    if (value !== undefined && next.environment[name] !== value) {
      out.push(`environment.${name}`);
    }
  }

  return out.toSorted();
}

const unchangedNote = "The running configuration is unchanged.";

const rejectedMessages = {
  busy: `Configuration reload refused: the runtime is busy. Try again later. ${unchangedNote}`,
  unavailable: `Configuration reload is unavailable. ${unchangedNote}`,
} as const;

const messages = {
  ...rejectedMessages,
  applied: "Configuration reloaded.",
  unchanged: "Configuration unchanged; nothing to reload.",
  invalid: `Configuration reload rejected: invalid configuration or credentials. Run stargate config check for details. ${unchangedNote}`,
  failed: `Configuration reload failed. ${unchangedNote}`,
} as const;

/** Runtime refusal before commit; the message is fixed and safe to log. */
export class ReloadRejected extends Error {
  public constructor(public readonly status: keyof typeof rejectedMessages) {
    super(rejectedMessages[status]);
    this.name = "ReloadRejected";
  }
}

export type ReloadResult =
  | { readonly status: keyof typeof messages; readonly message: string }
  | {
      readonly status: "restart-required";
      readonly message: string;
      readonly paths: readonly string[];
    };

/** A candidate that needs no runtime call, or undefined if it must apply. */
function compareCandidates(current: ReloadCandidate, next: ReloadCandidate) {
  const paths = restartRequired(current, next);

  if (paths.length > 0) {
    return {
      status: "restart-required",
      message: `Configuration reload refused: restart required for ${paths.join(", ")}. ${unchangedNote}`,
      paths,
    } as const;
  }

  if (isDeepStrictEqual(current, next)) {
    return "unchanged" as const;
  }

  return;
}

/**
 * Serialized reloads: read, compare with the current candidate, then hand a
 * live-safe candidate to the runtime. `current` advances only after `apply`
 * resolves. Results and logs carry fixed messages and field paths only.
 */
export class ConfigReload {
  #current: ReloadCandidate;
  #apply: ((next: ReloadCandidate) => Promise<void>) | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  public constructor(
    initial: ReloadCandidate,
    private readonly read: () => Promise<ReloadCandidate>,
    private readonly log: Pick<Logger, "info" | "warn">,
  ) {
    this.#current = initial;
  }

  public get current() {
    return this.#current;
  }

  /** One runtime listener; the returned function removes it. */
  public listen(apply: (next: ReloadCandidate) => Promise<void>) {
    this.#apply = apply;

    return () => {
      if (this.#apply === apply) {
        this.#apply = undefined;
      }
    };
  }

  /** Never rejects; each request waits for the previous one. */
  public request(): Promise<ReloadResult> {
    const result = this.#queue.then(() => this.#reload());
    this.#queue = result;

    return result;
  }

  /** Later and pending requests become unavailable before they apply. */
  public close() {
    this.#closed = true;
    this.#apply = undefined;
  }

  async #reload(): Promise<ReloadResult> {
    try {
      if (this.#closed) {
        return this.#report("unavailable");
      }

      let next: ReloadCandidate;

      try {
        next = await this.read();
      } catch {
        return this.#report("invalid");
      }

      const apply = this.#apply;

      if (this.#closed || !apply) {
        return this.#report("unavailable");
      }

      const comparison = compareCandidates(this.#current, next);

      if (comparison === "unchanged") {
        return this.#report(comparison);
      }

      if (comparison) {
        this.log.warn({ paths: comparison.paths }, comparison.message);

        return comparison;
      }

      try {
        await apply(next);
      } catch (error) {
        return this.#report(
          error instanceof ReloadRejected ? error.status : "failed",
        );
      }

      this.#current = next;

      return this.#report("applied");
    } catch {
      return this.#report("failed");
    }
  }

  #report(status: keyof typeof messages): ReloadResult {
    const message = messages[status];

    if (status === "applied" || status === "unchanged") {
      this.log.info(message);
    } else {
      this.log.warn(message);
    }

    return { status, message };
  }
}
