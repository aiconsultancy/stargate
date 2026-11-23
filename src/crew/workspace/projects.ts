import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Result, Schema } from "effect";
import type { CrewStatus, CrewStatusInput } from "../../shared/crew-status";
import {
  HISTORY_PAGE,
  type HistoryChildrenInput,
  type HistoryEntriesInput,
  type HistorySession,
} from "../../shared/session-history";
import {
  type CrewCaller,
  type CrewEngine,
  type CrewOptions,
  crewOptionsSchema,
} from "../execution/engine";
import type { FleetCrewStatus } from "../reporting/fleet-status";
import { effectProjectKeySchema } from "../input/project-options";
import { CrewError } from "../execution/state";
import { defaultTeam } from "../team";
import { projectRepository, workspaceRoot } from "./workspace";

const decodeProjectKey = Schema.decodeUnknownResult(effectProjectKeySchema);

type Factory = (options: CrewOptions) => Promise<CrewEngine>;

const within = (parent: string, child: string) => {
  const path = relative(parent, child);

  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

const overlap = (a: string, b: string) => within(a, b) || within(b, a);

/** One legacy team plus explicit independent project contexts. Never a path from a tool. */
export class CrewProjects {
  private constructor(
    public readonly contexts: ReadonlyMap<string, CrewEngine>,
  ) {}

  public static async open(
    raw: unknown,
    factory: Factory,
  ): Promise<CrewProjects> {
    const parsed = Schema.decodeUnknownResult(crewOptionsSchema)(raw);

    if (Result.isFailure(parsed))
      throw new CrewError(
        "Invalid crew/project configuration; use exact configured repository keys and worktrees.",
      );
    const { projects, ...base } = parsed.success;
    const configurations = new Map<string, CrewOptions>([["default", base]]);

    if (projects && Object.keys(projects).length > 0) {
      const team = base.team ?? defaultTeam;

      if ((Object.keys(projects).length + 1) * team.crew.length > HISTORY_PAGE)
        throw new CrewError(
          "Configured project/member contexts exceed the bounded history limit.",
        );

      for (const [key, project] of Object.entries(projects)) {
        const namespace = `${base.namespace}:project:${key}`;

        if (namespace.length > 256)
          throw new CrewError(
            "Project namespace exceeds the configured limit.",
          );
        configurations.set(key, {
          ...base,
          ...project,
          namespace,
          stateDirectory: join(base.stateDirectory, "projects", key),
        });
      }

      // Validate the entire registry before opening any state/native context.
      // The captain remains in its original directory, even for another repo.
      const signal = AbortSignal.timeout(30_000);

      const captain = await realpath(base.captainDirectory).catch(() => {
        throw new CrewError("Configured captain directory is unavailable.");
      });

      const repositories = new Set<string>();
      const projectPaths: string[] = [];
      const workerPaths: string[] = [];

      for (const options of configurations.values()) {
        const ids = team.crew.map((member) => member.id);

        if (
          Object.keys(options.worktrees).length !== ids.length ||
          ids.some((id) => !Object.hasOwn(options.worktrees, id))
        )
          throw new CrewError(
            "Project worktrees must exactly match the configured crew.",
          );

        const project = await projectRepository(
          options.projectDirectory,
          signal,
        );

        if (
          repositories.has(project.common) ||
          projectPaths.some((path) => overlap(path, project.directory))
        )
          throw new CrewError(
            "Project registry contains a duplicate repository or directory alias.",
          );
        repositories.add(project.common);
        projectPaths.push(project.directory);

        for (const path of Object.values(options.worktrees)) {
          const worker = await workspaceRoot(
            path,
            captain,
            project.directory,
            signal,
          );

          if (
            worker !== resolve(path) ||
            workerPaths.some((other) => overlap(other, worker))
          )
            throw new CrewError(
              "Project worktrees contain a duplicate, nested or symbolic-link alias.",
            );
          workerPaths.push(worker);
        }
      }

      if (
        workerPaths.some((worker) =>
          projectPaths.some((project) => overlap(worker, project)),
        )
      )
        throw new CrewError(
          "A project checkout overlaps a configured worker worktree.",
        );
    }

    const engines = new Map<string, CrewEngine>();

    try {
      for (const [key, options] of configurations)
        engines.set(key, await factory(options));

      return new CrewProjects(engines);
    } catch (error) {
      await Promise.allSettled(
        [...engines.values()].map((engine) => engine.close()),
      );
      throw error;
    }
  }

  public get enabled() {
    return this.contexts.size > 1;
  }
  public get default() {
    return this.get("default");
  }
  public get(key: string): CrewEngine {
    const engine = this.contexts.get(key);

    if (!engine)
      throw new CrewError(
        "Unknown crew project; use a configured project key, never a directory.",
      );

    return engine;
  }

  public owner(sessionID: string): string | undefined {
    const contexts = [...this.contexts].filter(([, engine]) => {
      if (engine.state.peerBySession(sessionID) !== null) return true;
      const member = engine.ircMember(sessionID);

      return member !== undefined && member !== "";
    });

    if (contexts.length > 1)
      throw new CrewError(
        "Native worker identity occurs in multiple project contexts; preserve state and resolve explicitly.",
      );

    return contexts[0]?.[0];
  }

  public async select(raw: unknown, caller: CrewCaller, mail = false) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new CrewError("Invalid project tool input.");

    if (![Object.prototype, null].includes(Reflect.getPrototypeOf(raw)))
      throw new CrewError("Project input requires own fields.");
    const record = raw as Record<string, unknown>;

    const project = Object.hasOwn(record, "project")
      ? record["project"]
      : undefined;

    const input = { ...record };
    delete input["project"];

    const requested =
      project === undefined ? undefined : decodeProjectKey(project);

    if (requested && Result.isFailure(requested))
      throw new CrewError("Invalid crew project key.");
    const owner = this.owner(caller.sessionID);
    const key = requested?.success ?? owner ?? "default";

    if (owner && key !== owner)
      throw new CrewError("Workers cannot select another project context.");
    const engine = this.get(key);

    const checking =
      input["op"] === "wait" && caller.signal.aborted
        ? { ...caller, signal: AbortSignal.timeout(5000) }
        : caller;

    if (mail) await engine.authorizeMail(checking);
    else await engine.authorize(checking);

    return { engine, input, project: key };
  }

  public async run(raw: unknown, caller: CrewCaller) {
    const selected = await this.select(raw, caller);
    const input = selected.input;

    if (
      selected.project !== "default" &&
      input["op"] === "dispatch" &&
      typeof input["text"] === "string"
    ) {
      const member = input["crew"];

      if (
        typeof member !== "string" ||
        !Object.hasOwn(selected.engine.options.worktrees, member)
      )
        throw new CrewError("Unknown configured crew member.");
      input["text"] = [
        `Configured Stargate project: ${selected.project}.`,
        `Use only your permanent worktree: ${JSON.stringify(selected.engine.options.worktrees[member])}.`,
        "Read this repository's AGENTS.md and applicable delivery/security instructions. Project selection is not human approval.",
        "Omitted project arguments are bound to your actual native worker session. Never select another project's state or move this session.",
        "",
        input["text"],
      ].join("\n");
    }

    const result = await selected.engine.run(input, caller);

    return this.enabled ? { ...result, project: selected.project } : result;
  }

  public status(input: CrewStatusInput = {}): CrewStatus {
    if (!this.enabled) return this.default.status(input);

    const pages = [...this.contexts].map(([project, engine]) => ({
      project,
      status: engine.status(input, { aggregate: true }),
    }));

    const members = pages.flatMap(({ project, status }) =>
      status.members.map((member) => ({ ...member, project })),
    );

    return {
      members: members.slice(0, 20),
      total: pages.reduce((total, p) => total + p.status.total, 0),
      truncated: members.length > 20 || pages.some((p) => p.status.truncated),
      busy: pages.reduce((total, page) => total + page.status.busy, 0),
    };
  }

  public fleetStatus(input: CrewStatusInput): FleetCrewStatus {
    const status = this.status(input);

    const contexts = status.members.flatMap(({ id, project }) => {
      const { options } = this.get(project ?? "default");
      const member = options.team.crew.find((entry) => entry.id === id);
      const directory = options.worktrees[id];

      if (!member || !directory) return [];
      const model = member.backend?.model ?? member.model;

      return [
        {
          member: id,
          project: project === "default" ? null : (project ?? null),
          directory,
          role: member.role,
          ...(model && { model: model.slice(0, 200) }),
        },
      ];
    });

    return {
      status,
      metadata: {
        projectDirectory: this.default.options.projectDirectory,
        contexts,
      },
    };
  }

  public async historyRoots(signal: AbortSignal) {
    const sessions: HistorySession[] = [];

    for (const [project, engine] of this.contexts) {
      const page = await engine.history.historyRoots(signal);

      for (const session of page.sessions)
        sessions.push(
          project === "default"
            ? session
            : {
                ...session,
                title:
                  `${session.title ?? session.member ?? "Crew"} [${project}]`.slice(
                    0,
                    300,
                  ),
              },
        );
    }

    if (
      sessions.length > HISTORY_PAGE ||
      new Set(sessions.map((s) => s.id)).size !== sessions.length
    )
      throw new CrewError(
        "Project history exceeds its bound or has ambiguous native identities.",
      );

    return { sessions };
  }

  public historyEngine(id: string) {
    const native =
      (id.startsWith("pi:") ? id.slice(3) : id).split("~")[0] ?? "";

    return this.get(this.owner(native) ?? "default");
  }

  public async historyDescribe(ids: readonly string[], signal: AbortSignal) {
    const pages = await Promise.all(
      [...this.contexts.values()].map((engine) =>
        engine.history.historyDescribe(ids, signal),
      ),
    );

    const sessions = pages.flatMap((page) => page.sessions);

    if (new Set(sessions.map((session) => session.id)).size !== sessions.length)
      throw new CrewError("Ambiguous project history identity.");

    return { sessions };
  }

  public historyChildren(input: HistoryChildrenInput, signal: AbortSignal) {
    return this.historyEngine(input.parentID).history.historyChildren(
      input,
      signal,
    );
  }

  public historyEntries(input: HistoryEntriesInput, signal: AbortSignal) {
    return this.historyEngine(input.sessionID).history.historyEntries(
      input,
      signal,
    );
  }

  public async close() {
    const results = await Promise.allSettled(
      [...this.contexts.values()].toReversed().map((engine) => engine.close()),
    );

    const failed = results.find((result) => result.status === "rejected");

    if (failed?.status === "rejected") throw failed.reason;
  }
}
