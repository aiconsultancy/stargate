import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { API, SymbolFlags } from "typescript/unstable/async";
import * as fixedConfig from "../src/config";

// Generated from the module's compiler export table at 01952d8e686efaa00d79e4a761374790757f3e1f.
// Source blob: bf903ef15ab38fdc20b93f7948f32009578f980c. Never regenerate this pin during tests or moves.
// An intentional API change must update this reviewed snapshot explicitly.
const approvedExports = [
  {
    name: "AgentDispatchConfig",
    kind: "type",
  },
  {
    name: "BackendConfig",
    kind: "type",
  },
  {
    name: "BotConfig",
    kind: "type",
  },
  {
    name: "Config",
    kind: "type",
  },
  {
    name: "EffectiveIrcConfig",
    kind: "type",
  },
  {
    name: "IrcConfig",
    kind: "type",
  },
  {
    name: "TeamsConfig",
    kind: "type",
  },
  {
    name: "agentDispatchDefaults",
    kind: "value",
  },
  {
    name: "agentDispatchSchema",
    kind: "value",
  },
  {
    name: "agentDispatchTarget",
    kind: "value",
  },
  {
    name: "backendSchema",
    kind: "value",
  },
  {
    name: "botSchema",
    kind: "value",
  },
  {
    name: "claudeBackendSchema",
    kind: "value",
  },
  {
    name: "claudeToolNames",
    kind: "value",
  },
  {
    name: "codexBackendSchema",
    kind: "value",
  },
  {
    name: "configSchema",
    kind: "value",
  },
  {
    name: "defaultAllCallWords",
    kind: "value",
  },
  {
    name: "effectiveIrcConfig",
    kind: "value",
  },
  {
    name: "ircFeatureDefaults",
    kind: "value",
  },
  {
    name: "ircFeedbackDefaults",
    kind: "value",
  },
  {
    name: "ircSchema",
    kind: "value",
  },
  {
    name: "loadConfig",
    kind: "value",
  },
  {
    name: "piCrewBackendSchema",
    kind: "value",
  },
  {
    name: "piDurableBackendSchema",
    kind: "value",
  },
  {
    name: "pinnedSessionIDs",
    kind: "value",
  },
  {
    name: "registrationIds",
    kind: "value",
  },
  {
    name: "reloadConfigSchema",
    kind: "value",
  },
  {
    name: "secret",
    kind: "value",
  },
  {
    name: "teamsSchema",
    kind: "value",
  },
];

test("fixed config entry preserves every exported name and value/type kind", async () => {
  const root = resolve(import.meta.dir, "..");
  const file = join(root, "src/config.ts");
  const config = join(root, ".config-export-contract.json");
  const contents = JSON.stringify({
    compilerOptions: {
      strict: true,
      module: "ESNext",
      moduleResolution: "Bundler",
      types: ["bun"],
      skipLibCheck: true,
      noEmit: true,
    },
    files: [file],
  });
  const api = new API({
    cwd: root,
    fs: {
      fileExists: (path) => (path === config ? true : undefined),
      readFile: (path) => (path === config ? contents : undefined),
    },
  });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (!project) throw new Error("Missing config export project");
      const source = await project.program.getSourceFile(file);
      if (!source) throw new Error("Missing fixed config entry");
      const module = await project.checker.getSymbolAtLocation(source);
      if (!module) throw new Error("Missing fixed config module symbol");
      const actual = [];
      for (const symbol of await project.checker.getExportsOfModule(module)) {
        const target =
          symbol.flags & SymbolFlags.Alias
            ? await project.checker.getAliasedSymbol(symbol)
            : symbol;
        if (await project.checker.isUnknownSymbol(target))
          throw new Error(`Unresolved config export: ${symbol.name}`);
        const value = Object.hasOwn(fixedConfig, symbol.name);
        const type = Boolean(target.flags & SymbolFlags.Type) || !value;
        actual.push({
          name: symbol.name,
          kind: value ? (type ? "type+value" : "value") : "type",
        });
      }
      actual.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      expect(actual).toEqual(approvedExports);
      expect(Object.keys(fixedConfig).sort()).toEqual(
        approvedExports
          .filter(({ kind }) => kind !== "type")
          .map(({ name }) => name)
          .sort(),
      );
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}, 30_000);

test("launcher-style explicit config.ts import loads config and resolves secrets", async () => {
  const { loadConfig, secret }: typeof import("../src/config") = await import(
    new URL("../src/config.ts", import.meta.url).href
  );
  expect(loadConfig).toBe(fixedConfig.loadConfig);
  expect(secret).toBe(fixedConfig.secret);
  const directory = await mkdtemp(join(tmpdir(), "stargate-config-contract-"));
  try {
    const path = join(directory, "stargate.json");
    await writeFile(
      path,
      JSON.stringify({
        dataDirectory: "state",
        bots: [
          {
            id: "launcher-probe",
            slack: {
              appId: "A123",
              appTokenEnv: "CONTRACT_APP_TOKEN",
              botTokenEnv: "CONTRACT_BOT_TOKEN",
            },
            access: { users: ["U123"], channels: ["C123"] },
            backend: {
              type: "opencode",
              url: "http://127.0.0.1:4100",
              directory,
            },
          },
        ],
      }),
    );
    const config = await loadConfig(path);
    expect(config.dataDirectory).toBe(join(directory, "state"));
    expect(config.bots[0]?.id).toBe("launcher-probe");
    expect(config.bots[0]?.backend.type).toBe("opencode");
    expect(secret("CONTRACT_VALUE", { CONTRACT_VALUE: "test-value" })).toBe(
      "test-value",
    );
    expect(() => secret("CONTRACT_MISSING", {})).toThrow(
      "Missing environment variable: CONTRACT_MISSING",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
