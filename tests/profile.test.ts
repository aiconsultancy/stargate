import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { crewPermissions } from "../src/crew/policy";
import type { Team } from "../src/crew/team";
import { initializeProfile, renderProfile } from "../src/profile";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp("/tmp/opencode/pogo-profile-");
  directories.push(root);
  const projectDirectory = join(root, "indra");
  execFileSync("git", ["init", "-b", "main", projectDirectory]);
  await writeFile(join(projectDirectory, "AGENTS.md"), "Project rules\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", projectDirectory, ...args], {
      encoding: "utf8",
    });
  git("add", "AGENTS.md");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "init",
  );
  return {
    git,
    options: {
      directory: join(root, "bowser"),
      projectDirectory,
      worktreeDirectory: join(root, "crew"),
      namespace: "bowser",
      base: "main",
      mesijCommand: "/usr/local/bin/mesij",
    },
  };
}

test("default profile uses proxy, durable crew, and 20% compaction buffer", async () => {
  const { options } = await fixture();
  const config = await renderProfile(options, "daisy");
  expect(config.model).toBe("openai-proxy/gpt-6.1-sol");
  expect(config.default_agent).toBe("daisy");
  expect(config.compaction).toMatchObject({ auto: true, buffer: "20%" });
  expect(config.experimental).toMatchObject({ background_compaction: true });
  expect(Object.hasOwn(config, "mcp")).toBe(false);
  expect(JSON.stringify(config.providers)).toContain(
    "{env:CLIPROXYAPI_API_KEY}",
  );
  const rules = crewPermissions("research");
  expect(
    rules.some((rule) => rule.action === "shell" && rule.effect === "allow"),
  ).toBe(false);
  expect(
    rules.some((rule) => rule.action === "edit" && rule.effect === "allow"),
  ).toBe(false);
  expect(
    rules.some((rule) => rule.action === "execute" && rule.effect === "allow"),
  ).toBe(false);
  expect(rules).toContainEqual({
    action: "subagent",
    resource: "*",
    effect: "allow",
  });
});

test("all crew roles permit the user's global Linear read/write tools", () => {
  for (const role of ["captain", "coding", "research"] as const) {
    expect(crewPermissions(role)).toContainEqual({
      action: "linear_*",
      resource: "*",
      effect: "allow",
    });
  }
});

test("profile init creates named feature worktrees, preserves source and reuses paths", async () => {
  const { git, options } = await fixture();
  const result = await initializeProfile(options);
  expect(Object.keys(result.worktrees)).toEqual([
    "mario",
    "luigi",
    "daisy",
    "toad",
  ]);
  expect(git("branch", "--show-current").trim()).toBe("main");
  expect(git("status", "--porcelain")).toBe("");
  for (const [name, directory] of Object.entries(result.worktrees)) {
    const branch = execFileSync(
      "git",
      ["-C", directory, "branch", "--show-current"],
      { encoding: "utf8" },
    ).trim();
    expect(branch).toBe(`crew/bowser-${name}`);
    const prompt = await readFile(
      join(directory, ".opencode", "agents", `${name}.md`),
      "utf8",
    );
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("mode: primary");
    expect(
      execFileSync("git", ["-C", directory, "status", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe("");
  }
  expect(
    (await stat(join(options.directory, ".local", "pogo-crew"))).mode & 0o777,
  ).toBe(0o700);
  expect(await initializeProfile(options)).toEqual(result);
});

test("profile init refuses conflicting files rather than overwriting work", async () => {
  const { options } = await fixture();
  await initializeProfile(options);
  const path = join(options.directory, ".opencode", "agents", "bowser.md");
  await writeFile(path, "User's custom instructions\n");
  await expect(initializeProfile(options)).rejects.toThrow("existing");
  expect(await readFile(path, "utf8")).toBe("User's custom instructions\n");
});

const team: Team = {
  captain: {
    id: "adama",
    name: "Adama",
    model: "openai-proxy/gpt-6.1-sol",
    instructions: "Protect the fleet.",
  },
  crew: [
    {
      id: "starbuck",
      name: "Starbuck",
      role: "Implementation",
      permissionProfile: "coding",
      model: "claude-proxy/claude-opus-4-8",
    },
    {
      id: "mario",
      name: "Gaeta",
      role: "Research",
      permissionProfile: "research",
      instructions: "Cite fleet records.",
    },
  ],
};

test("custom profiles select captain, agent models, and permissions independent of names", async () => {
  const {
    options: { namespace: _, ...options },
  } = await fixture();
  const captain = await renderProfile({ ...options, team }, "adama");
  expect(captain.default_agent).toBe("adama");
  expect(captain.agents.adama?.model).toBe(team.captain.model);
  expect(captain.agents.adama?.permissions).toEqual(crewPermissions("captain"));
  expect(captain.plugins[0]?.options.namespace).toBe("adama");
  expect(captain.plugins[0]?.options.team).toEqual(team);
  expect(Object.keys(captain.plugins[0]?.options.worktrees ?? {})).toEqual([
    "starbuck",
    "mario",
  ]);
  const coding = await renderProfile({ ...options, team }, "starbuck");
  expect(coding.agents.starbuck?.model).toBe(team.crew[0]?.model);
  const research = await renderProfile({ ...options, team }, "mario");
  expect(research.agents.mario?.permissions).toEqual(
    crewPermissions("research"),
  );
  await expect(renderProfile({ ...options, team }, "bowser")).rejects.toThrow(
    "team",
  );
});

test("custom init creates only configured worktrees, generic prompts, and generated excludes", async () => {
  const {
    git,
    options: { namespace: _, ...options },
  } = await fixture();
  await writeFile(
    join(options.projectDirectory, "AGENTS.md"),
    "Uncommitted project rules\n",
  );
  const before = git("status", "--porcelain");
  const result = await initializeProfile({ ...options, team });
  expect(Object.keys(result.worktrees)).toEqual(["starbuck", "mario"]);
  expect(result.agent).toBe("adama");
  expect(result.permissions).toEqual(crewPermissions("captain"));
  expect(git("status", "--porcelain")).toBe(before);
  expect(
    await readFile(join(options.projectDirectory, "AGENTS.md"), "utf8"),
  ).toBe("Uncommitted project rules\n");
  const prompt = await readFile(
    join(options.directory, ".opencode", "agents", "adama.md"),
    "utf8",
  );
  expect(prompt).toContain("Protect the fleet.");
  expect(prompt).toContain("starbuck");
  expect(prompt).toContain("pogo_crew");
  expect(prompt).toContain("pogo_model");
  expect(prompt).toContain("pogo_history");
  expect(prompt).toContain("queue: true");
  expect(prompt).not.toContain("{{");
  expect(prompt).not.toContain("four");
  for (const [id, directory] of Object.entries(result.worktrees)) {
    expect(
      execFileSync("git", ["-C", directory, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(`crew/adama-${id}`);
    expect(
      execFileSync("git", ["-C", directory, "status", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe("");
    const worker = await readFile(
      join(directory, ".opencode", "agents", `${id}.md`),
      "utf8",
    );
    expect(worker).not.toContain("{{");
    expect(worker).toContain("pogo_crew complete");
    expect(worker).toContain("pogo_history");
    expect(worker).toContain("Never create");
    if (id === "mario") {
      expect(worker).toContain("research");
      expect(worker).toContain("Cite fleet records.");
    }
  }
  const excludes = await readFile(
    join(options.projectDirectory, ".git", "info", "exclude"),
    "utf8",
  );
  for (const id of ["adama", "starbuck", "mario"])
    expect(excludes).toContain(`/.agents/opco/agents/${id}.md`);
  expect(await initializeProfile({ ...options, team })).toEqual(result);
});

test("independent team namespaces and captains share a source without sharing directories", async () => {
  const {
    git,
    options: { namespace: _, ...options },
  } = await fixture();
  const first = await initializeProfile({ ...options, team });
  const second = await initializeProfile({
    ...options,
    team: { ...team, captain: { id: "cain", name: "Cain" } },
    namespace: "pegasus",
    directory: join(options.directory, "..", "pegasus"),
    worktreeDirectory: join(options.worktreeDirectory, "..", "pegasus-crew"),
  });
  expect(first.namespace).toBe("adama");
  expect(second.namespace).toBe("pegasus");
  expect(second.agent).toBe("cain");
  expect(first.stateDirectory).not.toBe(second.stateDirectory);
  expect(first.worktrees.starbuck).not.toBe(second.worktrees.starbuck);
  expect(git("branch", "--list", "crew/*")).toContain("crew/adama-starbuck");
  expect(git("branch", "--list", "crew/*")).toContain("crew/pegasus-starbuck");
  expect(git("status", "--porcelain")).toBe("");
  const excludes = await readFile(
    join(options.projectDirectory, ".git", "info", "exclude"),
    "utf8",
  );
  expect(excludes).toContain("/.opencode/agents/adama.md");
  expect(excludes).toContain("/.opencode/agents/cain.md");
});

test("custom init preserves canonical config and refuses tracked config", async () => {
  const { git, options } = await fixture();
  await mkdir(join(options.projectDirectory, ".agents", "opco"), {
    recursive: true,
  });
  await writeFile(
    join(options.projectDirectory, ".agents", "opco", "rules.md"),
    "Shared rules\n",
  );
  git("add", ".agents");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "rules",
  );
  await mkdir(join(options.projectDirectory, ".opencode"));
  await writeFile(
    join(options.projectDirectory, ".opencode", "notes.md"),
    "User notes\n",
  );
  const before = git("status", "--porcelain");
  const result = await initializeProfile({ ...options, team });
  expect(git("status", "--porcelain")).toBe(before);
  const worker = result.worktrees.starbuck;
  expect(worker).toBeDefined();
  expect(await realpath(join(worker ?? "", ".opencode"))).toBe(
    join(worker ?? "", ".agents", "opco"),
  );
  expect(
    await readFile(join(worker ?? "", ".agents", "opco", "rules.md"), "utf8"),
  ).toBe("Shared rules\n");
  expect(
    execFileSync("git", ["-C", worker ?? "", "status", "--porcelain"], {
      encoding: "utf8",
    }),
  ).toBe("");
  const config = join(worker ?? "", ".agents", "opco", "opencode.json");
  execFileSync("git", [
    "-C",
    worker ?? "",
    "add",
    "-f",
    ".agents/opco/opencode.json",
  ]);
  const previous = await readFile(config, "utf8");
  await expect(initializeProfile({ ...options, team })).rejects.toThrow(
    "tracked configuration",
  );
  expect(await readFile(config, "utf8")).toBe(previous);
});

test("setup rejects a captain nested in a worker tree before creating overlays", async () => {
  const { options } = await fixture();
  await expect(
    initializeProfile({
      ...options,
      directory: join(options.worktreeDirectory, "mario", "captain"),
    }),
  ).rejects.toThrow("non-nested");
  await expect(stat(options.worktreeDirectory)).rejects.toThrow();
});

test("crew CLI loads non-secret --team JSON and rejects invalid input without echoing it", async () => {
  const { options } = await fixture();
  const path = join(options.projectDirectory, "team.json");
  const args = [
    "crew",
    "init",
    "--directory",
    options.directory,
    "--project",
    options.projectDirectory,
    "--worktrees",
    options.worktreeDirectory,
    "--base",
    "main",
    "--mesij-command",
    options.mesijCommand,
    "--team",
    path,
  ];
  for (const text of [
    '{"secret-do-not-echo":',
    JSON.stringify({ ...team, secret: "secret-do-not-echo" }),
  ]) {
    await writeFile(path, text);
    try {
      await runCli(args);
      throw new Error("Expected invalid team");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Cannot load team file. Use valid team JSON without credentials.",
      );
    }
  }
  await writeFile(path, JSON.stringify(team));
  for (const invalidPath of ["", `${path}.missing`]) {
    await expect(runCli([...args.slice(0, -1), invalidPath])).rejects.toThrow(
      "Cannot load team file. Use valid team JSON without credentials.",
    );
  }
  expect(await runCli(args)).toEqual({ command: "exit" });
  const config = await Bun.file(
    join(options.directory, ".opencode", "opencode.json"),
  ).json();
  expect(config.default_agent).toBe("adama");
  expect(config.plugins[0].options.namespace).toBe("adama");
  expect(config.plugins[0].options.team).toEqual(team);
});
