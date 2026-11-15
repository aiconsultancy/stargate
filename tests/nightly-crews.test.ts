import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, configSchema } from "../src/config";
import { discoverCrews } from "../src/nightly/crews";

const root = await mkdtemp("/tmp/opencode/pogo-crews-");
afterAll(() => rm(root, { recursive: true, force: true }));

async function setup(name: string) {
  const dir = join(root, name);
  const captain = join(dir, "captain");
  const chief = join(dir, "chief");
  for (const path of [captain, chief])
    await mkdir(join(path, ".opencode"), { recursive: true });
  const options = {
    namespace: "ship",
    stateDirectory: join(captain, ".local", "pogo-crew"),
    captainDirectory: captain,
    worktrees: { chief },
    team: { captain: { id: "adama" }, crew: [{ id: "chief" }] },
  };
  const profile = (extra = {}) =>
    `${JSON.stringify({ plugins: [{ package: "/srv/pogo/plugin", options: { ...options, ...extra } }] }, null, 2)}\n`;
  const config: Config = configSchema.parse({
    dataDirectory: join(dir, "data"),
    bots: [
      {
        id: "helper",
        slack: { appId: "A1", appTokenEnv: "APP", botTokenEnv: "BOT" },
        access: { users: ["U1"], channels: ["C1"] },
        backend: {
          type: "opencode",
          url: "http://localhost:4096",
          directory: captain,
        },
      },
    ],
  });
  return { dir, captain, chief, profile, config };
}

describe("crew discovery fails closed", () => {
  test("follows a symlinked profile (dotfiles) to a real file", async () => {
    const { dir, captain, chief, profile, config } = await setup("symlink");
    await writeFile(join(dir, "captain.json"), profile());
    await symlink(
      join(dir, "captain.json"),
      join(captain, ".opencode", "opencode.json"),
    );
    await writeFile(join(chief, ".opencode", "opencode.json"), profile());
    const crews = await discoverCrews(config);
    expect(crews[0]?.roots.map((root) => root.directory)).toEqual([
      captain,
      chief,
    ]);
  });

  test("a bot without a profile is not a crew", async () => {
    const { config } = await setup("plain");
    expect(await discoverCrews(config)).toEqual([]);
  });

  test("cleanup protects permanent Pi worktrees as well as OpenCode roots", async () => {
    const { captain, chief, profile, config } = await setup("pi-protection");
    const pi = join(root, "pi-worker");
    const text = profile({
      worktrees: { chief, twiki: pi },
      team: {
        crew: [
          { id: "chief" },
          { id: "twiki", backend: { type: "pi-durable" } },
        ],
      },
    });
    await writeFile(join(captain, ".opencode", "opencode.json"), text);
    await writeFile(join(chief, ".opencode", "opencode.json"), text);
    const crews = await discoverCrews(config);
    expect(crews[0]?.worktreeDirectories).toEqual([chief, pi]);
    expect(crews[0]?.roots.map((item) => item.directory)).toEqual([
      captain,
      chief,
    ]);
  });

  test("unreadable profiles, broken plugin options or a missing member profile are unknown", async () => {
    const broken = await setup("broken");
    await writeFile(
      join(broken.captain, ".opencode", "opencode.json"),
      "{ not json",
    );
    await expect(discoverCrews(broken.config)).rejects.toThrow("idle-unknown");

    const options = await setup("options");
    await writeFile(
      join(options.captain, ".opencode", "opencode.json"),
      options.profile({ worktrees: "not an object" }),
    );
    await expect(discoverCrews(options.config)).rejects.toThrow("idle-unknown");

    const member = await setup("member");
    await writeFile(
      join(member.captain, ".opencode", "opencode.json"),
      member.profile(),
    );
    await expect(discoverCrews(member.config)).rejects.toThrow("idle-unknown");

    const dangling = await setup("dangling");
    await symlink(
      join(dangling.dir, "missing.json"),
      join(dangling.captain, ".opencode", "opencode.json"),
    );
    // A dangling link is broken configuration, not an absent profile.
    await expect(discoverCrews(dangling.config)).rejects.toThrow(
      "idle-unknown",
    );
  });
});
