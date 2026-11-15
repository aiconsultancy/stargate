import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { crewPermissions } from "../src/crew/policy";
import {
  defaultTeam,
  profileTeam,
  type Team,
  teamSchema,
} from "../src/crew/team";
import { textMentionInstructions } from "../src/mentions";
import { nightlyInstructions } from "../src/nightly/instructions";
import { peerInstructions } from "../src/peers";
import { initializeProfile, renderProfile } from "../src/profile";
import { reactionInstructions } from "../src/reactions";
import { voiceInstructions } from "../src/transcription";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp("/tmp/opencode/stargate-profile-");
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
  expect(config.skills.some((path) => path.endsWith("/templates/skills"))).toBe(
    true,
  );
  expect(config.model).toBe("openai-proxy/gpt-6.1-sol");
  expect(config.default_agent).toBe("bowser-crew-daisy");
  expect(config.compaction).toMatchObject({ auto: true, buffer: "20%" });
  expect(config.experimental).toMatchObject({ background_compaction: true });
  expect(Object.hasOwn(config, "mcp")).toBe(false);
  expect(JSON.stringify(config.providers)).toContain(
    "{env:CLIPROXYAPI_API_KEY}",
  );
  const rules = crewPermissions("research");
  expect(
    rules.some((rule) => rule.action === "shell" && rule.effect === "allow"),
  ).toBe(true);
  expect(
    rules.some((rule) => rule.action === "edit" && rule.effect === "allow"),
  ).toBe(true);
  expect(
    rules.some((rule) => rule.action === "execute" && rule.effect === "allow"),
  ).toBe(true);
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

test("specialisms retain broad host tools and session history", () => {
  for (const role of ["captain", "coding", "research"] as const) {
    const rules = crewPermissions(role);
    for (const action of [
      "shell",
      "edit",
      "execute",
      "browser",
      "subagent",
      "stargate_history",
    ])
      expect(rules).toContainEqual({ action, resource: "*", effect: "allow" });
    expect(rules).toContainEqual({
      action: "read",
      resource: "*.key",
      effect: "deny",
    });
  }
});

test("direct trusted team tools do not require individual connector grants", async () => {
  const { options } = await fixture();
  for (const role of ["captain", "coding", "research"] as const) {
    const rules = crewPermissions(role, "direct");
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" });
    expect(rules.at(-1)).toEqual({
      action: "read",
      resource: "*.pem",
      effect: "deny",
    });
  }
  const team = { ...defaultTeam, toolAccess: "direct" as const };
  const profile = await renderProfile({ ...options, team }, team.captain.id);
  expect(profile.agents["bowser-captain-bowser"]?.permissions).toEqual(
    crewPermissions("captain", "direct"),
  );
});

test("profile binds every crew location to the same existing captain session", async () => {
  const { options } = await fixture();
  const captainSessionID = "ses_durableCaptain";
  const bound = { ...options, captainSessionID };
  const initialized = await initializeProfile(bound);
  expect(initialized.sessionID).toBe(captainSessionID);
  for (const role of ["bowser", "mario", "luigi", "daisy", "toad"]) {
    const profile = await renderProfile(bound, role);
    expect(profile.plugins[0]?.options.captainSessionID).toBe(captainSessionID);
  }
  await expect(
    renderProfile({ ...bound, captainSessionID: "not-a-session" }, "bowser"),
  ).rejects.toThrow("Invalid profile");
});

test("profile retains an explicit local cron control binding", async () => {
  const { options } = await fixture();
  const cron = { configPath: "/srv/stargate/stargate.json", bot: "helper" };
  const profile = await renderProfile({ ...options, cron }, "bowser");
  expect(profile.plugins[0]?.options.cron).toEqual(cron);
});

test("reaction protocol belongs once in the captain definition, not crew definitions", async () => {
  const { options } = await fixture();
  await initializeProfile(options);
  await initializeProfile(options);
  const captain = await readFile(
    join(options.directory, ".opencode", "agents", "bowser-captain-bowser.md"),
    "utf8",
  );
  expect(captain).toContain(reactionInstructions);
  expect(captain).toStartWith("---\n");
  expect(captain.split("<!-- STARGATE:START -->")).toHaveLength(2);
  expect(captain.split("<!-- STARGATE:END -->")).toHaveLength(2);
  expect(captain).toEndWith("<!-- STARGATE:END -->\n");
  expect(captain.indexOf("<!-- STARGATE:START -->")).toBeGreaterThan(
    captain.indexOf("\n---\n"),
  );
  expect(captain.split("Slack reaction protocol (optional):")).toHaveLength(2);
  expect(captain.split(voiceInstructions)).toHaveLength(2);
  expect(captain.split(peerInstructions)).toHaveLength(2);
  expect(captain.split(textMentionInstructions)).toHaveLength(2);
  expect(voiceInstructions).toContain("read the transcript back");
  for (const member of ["mario", "luigi", "daisy", "toad"]) {
    const crew = await readFile(
      join(
        options.worktreeDirectory,
        member,
        ".opencode",
        "agents",
        `bowser-crew-${member}.md`,
      ),
      "utf8",
    );
    expect(crew).not.toContain("Slack reaction protocol");
    expect(crew).not.toContain("Voice message transcripts:");
    expect(crew).not.toContain("Peer captain messages:");
    expect(crew.split("<!-- STARGATE:START -->")).toHaveLength(2);
    expect(crew).toEndWith("<!-- STARGATE:END -->\n");
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
    expect(directory).toBe(join(options.worktreeDirectory, name));
    const branch = execFileSync(
      "git",
      ["-C", directory, "branch", "--show-current"],
      { encoding: "utf8" },
    ).trim();
    expect(branch).toBe(`crew/bowser-${name}`);
    const prompt = await readFile(
      join(directory, ".opencode", "agents", `bowser-crew-${name}.md`),
      "utf8",
    );
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("mode: primary");
    expect(prompt).toContain("Do not switch worktrees");
    expect(prompt).toContain(
      join(options.directory, ".local", "ship", "log.md"),
    );
    expect(prompt).toContain(
      join(options.directory, ".local", "ship", "journals", `${name}.md`),
    );
    expect(
      execFileSync("git", ["-C", directory, "status", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe("");
  }
  expect(
    (await stat(join(options.directory, ".local", "stargate-crew"))).mode &
      0o777,
  ).toBe(0o700);
  expect(await initializeProfile(options)).toEqual(result);
  const worker = result.worktrees["mario"];
  if (!worker) throw new Error("Missing worker worktree");
  execFileSync("git", ["-C", worker, "switch", "-c", "feat/task-in-place"], {
    stdio: "pipe",
  });
  expect(await initializeProfile(options)).toEqual(result);
  expect(
    execFileSync("git", ["-C", worker, "branch", "--show-current"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("feat/task-in-place");
  expect(
    await Bun.file(
      join(options.directory, ".local", "ship", "journals", "bowser.md"),
    ).exists(),
  ).toBe(true);
});

test("profile init refuses conflicting files rather than overwriting work", async () => {
  const { options } = await fixture();
  await initializeProfile(options);
  const path = join(
    options.directory,
    ".opencode",
    "agents",
    "bowser-captain-bowser.md",
  );
  const generated = await readFile(path, "utf8");
  const amended = `${generated}\n## Operator notes\n\nPreserve these notes.\n`;
  await writeFile(path, amended);
  await expect(initializeProfile(options)).rejects.toThrow("existing");
  expect(await readFile(path, "utf8")).toBe(amended);
  await writeFile(path, "User's custom instructions\n");
  await expect(initializeProfile(options)).rejects.toThrow("existing");
  expect(await readFile(path, "utf8")).toBe("User's custom instructions\n");
});

test("ship records cover the configured roster and preserve operator notes", async () => {
  const { options } = await fixture();
  const ship = join(options.directory, ".local", "ship");
  const journal = join(ship, "journals", "gaeta.md");
  await mkdir(join(ship, "journals"), { recursive: true });
  await writeFile(journal, "Operator's research notes\n");
  const result = await initializeProfile({ ...options, team });
  expect((await readdir(join(ship, "journals"))).sort()).toEqual([
    "adama.md",
    "gaeta.md",
    "starbuck.md",
  ]);
  const log = join(ship, "log.md");
  expect(await readFile(log, "utf8")).toContain("# Ship log");
  expect((await stat(log)).mode & 0o777).toBe(0o600);
  const agreement = await readFile(
    join(options.directory, "WAYS_OF_WORKING.md"),
    "utf8",
  );
  expect(agreement).toContain("applicable nested");
  expect(agreement).toContain("## Requests and replies");
  expect(agreement).toContain("## Task-boundary improvement");
  await writeFile(log, "Verified lesson: preserve the original task ID.\n");
  for (const [id, directory] of [
    [team.captain.id, options.directory],
    ...Object.entries(result.worktrees),
  ]) {
    const prompt = await readFile(
      join(
        directory ?? "",
        ".opencode",
        "agents",
        `bowser-${id === team.captain.id ? "captain" : "crew"}-${id}.md`,
      ),
      "utf8",
    );
    expect(prompt).toContain(log);
    expect(prompt).toContain(join(ship, "journals", `${id}.md`));
    expect(prompt).toContain(
      join(options.projectDirectory, ".agents", "opco", "skills"),
    );
    expect(prompt).toContain("skill-creator");
    expect(prompt).toContain("task boundaries, not every turn");
    expect(prompt).not.toContain("{{");
  }
  await initializeProfile({ ...options, team });
  expect(await readFile(journal, "utf8")).toBe("Operator's research notes\n");
  expect(await readFile(log, "utf8")).toBe(
    "Verified lesson: preserve the original task ID.\n",
  );
});

test("shared working agreement is preserved and referenced, never injected into definitions", async () => {
  const { options } = await fixture();
  const path = join(options.directory, "WAYS_OF_WORKING.md");
  await mkdir(options.directory, { recursive: true });
  await writeFile(path, "CAPTAIN EDIT ONE\n");
  const input = { ...options, namespace: "galactica", team };
  const result = await initializeProfile(input);
  expect(await readFile(path, "utf8")).toBe("CAPTAIN EDIT ONE\n");
  for (const [id, directory] of [
    ["adama", options.directory],
    ...Object.entries(result.worktrees),
  ]) {
    const native = `galactica-${id === "adama" ? "captain" : "crew"}-${id}`;
    const prompt = await readFile(
      join(directory ?? "", ".opencode", "agents", `${native}.md`),
      "utf8",
    );
    expect(prompt).toContain(path);
    expect(prompt).toContain("reread it when updated");
    expect(prompt).not.toContain("CAPTAIN EDIT ONE");
    const config = await Bun.file(
      join(directory ?? "", ".opencode", "opencode.json"),
    ).json();
    expect(config.instructions).toBeUndefined();
  }
  await writeFile(path, "CAPTAIN EDIT TWO\n");
  await initializeProfile(input);
  expect(await readFile(path, "utf8")).toBe("CAPTAIN EDIT TWO\n");
  const other = await renderProfile(
    { ...input, namespace: "pegasus" },
    "starbuck",
  );
  expect(other.default_agent).toBe("pegasus-crew-starbuck");
  expect(other.plugins[0]?.options.team.crew[0]?.id).toBe("starbuck");
  expect(() => profileTeam(team, "x".repeat(64))).toThrow();
});

test("portable Bosun is an ordinary configured worker, not a runtime default", async () => {
  const { options } = await fixture();
  const example = teamSchema.parse(
    await Bun.file(join(import.meta.dir, "..", "team.example.json")).json(),
  );
  const bosun = example.crew.find(({ id }) => id === "bosun");
  expect(bosun?.permissionProfile).toBe("coding");
  expect(bosun?.backend).toBeUndefined();
  expect(bosun?.instructions).toContain("nightly");
  expect(defaultTeam.crew.some(({ id }) => id === "bosun")).toBe(false);
  const result = await initializeProfile({ ...options, team: example });
  const directory = result.worktrees["bosun"];
  expect(directory).toBeDefined();
  const config = await renderProfile({ ...options, team: example }, "bosun");
  expect(config.agents["galactica-crew-bosun"]?.model).toBe(bosun?.model);
  expect(config.skills).toContain(
    join(options.projectDirectory, ".agents", "opco", "skills"),
  );
  const prompt = await readFile(
    join(directory ?? "", ".opencode", "agents", "galactica-crew-bosun.md"),
    "utf8",
  );
  expect(prompt).toContain(bosun?.instructions ?? "missing Bosun instructions");
  expect(prompt).toContain(
    join(options.directory, ".local", "ship", "journals", "bosun.md"),
  );
});

test("ship initialization rejects a linked record without changing its target", async () => {
  const { options } = await fixture();
  const ship = join(options.directory, ".local", "ship");
  await mkdir(ship, { recursive: true });
  const target = join(options.directory, "operator-notes.md");
  await writeFile(target, "Keep these notes\n");
  await symlink(target, join(ship, "log.md"));
  await expect(initializeProfile({ ...options, team })).rejects.toThrow(
    "existing profile file",
  );
  expect(await readFile(target, "utf8")).toBe("Keep these notes\n");
});

test("Pi crew receives a worktree but no OpenCode agent or session profile", async () => {
  const { options } = await fixture();
  const mixed = teamSchema.parse({
    captain: { id: "adama" },
    crew: [
      {
        id: "twiki",
        name: "Twiki",
        role: "Cleanup and maintenance",
        permissionProfile: "coding",
        backend: {
          type: "pi-durable",
          model: "openai/opencode-go/deepseek-v4.1-flash",
          tools: "coding",
        },
      },
    ],
  });
  const created = await initializeProfile({ ...options, team: mixed });
  const worktree = created.worktrees["twiki"];
  if (!worktree) throw new Error("Twiki worktree missing");
  expect(
    await Bun.file(join(worktree, ".opencode", "opencode.json")).exists(),
  ).toBe(false);
  const definitionPath = join(
    options.directory,
    ".local",
    "ship",
    "definitions",
    "bowser-crew-twiki.md",
  );
  const definition = await readFile(definitionPath, "utf8");
  expect(definition).toStartWith("<!-- STARGATE:START -->\n");
  expect(definition).toEndWith("<!-- STARGATE:END -->\n");
  expect(definition).toContain("Stargate address: twiki");
  expect(worktree).toBe(join(options.worktreeDirectory, "twiki"));
  expect(definition).toContain("Do not switch worktrees");
  expect(definition).toContain(join(worktree, "AGENTS.md"));
  expect(definition).toContain(join(options.directory, "WAYS_OF_WORKING.md"));
  expect(definition).toContain("reread it when updated");
  expect(definition).not.toContain("# Ways of working");
  expect((await stat(definitionPath)).mode & 0o777).toBe(0o600);
  await writeFile(definitionPath, `${definition}\nCaptain amendment.\n`);
  await initializeProfile({ ...options, team: mixed });
  expect(await readFile(definitionPath, "utf8")).toBe(
    `${definition}\nCaptain amendment.\n`,
  );
  const prompt = await readFile(
    join(options.directory, ".opencode", "agents", "bowser-captain-adama.md"),
    "utf8",
  );
  expect(prompt).toContain("twiki (Twiki)");
  expect(prompt).toContain("backend: Pi Durable");
  expect(
    await Bun.file(
      join(options.directory, ".local", "ship", "journals", "twiki.md"),
    ).exists(),
  ).toBe(true);
  await expect(
    renderProfile({ ...options, team: mixed }, "twiki"),
  ).rejects.toThrow("do not use OpenCode");
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
      id: "gaeta",
      name: "Gaeta",
      role: "Research",
      permissionProfile: "research",
      instructions: "Cite fleet records.",
    },
  ],
};

test("agent IDs must match assigned names without legacy aliases", () => {
  expect(teamSchema.safeParse(team).success).toBe(true);
  for (const [id, name] of [
    ["mario", "Chief"],
    ["luigi", "Starbuck"],
    ["daisy", "Roslin"],
    ["toad", "Apollo"],
  ]) {
    expect(
      teamSchema.safeParse({
        ...team,
        crew: [{ id, name, role: "Worker", permissionProfile: "coding" }],
      }).success,
    ).toBe(false);
  }
  expect(
    teamSchema.safeParse({ ...team, captain: { id: "bowser", name: "Adama" } })
      .success,
  ).toBe(false);
  expect(
    teamSchema.safeParse({
      ...team,
      crew: [
        {
          id: "chief-engineer",
          name: "Chief Engineer",
          role: "Worker",
          permissionProfile: "coding",
        },
      ],
    }).success,
  ).toBe(true);
});

test("custom profiles select captain, agent models, and permissions independent of names", async () => {
  const {
    options: { namespace: _, ...options },
  } = await fixture();
  const captain = await renderProfile({ ...options, team }, "adama");
  expect(captain.default_agent).toBe("adama-captain-adama");
  expect(captain.agents["adama-captain-adama"]?.model).toBe(team.captain.model);
  expect(captain.agents["adama-captain-adama"]?.permissions).toEqual(
    crewPermissions("captain"),
  );
  expect(captain.plugins[0]?.options.namespace).toBe("adama");
  expect(captain.plugins[0]?.options.team).toEqual(profileTeam(team, "adama"));
  expect(Object.keys(captain.plugins[0]?.options.worktrees ?? {})).toEqual([
    "starbuck",
    "gaeta",
  ]);
  const coding = await renderProfile({ ...options, team }, "starbuck");
  expect(coding.agents["adama-crew-starbuck"]?.model).toBe(team.crew[0]?.model);
  const research = await renderProfile({ ...options, team }, "gaeta");
  expect(research.agents["adama-crew-gaeta"]?.permissions).toEqual(
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
  expect(Object.keys(result.worktrees)).toEqual(["starbuck", "gaeta"]);
  expect(result.agent).toBe("adama-captain-adama");
  expect(result.permissions).toEqual(crewPermissions("captain"));
  expect(git("status", "--porcelain")).toBe(before);
  expect(
    await readFile(join(options.projectDirectory, "AGENTS.md"), "utf8"),
  ).toBe("Uncommitted project rules\n");
  const prompt = await readFile(
    join(options.directory, ".opencode", "agents", "adama-captain-adama.md"),
    "utf8",
  );
  expect(prompt).toContain("Protect the fleet.");
  expect(prompt).toContain("starbuck");
  expect(prompt).toContain("stargate_crew");
  expect(prompt).toContain("stargate_model");
  expect(prompt).toContain("stargate_history");
  expect(prompt).toContain("queue: true");
  expect(prompt).toContain("60-second observation window");
  expect(prompt).toContain("Do not repeat wait in the same turn");
  expect(prompt).toContain("Scope each Slack request");
  expect(prompt).toContain(
    "s=slack;c=<channel>;t=<thread>;m=<message>;u=<user>",
  );
  expect(prompt).toContain("does not automatically resend thread history");
  expect(prompt).toContain("not the last task mentioned elsewhere");
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
      join(directory, ".opencode", "agents", `adama-crew-${id}.md`),
      "utf8",
    );
    expect(worker).not.toContain("{{");
    expect(worker).toContain("IRC sessions:");
    expect(worker).toContain("stargate_crew complete");
    expect(worker).toContain("Before marking the task complete");
    expect(worker).toContain("stargate_dm");
    expect(worker).toContain("stargate_history");
    expect(worker).toContain("Never create");
    if (id === "gaeta") {
      expect(worker).toContain("research");
      expect(worker).toContain("Cite fleet records.");
    }
  }
  const excludes = await readFile(
    join(options.projectDirectory, ".git", "info", "exclude"),
    "utf8",
  );
  for (const id of ["adama", "starbuck", "gaeta"])
    expect(excludes).toContain(
      `/.agents/opco/agents/adama-${id === "adama" ? "captain" : "crew"}-${id}.md`,
    );
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
  expect(second.agent).toBe("pegasus-captain-cain");
  expect(first.stateDirectory).not.toBe(second.stateDirectory);
  expect(first.worktrees["starbuck"]).not.toBe(second.worktrees["starbuck"]);
  expect(git("branch", "--list", "crew/*")).toContain("crew/adama-starbuck");
  expect(git("branch", "--list", "crew/*")).toContain("crew/pegasus-starbuck");
  expect(git("status", "--porcelain")).toBe("");
  const excludes = await readFile(
    join(options.projectDirectory, ".git", "info", "exclude"),
    "utf8",
  );
  expect(excludes).toContain("/.opencode/agents/adama-captain-adama.md");
  expect(excludes).toContain("/.opencode/agents/pegasus-captain-cain.md");
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
  const worker = result.worktrees["starbuck"];
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
  expect(config.default_agent).toBe("adama-captain-adama");
  expect(config.plugins[0].options.namespace).toBe("adama");
  expect(config.plugins[0].options.team).toEqual(profileTeam(team, "adama"));
});

test("captain, crew and Pi instructions render the configured maintenance window", async () => {
  const { options } = await fixture();
  const window = { start: "00:00", end: "01:00", timeZone: "Europe/London" };
  const paragraph = nightlyInstructions(window);
  expect(paragraph).toContain("from 00:00 to 01:00 (Europe/London)");
  expect(paragraph).toContain(
    "the OpenCode server and your session can restart",
  );
  expect(paragraph).toContain("checkpoint work in progress");
  expect(paragraph).toContain("Do not start long tasks");
  const team = teamSchema.parse({
    captain: { id: "adama" },
    crew: [
      { id: "chief", role: "Engineer", permissionProfile: "coding" },
      {
        id: "twiki",
        role: "Cleanup",
        permissionProfile: "coding",
        backend: { type: "pi-durable", model: "openai/x", tools: "coding" },
      },
    ],
  });
  await initializeProfile({ ...options, team, maintenanceWindow: window });
  const read = (path: string) => readFile(path, "utf8");
  const captain = await read(
    join(options.directory, ".opencode", "agents", "bowser-captain-adama.md"),
  );
  const crew = await read(
    join(
      options.worktreeDirectory,
      "chief",
      ".opencode",
      "agents",
      "bowser-crew-chief.md",
    ),
  );
  const pi = await read(
    join(
      options.directory,
      ".local",
      "ship",
      "definitions",
      "bowser-crew-twiki.md",
    ),
  );
  for (const text of [captain, crew, pi])
    expect(text.split(paragraph)).toHaveLength(2);
  expect(captain).toEndWith("<!-- STARGATE:END -->\n");
  expect(nightlyInstructions(undefined)).toBe("");
});

test("without a maintenance window no paragraph or placeholder is rendered", async () => {
  const { options } = await fixture();
  await initializeProfile(options);
  const captain = await readFile(
    join(options.directory, ".opencode", "agents", "bowser-captain-bowser.md"),
    "utf8",
  );
  expect(captain).not.toContain("Nightly maintenance:");
  expect(captain).not.toContain("{{maintenanceInstructions}}");
});
