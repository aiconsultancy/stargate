import { describe, expect, test } from "bun:test";
import {
  chooseUpgrades,
  type ProfilesSnapshot,
  upgradeCandidates,
  upgradeOpenCodeProfile,
  upgradeProfiles,
  upgradeTeamFile,
} from "../src/nightly/models";
import {
  compareModels,
  newerModels,
  parseModel,
  parseRef,
} from "../src/nightly/versions";

const families = [
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "gpt-sol",
  "gpt-terra",
  "gpt-luna",
];
const providers = ["openai-proxy", "claude-proxy"];
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("model families", () => {
  test("parses exact family members and ignores suffixed products", () => {
    expect(parseModel("claude-opus-5-5")).toEqual({
      family: "claude-opus",
      version: [5, 5],
      token: "opus-5-5",
    });
    expect(parseModel("claude-opus-6")?.version).toEqual([6]);
    expect(parseModel("gpt-6.1-sol")).toEqual({
      family: "gpt-sol",
      version: [6, 1],
      token: "sol-6-1",
    });
    expect(parseModel("gpt-6-luna")?.token).toBe("luna-6");
    for (const id of [
      "gpt-6.1-sol-fast",
      "claude-opus-5-5-20261101",
      "deepseek-v4.1-flash",
      "gpt-6.1",
      "claude-opus",
    ])
      expect(parseModel(id)).toBeNull();
  });

  test("orders versions numerically and deterministically", () => {
    const order = (a: string, b: string) => {
      const left = parseModel(a);
      const right = parseModel(b);
      if (!left || !right) throw new Error("unparsed");
      return compareModels(left, right);
    };
    expect(order("claude-opus-5-5", "claude-opus-5-6")).toBe(-1);
    expect(order("claude-opus-5-6", "claude-opus-6")).toBe(-1);
    expect(order("claude-opus-5-10", "claude-opus-5-9")).toBe(1);
    expect(order("gpt-6.1-sol", "gpt-6.2-sol")).toBe(-1);
    expect(order("gpt-6-luna", "gpt-6.1-luna")).toBe(-1);
    expect(order("claude-opus-6", "claude-opus-6-0")).toBe(0);
  });

  test("newer models never downgrade or cross families", () => {
    const catalog = [
      "claude-opus-5-4",
      "claude-opus-5-6",
      "claude-opus-6",
      "claude-opus-6-0",
      "claude-sonnet-7",
      "gpt-6.2-sol",
      "gpt-6.2-sol-fast",
      "claude-fable-9",
    ];
    expect(newerModels("claude-opus-5-5", catalog, families)).toEqual([
      "claude-opus-6",
      "claude-opus-6-0",
      "claude-opus-5-6",
    ]);
    expect(newerModels("claude-opus-6", catalog, families)).toEqual([]);
    expect(newerModels("gpt-6.1-sol", catalog, families)).toEqual([
      "gpt-6.2-sol",
    ]);
    // Unknown or unconfigured families are ignored.
    expect(newerModels("claude-fable-5-1", catalog, families)).toEqual([]);
    expect(newerModels("deepseek-v4-pro", catalog, families)).toEqual([]);
  });

  test("candidates respect configured providers", () => {
    const refs = [
      parseRef("claude-proxy/claude-opus-5-5#high"),
      parseRef("openai-proxy/gpt-6.1-sol"),
      parseRef("anthropic/claude-sonnet-5-5"),
    ].flatMap((ref) => (ref ? [ref] : []));
    const result = upgradeCandidates(
      refs,
      ["claude-opus-5-6", "gpt-6.2-sol", "claude-sonnet-6"],
      families,
      providers,
    );
    expect([...result]).toEqual([
      ["claude-opus-5-5", ["claude-opus-5-6"]],
      ["gpt-6.1-sol", ["gpt-6.2-sol"]],
    ]);
  });

  test("a failed probe falls back to the next newer model only", async () => {
    const probed: string[] = [];
    const { chosen, failed } = await chooseUpgrades(
      new Map([
        ["claude-opus-5-5", ["claude-opus-6", "claude-opus-5-6"]],
        ["gpt-6.1-sol", ["gpt-6.3-sol", "gpt-6.2-sol"]],
      ]),
      async (id) => {
        probed.push(id);
        return id === "claude-opus-5-6";
      },
      2,
    );
    expect([...chosen]).toEqual([["claude-opus-5-5", "claude-opus-5-6"]]);
    expect(failed).toHaveLength(3);
    expect(probed).toEqual([
      "claude-opus-6",
      "claude-opus-5-6",
      "gpt-6.3-sol",
      "gpt-6.2-sol",
    ]);
    const limited = await chooseUpgrades(
      new Map([["claude-opus-5-5", ["claude-opus-6", "claude-opus-5-6"]]]),
      async () => false,
      1,
    );
    expect(limited.chosen.size).toBe(0);
    expect(limited.failed).toEqual([
      { from: "claude-opus-5-5", to: "claude-opus-6" },
    ]);
  });
});

const upgrades = new Map([
  ["gpt-6.1-sol", "gpt-6.2-sol"],
  ["claude-opus-5-5", "claude-opus-5-6"],
]);

describe("configuration rewrites", () => {
  test("team file keeps variants, prefixes and Pi workers", () => {
    const team = {
      captain: { id: "adama", model: "openai-proxy/gpt-6.1-sol#high" },
      crew: [
        { id: "chief", role: "r", model: "openai-proxy/gpt-6.1-sol" },
        { id: "roslin", role: "r", model: "claude-proxy/claude-opus-5-5" },
        { id: "other", role: "r", model: "go-proxy/gpt-6.1-sol" },
        {
          id: "twiki",
          role: "r",
          backend: { type: "pi-durable", model: "openai/gpt-6.1-sol" },
        },
      ],
    };
    const result = upgradeTeamFile(json(team), upgrades, providers);
    const next = JSON.parse(result.text);
    expect(next.captain.model).toBe("openai-proxy/gpt-6.2-sol#high");
    expect(next.crew[0].model).toBe("openai-proxy/gpt-6.2-sol");
    expect(next.crew[1].model).toBe("claude-proxy/claude-opus-5-6");
    expect(next.crew[2].model).toBe("go-proxy/gpt-6.1-sol");
    expect(next.crew[3].backend.model).toBe("openai/gpt-6.1-sol");
    expect(result.changes.map((c) => c.target)).toEqual([
      "/captain/model",
      "/crew/0/model",
      "/crew/1/model",
    ]);
    expect(() =>
      upgradeTeamFile(JSON.stringify(team), upgrades, providers),
    ).toThrow("config-format");
  });

  test("generated OpenCode profile", () => {
    const profile = {
      model: "openai-proxy/gpt-6.1-sol",
      agents: { "x-captain-adama": { model: "openai-proxy/gpt-6.1-sol" } },
      plugins: [
        {
          package: "/srv/pogo/deployment-plugin",
          options: {
            team: {
              captain: { id: "adama", model: "openai-proxy/gpt-6.1-sol" },
              crew: [{ id: "chief", model: "claude-proxy/claude-opus-5-5" }],
            },
          },
        },
      ],
    };
    const result = upgradeOpenCodeProfile(json(profile), upgrades, providers);
    expect(result.changes.map((c) => c.target)).toEqual([
      "/model",
      "/agents/x-captain-adama/model",
      "/plugins/0/options/team/captain/model",
      "/plugins/0/options/team/crew/0/model",
    ]);
    expect(result.text).not.toContain("gpt-6.1-sol");
  });
});

const agent = (model: string, description = "Work") =>
  `---\ndescription: ${description} (${model})\nmode: subagent\nmodel: ${model}\n---\n\nComplete only the task.\n`;

describe("child-agent profiles", () => {
  const routes = (
    entries: { name: string; model: string; weight: number }[],
  ) => ({
    version: 2,
    profile: "x",
    tiers: [
      { purpose: "One", routes: entries.slice(0, 1) },
      { purpose: "Two", routes: entries.slice(1) },
    ],
  });
  const snapshot: ProfilesSnapshot = {
    root: "/cfg/agent-profiles",
    agentsDirectory: "/cfg/agents",
    current: "05-claude-mix",
    folders: {
      "05-claude-mix": {
        routesText: json(
          routes([
            {
              name: "opus-5-5-high-subagent",
              model: "claude-proxy/claude-opus-5-5#high",
              weight: 2,
            },
            {
              name: "sol-6-1-high-subagent",
              model: "openai-proxy/gpt-6.1-sol#high",
              weight: 1,
            },
          ]),
        ),
        profileText:
          "Task | Agent | Model\nOne | opus-5-5-high-subagent | claude-proxy/claude-opus-5-5#high\n",
        files: {
          "opus-5-5-high-subagent.md": agent(
            "claude-proxy/claude-opus-5-5#high",
          ),
          "sol-6-1-high-subagent.md": agent("openai-proxy/gpt-6.1-sol#high"),
          "haiku-5-5-low-subagent.md": `${agent("claude-proxy/claude-haiku-5-5#low").replace("---\n\n", "disabled: true\n---\n\n")}`,
        },
      },
      "04-opencode-go": {
        routesText: json(
          routes([
            {
              name: "kimi-k3-max-subagent",
              model: "go-proxy/kimi-k3#max",
              weight: 1,
            },
            {
              name: "kimi-k3-max-subagent",
              model: "go-proxy/kimi-k3#max",
              weight: 1,
            },
          ]),
        ),
        profileText: "kimi\n",
        files: {
          "kimi-k3-max-subagent.md": agent("go-proxy/kimi-k3#max"),
          "opus-5-5-high-subagent.md": agent(
            "claude-proxy/claude-opus-5-5#high",
          ).replace("---\n\n", "disabled: true\n---\n\n"),
        },
      },
    },
    links: {
      "opus-5-5-high-subagent.md":
        "../agent-profiles/current/opus-5-5-high-subagent.md",
    },
  };

  test("renames upgraded routes, disables old names and adds links", () => {
    const result = upgradeProfiles(
      snapshot,
      new Map([["claude-opus-5-5", "claude-opus-5-6"]]),
      providers,
    );
    const writes = Object.fromEntries(
      result.writes.map((w) => [
        w.path.replace("/cfg/agent-profiles/", ""),
        w.content,
      ]),
    );
    const routed = writes["05-claude-mix/opus-5-6-high-subagent.md"];
    expect(routed).toContain("\nmodel: claude-proxy/claude-opus-5-6#high\n");
    expect(routed).toContain("(claude-proxy/claude-opus-5-6#high)");
    expect(routed).not.toContain("disabled: true");
    expect(writes["05-claude-mix/opus-5-5-high-subagent.md"]).toContain(
      "disabled: true\n---",
    );
    // Folders that do not route the agent still get a disabled file.
    expect(writes["04-opencode-go/opus-5-6-high-subagent.md"]).toContain(
      "disabled: true\n---",
    );
    expect(writes["04-opencode-go/routes.json"]).toBeDefined();
    const manifest = JSON.parse(writes["05-claude-mix/routes.json"] ?? "{}");
    expect(manifest.tiers[0].routes[0]).toEqual({
      name: "opus-5-6-high-subagent",
      model: "claude-proxy/claude-opus-5-6#high",
      weight: 2,
    });
    expect(manifest.tiers[1].routes[0].name).toBe("sol-6-1-high-subagent");
    expect(writes["05-claude-mix/PROFILE"]).toContain(
      "opus-5-6-high-subagent | claude-proxy/claude-opus-5-6#high",
    );
    expect(result.links).toEqual([
      {
        path: "/cfg/agents/opus-5-6-high-subagent.md",
        target: "../agent-profiles/current/opus-5-6-high-subagent.md",
      },
    ]);
    // Only agents routed by the selected profile load in OpenCode; the
    // disabled copies in other folders are not verified.
    expect(result.live).toEqual([
      {
        name: "opus-5-6-high-subagent",
        model: "claude-proxy/claude-opus-5-6#high",
      },
    ]);
    expect(
      upgradeProfiles(
        { ...snapshot, current: "04-opencode-go" },
        new Map([["claude-opus-5-5", "claude-opus-5-6"]]),
        providers,
      ).live,
    ).toEqual([]);
    expect(result.changes).toEqual([
      {
        target: "05-claude-mix/opus-5-5-high-subagent",
        from: "claude-proxy/claude-opus-5-5#high",
        to: "claude-proxy/claude-opus-5-6#high",
      },
    ]);
  });

  test("no upgrade, no writes; unknown names are reported, not renamed", () => {
    expect(upgradeProfiles(snapshot, new Map(), providers).writes).toEqual([]);
    const odd: ProfilesSnapshot = {
      ...snapshot,
      folders: {
        "01-x": {
          routesText: json(
            routes([
              {
                name: "best-subagent",
                model: "openai-proxy/gpt-6.1-sol#high",
                weight: 1,
              },
              {
                name: "best-subagent",
                model: "openai-proxy/gpt-6.1-sol#high",
                weight: 1,
              },
            ]),
          ),
          profileText: "",
          files: { "best-subagent.md": agent("openai-proxy/gpt-6.1-sol#high") },
        },
      },
    };
    const result = upgradeProfiles(odd, upgrades, providers);
    expect(result.writes).toEqual([]);
    expect(result.skipped.map((s) => s.target)).toEqual([
      "best-subagent",
      "best-subagent",
    ]);
  });
});
