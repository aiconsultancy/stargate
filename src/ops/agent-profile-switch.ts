/** Explicit operator helper. Never imported by gateway startup or maintenance. */
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Service } from "@opencode/client/service";
import { Result, Schema } from "effect";
import {
  settingsPattern,
  settingsPlainRecord,
} from "../config/settings-schema";

const nameSchema = Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9-]*$/));

const referenceSchema = Schema.String.check(
  settingsPattern(/^[^/#\s]+\/[^#\s]+#[^#\s]+$/),
);

const routeSchema = Schema.Struct({ name: nameSchema, model: referenceSchema });

const weightedRouteSchema = Schema.Struct({
  ...routeSchema.fields,
  weight: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(3),
  ),
});

const manifestSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    profile: nameSchema,
    routes: Schema.Array(routeSchema).check(Schema.isBetweenLength(5, 5)),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    profile: nameSchema,
    tiers: Schema.Array(
      Schema.Struct({
        purpose: Schema.String.check(Schema.isMinCodePoints(1)),
        routes: Schema.Array(weightedRouteSchema).check(Schema.isMinLength(1)),
      }),
    ).check(Schema.isBetweenLength(5, 5)),
  }),
]);

const modelSchema = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  enabled: Schema.Boolean,
  capabilities: Schema.Struct({ tools: Schema.Boolean }),
  variants: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const agentSchema = Schema.Struct({
  id: Schema.String,
  mode: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Schema.String,
      id: Schema.String,
      variant: Schema.optional(Schema.String),
    }),
  ),
});

type Route = typeof routeSchema.Type;

function modelReference(reference: string) {
  const slash = reference.indexOf("/");
  const hash = reference.lastIndexOf("#");

  return {
    providerID: reference.slice(0, slash),
    id: reference.slice(slash + 1, hash),
    variant: reference.slice(hash + 1),
  };
}

export type ProfileApi = (
  method: "get" | "post",
  path: string,
  signal: AbortSignal,
) => Promise<unknown>;

export interface ProfileSwitchOptions {
  configDirectory: string;
  directory: string;
  profile: string;
  serviceFile?: string;
  /** Explicit opt-in to warning-and-proceed reload while work is active. Default false. */
  hot?: boolean;
  /** Conservative CLI alias; cannot be combined with hot. Idle checks are the default. */
  requireIdle?: boolean;
  api?: ProfileApi;
  warn?: (message: string) => void;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function decode<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  input: unknown,
  message: string,
): S["Type"] {
  const result = Schema.decodeUnknownResult(schema)(input);

  if (Result.isFailure(result)) {
    throw new Error(message);
  }

  return result.success;
}

async function jsonFile(path: string): Promise<unknown> {
  await realFile(path);

  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Cannot read profile JSON.");
  }
}

async function realFile(path: string) {
  if (!(await lstat(path)).isFile()) {
    throw new Error("Profile file must be a real file.");
  }
}

async function realDirectory(path: string) {
  if (!(await lstat(path)).isDirectory()) {
    throw new Error("Profile and agents directories must be real directories.");
  }
}

async function agentFrontmatter(path: string): Promise<unknown> {
  await realFile(path);
  const content = await readFile(path, "utf8");
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];

  try {
    return header === undefined ? undefined : Bun.YAML.parse(header);
  } catch {
    throw new Error("Invalid agent frontmatter.");
  }
}

async function loadRoutes(root: string, name: string) {
  decode(nameSchema, name, "Invalid profile name.");

  if (name === "current") {
    throw new Error("Reserved profile name.");
  }

  const folder = join(root, name);
  await realDirectory(folder);

  const manifest = decode(
    manifestSchema,
    await jsonFile(join(folder, "routes.json")),
    "Invalid profile manifest.",
  );

  if (manifest.profile !== name) {
    throw new Error("Profile name differs from manifest.");
  }

  const routes =
    manifest.version === 1
      ? manifest.routes
      : manifest.tiers.flatMap((tier) => tier.routes);

  const unique = new Map<string, Route>();

  for (const route of routes) {
    const previous = unique.get(route.name);

    if (
      previous &&
      (previous.model !== route.model || manifest.version === 1)
    ) {
      throw new Error("Duplicate or conflicting agent route.");
    }

    unique.set(route.name, route);
  }

  const availability = decode(
    Schema.Struct({ missing: Schema.Array(Schema.Unknown) }),
    await jsonFile(join(folder, "availability.json")),
    "Invalid profile availability.",
  );

  if (availability.missing.length > 0) {
    throw new Error("Profile has unavailable routes.");
  }

  for (const route of unique.values()) {
    const agent = decode(
      Schema.Struct({
        mode: Schema.Literal("subagent"),
        model: referenceSchema,
        disabled: Schema.optional(Schema.Literal(false)),
        variant: Schema.optional(Schema.Never),
      }),
      await agentFrontmatter(join(folder, `${route.name}.md`)),
      "Agent is disabled or has invalid frontmatter.",
    );

    if (agent.model !== route.model) {
      throw new Error("Agent model differs from manifest.");
    }
  }

  const files = new Set(
    (await readdir(folder)).filter((file) => file.endsWith(".md")),
  );

  for (const file of files) {
    decode(nameSchema, file.slice(0, -3), "Invalid agent filename.");

    if (!unique.has(file.slice(0, -3))) {
      decode(
        Schema.Struct({
          mode: Schema.Literal("subagent"),
          disabled: Schema.Literal(true),
        }),
        await agentFrontmatter(join(folder, file)),
        "Extra agents must be disabled subagent placeholders.",
      );
    }
  }

  return { routes: [...unique.values()], files };
}

async function checkAgentLinks(
  config: string,
  routes: Route[],
  files: Set<string>,
) {
  const agents = join(config, "agents");
  await realDirectory(agents);

  for (const file of routes.map((route) => `${route.name}.md`)) {
    const path = join(agents, file);

    if (
      !(await lstat(path)).isSymbolicLink() ||
      (await readlink(path)) !== `../agent-profiles/current/${file}`
    ) {
      throw new Error(
        "Install managed agent links before switching; existing agents are never replaced.",
      );
    }
  }

  for (const file of await readdir(agents)) {
    const path = join(agents, file);

    if (!(await lstat(path)).isSymbolicLink()) {
      continue;
    }

    const target = await readlink(path);
    const prefix = "../agent-profiles/current/";

    if (target.startsWith(prefix) && !files.has(target.slice(prefix.length))) {
      throw new Error(
        "Selected profile would leave a managed agent link without a validated target.",
      );
    }
  }
}

async function selectorTarget(path: string) {
  if (!(await lstat(path)).isSymbolicLink()) {
    throw new Error("Current selector must be a symlink.");
  }

  const target = decode(
    nameSchema,
    await readlink(path),
    "Selector has an unmanaged target.",
  );

  if (target === "current") {
    throw new Error("Reserved profile name.");
  }

  return target;
}

async function replaceLink(path: string, target: string) {
  const temporary = `${path}.new-${randomUUID()}`;
  await symlink(target, temporary);

  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    });
  }
}

const atLocation = (path: string, directory: string | undefined) =>
  directory === undefined
    ? path
    : `${path}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`;

/** Discovery never starts, stops or recovers a server. Cache this exact endpoint. */
export function createProfileApi(
  serviceFile?: string,
  discover = Service.discover,
  request: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): ProfileApi {
  let connection: ReturnType<typeof Service.discover> | undefined;

  return async (method, path, signal) => {
    try {
      signal.throwIfAborted();
      connection ??= discover(serviceFile ? { file: serviceFile } : {});
      const endpoint = await connection;

      if (!endpoint) {
        throw new Error("No healthy registered service.");
      }

      const response = await request(new URL(path, endpoint.url), {
        method: method.toUpperCase(),
        headers:
          Service.headers({
            url: endpoint.url,
            ...(endpoint.auth && { auth: endpoint.auth }),
          }) ?? {},
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      });

      if (!response.ok) {
        throw new Error("Unsuccessful API response.");
      }

      const body = await response.text();

      const value: unknown = body.trim() ? JSON.parse(body) : null;

      return value;
    } catch {
      throw new Error(
        `OpenCode API failed: ${method} ${path.split("?")[0]}. Check the registered service; response details withheld.`,
      );
    }
  };
}

/** Switch only an already installed profile; no session or provider mutations. */
export async function switchAgentProfile(
  options: ProfileSwitchOptions,
): Promise<void> {
  if (options.hot && options.requireIdle) {
    throw new Error("Choose --hot or --require-idle, not both.");
  }

  const root = join(options.configDirectory, "agent-profiles");
  await realDirectory(root);
  const lock = join(root, ".switch.lock");
  // EEXIST fails closed; never remove another operation's lock.
  await mkdir(lock);
  const selector = join(root, "current");
  const api = options.api ?? createProfileApi(options.serviceFile);
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now ?? Date.now;

  const sleep =
    options.sleep ??
    (async (ms, signal) => {
      await setTimeout(ms, undefined, { signal });
    });

  let previous: string | undefined;
  let changed = false;

  try {
    signal.throwIfAborted();
    previous = await selectorTarget(selector);
    await realDirectory(join(root, previous));
    const { routes, files } = await loadRoutes(root, options.profile);
    await checkAgentLinks(options.configDirectory, routes, files);

    const loaded = decode(
      Schema.Array(
        Schema.Struct({
          directory: Schema.String.check(Schema.isMinCodePoints(1)),
        }),
      ),
      await api("get", "/api/debug/location", signal),
      "Cannot enumerate loaded locations.",
    );

    const locations = [
      ...new Set([
        undefined,
        options.directory,
        ...loaded.map((location) => location.directory),
      ]),
    ];

    for (const directory of locations) {
      const response = decode(
        Schema.Struct({ data: Schema.Array(modelSchema) }),
        await api("get", atLocation("/api/model", directory), signal),
        "Cannot verify live model catalog.",
      );

      for (const route of routes) {
        const { providerID, id, variant } = modelReference(route.model);

        const model = response.data.find(
          (model) => model.providerID === providerID && model.id === id,
        );

        if (
          !model?.enabled ||
          !model.capabilities.tools ||
          !model.variants.some((item) => item.id === variant)
        ) {
          throw new Error(
            "Route model, tools or variant unavailable; no provider fallback.",
          );
        }
      }
    }

    const readiness = async () => {
      const active = decode(
        Schema.Struct({
          data: settingsPlainRecord(Schema.String, Schema.Unknown),
        }),
        await api("get", "/api/session/active", signal),
        "Cannot verify active sessions.",
      );

      const running = Object.keys(active.data).length;
      let pending = 0;

      for (const directory of locations) {
        for (const path of ["/api/form", "/api/permission/request"]) {
          const response = decode(
            Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
            await api("get", atLocation(path, directory), signal),
            "Cannot verify pending forms or permissions.",
          );

          pending += response.data.length;
        }
      }

      if (!options.hot && (running || pending)) {
        throw new Error(
          "Service has active sessions or pending requests. Retry when idle.",
        );
      }

      return { running, pending };
    };

    const { running, pending } = await readiness();
    (options.warn ?? console.error)(
      `Warning: profile reload affects all loaded locations (${running} running sessions, ${pending} pending requests observed). Possible disruption: running sessions continue at the next step boundary; pending forms and permissions are cancelled.`,
    );
    // Recheck immediately before mutation. This is not an admission lock on OpenCode.
    await readiness();
    signal.throwIfAborted();

    if ((await selectorTarget(selector)) !== previous) {
      throw new Error("Selector changed outside this operation.");
    }

    if (previous !== options.profile) {
      await replaceLink(selector, options.profile);
      changed = true;
    }

    await api("post", "/api/location/reload", signal);
    const deadline = now() + 10_000;
    const verifySignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);

    for (;;) {
      verifySignal.throwIfAborted();
      let differs = false;

      for (const directory of locations) {
        const response = decode(
          Schema.Struct({ data: Schema.Array(agentSchema) }),
          await api("get", atLocation("/api/agent", directory), verifySignal),
          "Cannot verify live agent catalog.",
        );

        for (const route of routes) {
          const { providerID, id, variant } = modelReference(route.model);
          const agent = response.data.find((agent) => agent.id === route.name);
          differs ||=
            agent?.mode !== "subagent" ||
            agent.model?.providerID !== providerID ||
            agent.model?.id !== id ||
            agent.model?.variant !== variant;
        }

        if (differs) {
          break;
        }
      }

      if (!differs) {
        break;
      }

      if (now() >= deadline) {
        throw new Error("Live route differs after 10 seconds.");
      }

      await sleep(Math.min(250, deadline - now()), verifySignal);
    }
  } catch (error) {
    let rollback = "";

    if (changed && previous !== undefined) {
      try {
        if ((await selectorTarget(selector)) !== options.profile) {
          throw new Error("Selector changed outside this operation.");
        }

        await replaceLink(selector, previous);
        await api("post", "/api/location/reload", AbortSignal.timeout(15_000));
        rollback = " Previous selector restored; service reloaded.";
      } catch {
        rollback = " Rollback needs operator review; no state was deleted.";
      }
    }

    throw new Error(
      `${error instanceof Error ? error.message : "Profile switch failed."}${rollback}`,
    );
  } finally {
    await rmdir(lock);
  }
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        "config-dir": { type: "string" },
        "service-file": { type: "string" },
        directory: { type: "string" },
        hot: { type: "boolean", default: false },
        "require-idle": { type: "boolean" },
        help: { type: "boolean" },
      },
    });

    if (values.help) {
      console.log(
        "Usage: bun run src/ops/agent-profile-switch.ts PROFILE [--config-dir PATH] [--directory PATH] [--service-file PATH] [--hot | --require-idle]\nRequires idle sessions and no pending requests by default. --hot explicitly enables warning-and-proceed reload during active work. All loaded locations are affected.",
      );
    } else {
      if (positionals.length !== 1 || !positionals[0]) {
        throw new Error("Specify one installed profile. Use --help for usage.");
      }

      await switchAgentProfile({
        configDirectory: resolve(
          values["config-dir"] ??
            join(
              process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
              "opencode",
            ),
        ),
        directory: resolve(values.directory ?? process.cwd()),
        profile: positionals[0],
        hot: values.hot ?? false,
        requireIdle: values["require-idle"] ?? false,
        ...(values["service-file"] && {
          serviceFile: resolve(values["service-file"]),
        }),
      });
      console.log(
        "Child-agent profile switched and verified. Session models and model bias are unchanged.",
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Profile switch failed.",
    );
    process.exitCode = 1;
  }
}
