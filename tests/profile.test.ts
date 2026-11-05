import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crewPermissions } from "../src/crew/policy";
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
  expect(config).toMatchObject({
    mcp: {
      servers: {
        linear: {
          type: "remote",
          url: "https://mcp.linear.app/mcp/readonly",
          oauth: { scope: "read" },
          codemode: false,
        },
      },
    },
  });
  expect(JSON.stringify(config.providers)).toContain(
    "{env:CLIPROXYAPI_API_KEY}",
  );
  const rules = crewPermissions("daisy");
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
