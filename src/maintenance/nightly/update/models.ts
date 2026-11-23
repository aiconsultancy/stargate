import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { StepError } from "../exec";
import {
  formatRef,
  type ModelRef,
  newerModels,
  parseModel,
  parseRef,
} from "./versions";

/** Old model ID → new model ID, for refs whose provider is configured. */
export type Upgrades = ReadonlyMap<string, string>;

export type Change = { target: string; from: string; to: string };

/**
 * Candidates for every model in use, newest first. Unknown families, other
 * providers and equal or older versions never appear.
 */
export function upgradeCandidates(
  inUse: readonly ModelRef[],
  catalog: readonly string[],
  families: readonly string[],
  providers: readonly string[],
) {
  const result = new Map<string, string[]>();

  for (const ref of inUse) {
    if (!providers.includes(ref.providerID) || result.has(ref.id)) continue;
    const newer = newerModels(ref.id, catalog, families);

    if (newer.length) result.set(ref.id, newer);
  }

  return result;
}

/**
 * Probe candidates newest first; the first that passes wins. At most
 * `limit` probes per current model. A failed probe never selects an older
 * candidate than the current model.
 */
export async function chooseUpgrades(
  candidates: ReadonlyMap<string, readonly string[]>,
  probe: (id: string) => Promise<boolean>,
  limit: number,
) {
  const chosen = new Map<string, string>();
  const failed: { from: string; to: string }[] = [];
  const results = new Map<string, boolean>();

  for (const [from, list] of candidates) {
    for (const to of list.slice(0, limit)) {
      let passed = results.get(to);

      if (passed === undefined) {
        passed = await probe(to);
        results.set(to, passed);
      }

      if (passed) {
        chosen.set(from, to);
        break;
      }

      failed.push({ from, to });
    }
  }

  return { chosen, failed };
}

export function upgradeRef(
  value: string,
  upgrades: Upgrades,
  providers: readonly string[],
) {
  const ref = parseRef(value);

  if (!ref || !providers.includes(ref.providerID)) return null;
  const next = upgrades.get(ref.id);

  return next ? formatRef({ ...ref, id: next }) : null;
}

type Json = unknown;

const isObject = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Rewrites must not reformat a file; a different layout is refused. */
function parseCanonical(text: string): Json {
  let parsed: Json;

  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new StepError("config-format");
  }

  if (`${JSON.stringify(parsed, null, 2)}\n` !== text)
    throw new StepError("config-format");

  return parsed;
}

function setString(
  owner: Record<string, Json>,
  key: string,
  pointer: string,
  upgrades: Upgrades,
  providers: readonly string[],
  changes: Change[],
) {
  const value = owner[key];

  if (typeof value !== "string") return;
  const next = upgradeRef(value, upgrades, providers);

  if (!next) return;
  owner[key] = next;
  changes.push({ target: pointer, from: value, to: next });
}

/** Captain.model and OpenCode crew models; Pi `backend` entries are never touched. */
function upgradeTeamObject(
  team: Json,
  pointer: string,
  upgrades: Upgrades,
  providers: readonly string[],
  changes: Change[],
) {
  if (!isObject(team)) return;

  if (isObject(team["captain"]))
    setString(
      team["captain"],
      "model",
      `${pointer}/captain/model`,
      upgrades,
      providers,
      changes,
    );
  const crew = team["crew"];

  if (!Array.isArray(crew)) return;
  crew.forEach((member, index) => {
    if (isObject(member) && member["backend"] === undefined)
      setString(
        member,
        "model",
        `${pointer}/crew/${index}/model`,
        upgrades,
        providers,
        changes,
      );
  });
}

/** Team.json used by `stargate crew init`. */
export function upgradeTeamFile(
  text: string,
  upgrades: Upgrades,
  providers: readonly string[],
) {
  const parsed = parseCanonical(text);
  const changes: Change[] = [];
  upgradeTeamObject(parsed, "", upgrades, providers, changes);

  return { text: `${JSON.stringify(parsed, null, 2)}\n`, changes };
}

/** Generated captain/crew opencode.json: default model, agents and plugin team. */
export function upgradeOpenCodeProfile(
  text: string,
  upgrades: Upgrades,
  providers: readonly string[],
) {
  const parsed = parseCanonical(text);
  const changes: Change[] = [];

  if (isObject(parsed)) {
    setString(parsed, "model", "/model", upgrades, providers, changes);
    const agents = parsed["agents"];

    if (isObject(agents))
      for (const [name, agent] of Object.entries(agents))
        if (isObject(agent))
          setString(
            agent,
            "model",
            `/agents/${name}/model`,
            upgrades,
            providers,
            changes,
          );
    const plugins = parsed["plugins"];

    if (Array.isArray(plugins))
      plugins.forEach((plugin, index) => {
        if (isObject(plugin) && isObject(plugin["options"]))
          upgradeTeamObject(
            plugin["options"]["team"],
            `/plugins/${index}/options/team`,
            upgrades,
            providers,
            changes,
          );
      });
  }

  return { text: `${JSON.stringify(parsed, null, 2)}\n`, changes };
}

/** Collect model refs from a JSON document's `model` fields (for planning). */
export function modelRefs(text: string) {
  const refs: ModelRef[] = [];

  const walk = (value: Json, key?: string) => {
    if (key === "backend" && isObject(value) && value["type"] === "pi-durable")
      return;

    if (typeof value === "string" && key === "model") {
      const ref = parseRef(value);

      if (ref) refs.push(ref);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (isObject(value)) {
      if (
        key === "model" &&
        typeof value["providerID"] === "string" &&
        typeof value["id"] === "string"
      )
        refs.push({ providerID: value["providerID"], id: value["id"] });

      for (const [name, item] of Object.entries(value)) walk(item, name);
    }
  };

  try {
    walk(JSON.parse(text));
  } catch {
    // Invalid text keeps the references found before the failure.
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Global child-agent profiles (~/.config/opencode/agent-profiles)

export type ProfileFolder = {
  routesText: string;
  profileText: string;
  /** `<name>.md` agent definitions. */
  files: Record<string, string>;
};

export type ProfilesSnapshot = {
  root: string;
  agentsDirectory: string;
  /** Folder that `agent-profiles/current` selects, if any. */
  current: string | null;
  folders: Record<string, ProfileFolder>;
  /** Existing entries in the agents directory. */
  links: Record<string, string | null>;
};

/** Profile folders maintenance manages, and the agent files in them. */
export const managedFolder = /^(?:max-subs|[0-9]{2}-[a-z0-9-]+)$/;
export const agentFile = /^[a-z0-9][a-z0-9-]*-subagent\.md$/;

export async function readProfiles(root: string): Promise<ProfilesSnapshot> {
  const agentsDirectory = join(root, "..", "agents");
  const folders: Record<string, ProfileFolder> = {};

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !managedFolder.test(entry.name)) continue;
    const folder = join(root, entry.name);
    const files: Record<string, string> = {};

    for (const file of await readdir(folder))
      if (agentFile.test(file))
        files[file] = await readFile(join(folder, file), "utf8");
    folders[entry.name] = {
      routesText: await readFile(join(folder, "routes.json"), "utf8"),
      profileText: await readFile(join(folder, "PROFILE"), "utf8"),
      files,
    };
  }

  const links: Record<string, string | null> = {};

  for (const name of await readdir(agentsDirectory).catch(
    () => [] as string[],
  )) {
    if (!name.endsWith("-subagent.md")) continue;
    const path = join(agentsDirectory, name);
    links[name] = (await lstat(path)).isSymbolicLink()
      ? await readlink(path)
      : null;
  }

  const current = await readlink(join(root, "current"))
    .then((target) => basename(target))
    .catch(() => null);

  return { root, agentsDirectory, current, folders, links };
}

type Route = { name: string; model: string };

function routesOf(manifest: Json): Route[] {
  if (!isObject(manifest)) throw new StepError("config-format");

  const list =
    manifest["version"] === 1
      ? manifest["routes"]
      : manifest["version"] === 2 && Array.isArray(manifest["tiers"])
        ? manifest["tiers"].flatMap((tier): Json[] =>
            isObject(tier) && Array.isArray(tier["routes"])
              ? tier["routes"]
              : [],
          )
        : undefined;

  if (!Array.isArray(list)) throw new StepError("config-format");

  return list.map((route) => {
    if (
      !isObject(route) ||
      typeof route["name"] !== "string" ||
      typeof route["model"] !== "string"
    )
      throw new StepError("config-format");

    return route as Route;
  });
}

export function refsInProfiles(snapshot: ProfilesSnapshot) {
  const refs: ModelRef[] = [];

  for (const folder of Object.values(snapshot.folders))
    for (const route of routesOf(JSON.parse(folder.routesText))) {
      const ref = parseRef(route.model);

      if (ref) refs.push(ref);
    }

  return refs;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace `provider/old` refs (with or without variant) by `provider/new`. */
function replaceRefs(
  text: string,
  upgrades: Upgrades,
  providers: readonly string[],
) {
  let next = text;

  for (const [from, to] of upgrades)
    for (const provider of providers)
      next = next.replace(
        new RegExp(
          `${escapeRegExp(`${provider}/${from}`)}(?=[#\\s)|,"]|$)`,
          "gm",
        ),
        `${provider}/${to}`,
      );

  return next;
}

function setDisabled(content: string, disabled: boolean) {
  if (!content.startsWith("---\n")) throw new StepError("config-format");
  const end = content.indexOf("\n---\n", 3);

  if (end < 0) throw new StepError("config-format");

  const head = content
    .slice(4, end)
    .split("\n")
    .filter((line) => line !== "disabled: true");

  if (disabled) head.push("disabled: true");

  return `---\n${head.join("\n")}${content.slice(end)}`;
}

/**
 * Upgrade child-agent routes in every managed profile. Agent names carry the
 * model version (`opus-5-5-high-subagent`), so an upgraded route gets a new
 * name (`opus-5-6-high-subagent`) instead of hiding a new model under an old
 * name. Every folder gains a file for each new name (disabled where it is not
 * routed); old names that are no longer routed are disabled. Agent links are
 * only added. Returns file writes, new links and per-route changes.
 */
export function upgradeProfiles(
  snapshot: ProfilesSnapshot,
  upgrades: Upgrades,
  providers: readonly string[],
) {
  const renames = new Map<string, { name: string; from: string; to: string }>();
  const skipped: Change[] = [];

  for (const folder of Object.values(snapshot.folders))
    for (const route of routesOf(JSON.parse(folder.routesText))) {
      const to = upgradeRef(route.model, upgrades, providers);
      const ref = parseRef(route.model);

      if (!to || !ref) continue;
      const toRef = parseRef(to);
      const oldToken = parseModel(ref.id)?.token;
      const newToken = toRef ? parseModel(toRef.id)?.token : undefined;

      if (!oldToken || !newToken || !route.name.startsWith(`${oldToken}-`)) {
        skipped.push({ target: route.name, from: route.model, to });
        continue;
      }

      const name = `${newToken}${route.name.slice(oldToken.length)}`;
      const prior = renames.get(route.name);

      if (prior && (prior.name !== name || prior.to !== to))
        throw new StepError("config-format");
      renames.set(route.name, { name, from: route.model, to });
    }

  const writes: { path: string; content: string }[] = [];
  const changes: Change[] = [];
  const folderRoutes: Record<string, Route[]> = {};

  for (const [folderName, folder] of Object.entries(snapshot.folders)) {
    const manifest = JSON.parse(folder.routesText) as Json;
    const routes = routesOf(manifest);
    folderRoutes[folderName] = routes;
    let changed = false;

    for (const route of routes) {
      const rename = renames.get(route.name);

      if (!rename || route.model !== rename.from) continue;
      changes.push({
        target: `${folderName}/${route.name}`,
        from: rename.from,
        to: rename.to,
      });
      route.name = rename.name;
      route.model = rename.to;
      changed = true;
    }

    const routed = new Set(routes.map((route) => route.name));

    for (const [oldName, rename] of renames) {
      const oldFile = `${oldName}.md`;
      const newFile = `${rename.name}.md`;
      const original = folder.files[oldFile];

      if (original === undefined) continue;

      const content = setDisabled(
        replaceRefs(original, upgrades, providers),
        !routed.has(rename.name),
      );

      const existing = folder.files[newFile];

      if (existing !== undefined && existing !== content)
        throw new StepError("config-format");

      if (existing === undefined)
        writes.push({
          path: join(snapshot.root, folderName, newFile),
          content,
        });

      if (!routed.has(oldName)) {
        const disabled = setDisabled(original, true);

        if (disabled !== original)
          writes.push({
            path: join(snapshot.root, folderName, oldFile),
            content: disabled,
          });
      }

      changed = true;
    }

    if (!changed) continue;
    writes.push({
      path: join(snapshot.root, folderName, "routes.json"),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    let profile = replaceRefs(folder.profileText, upgrades, providers);

    for (const [oldName, rename] of renames)
      profile = profile.replace(
        new RegExp(`\\b${escapeRegExp(oldName)}\\b`, "g"),
        rename.name,
      );
    writes.push({
      path: join(snapshot.root, folderName, "PROFILE"),
      content: profile,
    });
  }

  const links = [...renames.values()]
    .map(({ name }) => `${name}.md`)
    .filter((file, index, all) => all.indexOf(file) === index)
    .filter((file) => !(file in snapshot.links))
    .map((file) => ({
      path: join(snapshot.agentsDirectory, file),
      target: `../agent-profiles/current/${file}`,
    }));

  /** New agents that the selected profile routes: the ones OpenCode loads. */
  const live = (snapshot.current ? (folderRoutes[snapshot.current] ?? []) : [])
    .filter((route) =>
      [...renames.values()].some((rename) => rename.name === route.name),
    )
    .map((route) => ({ name: route.name, model: route.model }));

  return { writes, links, changes, skipped, renames, live };
}
