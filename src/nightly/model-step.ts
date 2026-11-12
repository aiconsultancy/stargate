import { readFile } from "node:fs/promises";
import type { MaintenanceConfig } from "./config";
import type { Crew } from "./crews";
import { reasonOf } from "./exec";
import { probeModel, proxyModels } from "./host";
import type { Journal } from "./journal";
import {
  chooseUpgrades,
  modelRefs,
  type ProfilesSnapshot,
  readProfiles,
  refsInProfiles,
  upgradeCandidates,
  upgradeOpenCodeProfile,
  upgradeProfiles,
  upgradeTeamFile,
} from "./models";
import type { OpenCodeControl } from "./opencode";
import type { ModelChange } from "./report";
import { formatRef, type ModelRef } from "./versions";

export type Session = {
  id: string;
  scope: "captain-session" | "crew-session";
};
type Settings = NonNullable<MaintenanceConfig["models"]>;
type Proxy = NonNullable<MaintenanceConfig["proxy"]>;

/** Everything read once for model planning; rebuilt into work as needed. */
export type ModelInputs = {
  providers: string[];
  profilesRoot: string | undefined;
  snapshot: ProfilesSnapshot | undefined;
  documents: {
    path: string;
    scope: "team-file" | "opencode-config";
    text: string;
  }[];
  live: { session: Session; model: ModelRef }[];
  refs: ModelRef[];
};

export type ModelWork = {
  upgrades: Map<string, string>;
  files: { path: string; text: string }[];
  profileLinks: { path: string; target: string }[];
  /** New agents routed by the selected profile, verified after reload. */
  agents: { name: string; model: string }[];
  sessions: { session: Session; from: ModelRef; to: ModelRef }[];
  /** Planned and skipped entries for the report. */
  changes: ModelChange[];
};

export async function readModelInputs(input: {
  settings: Settings;
  crews: readonly Crew[];
  sessions: readonly Session[];
  connect: () => Promise<OpenCodeControl>;
  signal: AbortSignal;
}): Promise<ModelInputs> {
  const { settings } = input;
  const refs: ModelRef[] = [];
  let snapshot: ProfilesSnapshot | undefined;
  if (settings.agentProfiles) {
    snapshot = await readProfiles(settings.agentProfiles);
    refs.push(...refsInProfiles(snapshot));
  }
  const documents: ModelInputs["documents"] = [];
  for (const path of settings.teamFiles)
    documents.push({
      path,
      scope: "team-file",
      text: await readFile(path, "utf8"),
    });
  for (const crew of input.crews)
    for (const root of crew.roots)
      documents.push({
        path: root.configPath,
        scope: "opencode-config",
        text: await readFile(root.configPath, "utf8"),
      });
  for (const document of documents) refs.push(...modelRefs(document.text));
  const live: ModelInputs["live"] = [];
  const opencode = await input.connect().catch(() => undefined);
  if (opencode)
    for (const session of input.sessions.slice(0, 500)) {
      const model = await opencode
        .sessionModel(session.id, input.signal)
        .catch(() => null);
      if (model) {
        live.push({ session, model });
        refs.push(model);
      }
    }
  return {
    providers: settings.providers,
    profilesRoot: settings.agentProfiles,
    snapshot,
    documents,
    live,
    refs,
  };
}

/**
 * Candidates newest first; in run mode each must pass a proxy probe and be
 * in OpenCode's live catalog (globally and at every crew location) with
 * every variant in use. Returns the chosen map and the rejections.
 */
export async function selectModelUpgrades(input: {
  inputs: ModelInputs;
  settings: Settings;
  proxy: Proxy;
  crews: readonly Crew[];
  probe: boolean;
  connect: () => Promise<OpenCodeControl>;
  signal: AbortSignal;
}) {
  const { inputs, settings, proxy, signal } = input;
  const catalog = await proxyModels(proxy, signal);
  const candidates = upgradeCandidates(
    inputs.refs,
    catalog,
    settings.families,
    inputs.providers,
  );
  const rejected: ModelChange[] = [];
  if (!input.probe) {
    const upgrades = new Map<string, string>();
    for (const [from, list] of candidates)
      if (list[0]) upgrades.set(from, list[0]);
    return { upgrades, rejected };
  }
  const { chosen, failed } = await chooseUpgrades(
    candidates,
    (id) => probeModel(proxy, id, signal),
    settings.probes,
  );
  for (const miss of failed)
    rejected.push({
      scope: "catalog",
      target: "proxy-probe",
      from: miss.from,
      to: miss.to,
      status: "skipped",
      reason: "probe-failed",
    });
  const opencode = chosen.size
    ? await input.connect().catch(() => undefined)
    : undefined;
  const locations = [
    undefined,
    ...input.crews.flatMap((crew) => crew.roots.map((root) => root.directory)),
  ];
  for (const directory of opencode ? locations : []) {
    const models = await opencode?.catalog(directory, signal).catch(() => null);
    for (const [from, to] of [...chosen]) {
      const needed = inputs.refs.filter(
        (ref) => ref.id === from && inputs.providers.includes(ref.providerID),
      );
      const ok =
        !!models &&
        needed.every((ref) =>
          models.some(
            (model) =>
              model.providerID === ref.providerID &&
              model.id === to &&
              (!ref.variant || model.variants.includes(ref.variant)),
          ),
        );
      if (ok) continue;
      chosen.delete(from);
      rejected.push({
        scope: "catalog",
        target: directory ?? "global",
        from,
        to,
        status: "skipped",
        reason: "catalog-missing",
      });
    }
  }
  if (!opencode)
    for (const [from, to] of chosen) {
      chosen.delete(from);
      rejected.push({
        scope: "catalog",
        target: "global",
        from,
        to,
        status: "skipped",
        reason: "catalog-missing",
      });
    }
  return { upgrades: chosen, rejected };
}

/** Pure: the file, link, agent and session changes for an upgrade map. */
export function buildModelWork(
  inputs: ModelInputs,
  upgrades: Map<string, string>,
): ModelWork {
  const work: ModelWork = {
    upgrades,
    files: [],
    profileLinks: [],
    agents: [],
    sessions: [],
    changes: [],
  };
  if (!upgrades.size) return work;
  const { providers } = inputs;
  if (inputs.snapshot) {
    try {
      const result = upgradeProfiles(inputs.snapshot, upgrades, providers);
      for (const write of result.writes)
        work.files.push({ path: write.path, text: write.content });
      work.profileLinks.push(...result.links);
      work.agents.push(...result.live);
      for (const change of result.changes)
        work.changes.push({
          scope: "agent-profile",
          ...change,
          status: "planned",
        });
      for (const change of result.skipped)
        work.changes.push({
          scope: "agent-profile",
          ...change,
          status: "skipped",
          reason: "config-format",
        });
    } catch (error) {
      work.changes.push({
        scope: "agent-profile",
        target: inputs.profilesRoot ?? "profiles",
        from: "*",
        to: "*",
        status: "skipped",
        reason: reasonOf(error),
      });
    }
  }
  for (const document of inputs.documents) {
    try {
      const result =
        document.scope === "team-file"
          ? upgradeTeamFile(document.text, upgrades, providers)
          : upgradeOpenCodeProfile(document.text, upgrades, providers);
      if (!result.changes.length) continue;
      work.files.push({ path: document.path, text: result.text });
      for (const change of result.changes)
        work.changes.push({
          scope: document.scope,
          target: `${document.path}#${change.target}`,
          from: change.from,
          to: change.to,
          status: "planned",
        });
    } catch (error) {
      work.changes.push({
        scope: document.scope,
        target: document.path,
        from: "*",
        to: "*",
        status: "skipped",
        reason: reasonOf(error),
      });
    }
  }
  for (const { session, model } of inputs.live) {
    const next = providers.includes(model.providerID)
      ? upgrades.get(model.id)
      : undefined;
    if (!next) continue;
    const to = { ...model, id: next };
    work.sessions.push({ session, from: model, to });
    work.changes.push({
      scope: session.scope,
      target: session.id,
      from: formatRef(model),
      to: formatRef(to),
      status: "planned",
    });
  }
  return work;
}

/**
 * Switch each session, journalling it *before* the switch so a switch that
 * succeeded on the server but failed read-back is still reverted. Then the
 * selected profile's new agents must load with their new models. Switching
 * stops at `until`: the remaining sessions keep their old, still valid
 * model and are returned as `skipped`.
 */
export async function applyLiveModels(
  work: ModelWork,
  opencode: OpenCodeControl,
  journal: Journal,
  signal: AbortSignal,
  clock: { now(): number; until: number },
): Promise<{ ok: boolean; skipped: Session[] }> {
  const skipped: Session[] = [];
  for (const item of work.sessions) {
    if (clock.now() >= clock.until) {
      skipped.push(item.session);
      continue;
    }
    try {
      const current = await opencode.sessionModel(item.session.id, signal);
      // The session moved on its own since planning: leave it alone.
      if (!current || formatRef(current) !== formatRef(item.from)) continue;
      await journal.set("sessions", [
        ...(journal.get("sessions") ?? []),
        { id: item.session.id, from: item.from },
      ]);
      await opencode.switchModel(item.session.id, item.to, signal);
      const after = await opencode.sessionModel(item.session.id, signal);
      if (!after || formatRef(after) !== formatRef(item.to))
        return { ok: false, skipped };
    } catch {
      signal.throwIfAborted();
      return { ok: false, skipped };
    }
  }
  if (!work.agents.length) return { ok: true, skipped };
  const agents = await opencode.agents(undefined, signal).catch(() => null);
  return {
    ok:
      agents !== null &&
      work.agents.every((agent) => {
        const live = agents.find((candidate) => candidate.id === agent.name);
        return (
          live?.model !== undefined &&
          live.model !== null &&
          formatRef(live.model) === agent.model
        );
      }),
    skipped,
  };
}
