import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { z } from "zod";

test("Pi runtime packages stay pinned to one release", async () => {
  const { dependencies } = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(await Bun.file(new URL("../package.json", import.meta.url)).json());

  const versions = [
    "@earendil-works/chord",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-durable",
  ].map((name) =>
    z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .parse(dependencies[name]),
  );

  expect(new Set(versions).size).toBe(1);
});

test("Claude Agent SDK stays pinned to one exact release", async () => {
  const { dependencies } = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(await Bun.file(new URL("../package.json", import.meta.url)).json());

  // The SDK bundles its Claude Code CLI; a range would change it silently.
  expect(dependencies["@anthropic-ai/claude-agent-sdk"]).toMatch(
    /^\d+\.\d+\.\d+$/,
  );
});

test("Codex SDK stays pinned to one exact release with its CLI", async () => {
  const { dependencies } = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(await Bun.file(new URL("../package.json", import.meta.url)).json());

  const pinned = z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .parse(dependencies["@openai/codex-sdk"]);

  // The SDK runs the CLI of its own version; the lock must agree.
  const sdk = z
    .object({
      version: z.string(),
      dependencies: z.record(z.string(), z.string()),
    })
    .parse(
      await Bun.file(
        new URL(
          "../node_modules/@openai/codex-sdk/package.json",
          import.meta.url,
        ),
      ).json(),
    );

  expect(sdk.version).toBe(pinned);
  expect(sdk.dependencies["@openai/codex"]).toBe(pinned);
});

test("dependency provenance checks every page, signature, count, and current head", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        quality: z.object({
          steps: z.array(
            z.object({ name: z.string(), run: z.string().optional() }),
          ),
        }),
      }),
    })
    .parse(
      Bun.YAML.parse(
        await Bun.file(
          new URL("../.github/workflows/check.yml", import.meta.url),
        ).text(),
      ),
    );

  const script = workflow.jobs.quality.steps.find(
    ({ name }) => name === "Verify dependency commit provenance",
  )?.run;

  const filter = script?.split("jq -e")[1]?.match(/'([\s\S]+)'/)?.[1];

  if (!filter) throw new Error("Missing dependency provenance filter");

  const trusted = {
    sha: "head",
    author: { login: "dependabot[bot]" },
    commit: { verification: { verified: true } },
  };

  const first = { ...trusted, sha: "first" };

  const status = (pages: unknown[][], count: number, head = "head") =>
    spawnSync(
      "jq",
      [
        "-e",
        "--argjson",
        "count",
        String(count),
        "--arg",
        "head",
        head,
        filter,
      ],
      { input: JSON.stringify(pages), encoding: "utf8" },
    ).status;

  expect(status([[trusted]], 1)).toBe(0);
  expect(status([[first], [trusted]], 2)).toBe(0);
  expect(
    status([[first], [{ ...trusted, author: { login: "maintainer" } }]], 2),
  ).toBe(1);
  expect(
    status(
      [[{ ...trusted, commit: { verification: { verified: false } } }]],
      1,
    ),
  ).toBe(1);
  expect(status([[trusted]], 2)).toBe(1);
  expect(status([[trusted]], 1, "new-head")).toBe(1);
  expect(status([[]], 0)).toBe(1);
});

test("OpenCode SDK packages share an exact stable release and its Effect version", async () => {
  const manifest = z.object({
    version: z.string(),
    dependencies: z.record(z.string(), z.string()),
    peerDependencies: z.record(z.string(), z.string()).default({}),
  });

  const read = async (path: string) =>
    manifest.parse(await Bun.file(new URL(path, import.meta.url)).json());

  const stargate = await read("../package.json");
  const plugin = await read("../node_modules/@opencode/plugin/package.json");
  const client = await read("../node_modules/@opencode/client/package.json");
  const schema = await read("../node_modules/@opencode/schema/package.json");

  const sdkVersion = z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .parse(stargate.dependencies["@opencode/plugin"]);

  expect(stargate.dependencies["@opencode/client"]).toBe(sdkVersion);
  expect(stargate.dependencies["@opencode/schema"]).toBe(sdkVersion);
  expect(client.version).toBe(sdkVersion);
  expect(plugin.version).toBe(sdkVersion);
  expect(schema.version).toBe(sdkVersion);
  expect(plugin.dependencies["@opencode/client"]).toBe(sdkVersion);
  // One runtime copy: Stargate programs and the SDK share fiber/runtime types.
  expect(stargate.dependencies["effect"]).toMatch(/^\d+\.\d+\.\d+$/);
  expect(stargate.dependencies["effect"]).toBe(plugin.dependencies["effect"]);
  expect(stargate.dependencies["effect"]).toBe(
    client.peerDependencies["effect"],
  );
  expect(stargate.dependencies["effect"]).toBe(schema.dependencies["effect"]);
  expect(stargate.dependencies["@opencode/schema"]).toBe(
    plugin.dependencies["@opencode/schema"],
  );
  expect(stargate.dependencies["@opencode/schema"]).toBe(
    client.dependencies["@opencode/schema"],
  );
});

test("Dependabot updates OpenCode and Effect together after one day", async () => {
  const { updates } = z
    .object({
      updates: z.array(
        z.object({
          "package-ecosystem": z.string(),
          schedule: z.object({ interval: z.string() }),
          cooldown: z.object({ "default-days": z.number() }),
          ignore: z.array(z.unknown()).default([]),
          groups: z.record(
            z.string(),
            z.object({ patterns: z.array(z.string()) }),
          ),
        }),
      ),
    })
    .parse(
      Bun.YAML.parse(
        await Bun.file(
          new URL("../.github/dependabot.yml", import.meta.url),
        ).text(),
      ),
    );

  const bun = updates.find((update) => update["package-ecosystem"] === "bun");
  expect(bun?.groups["opencode-sdk"]?.patterns).toEqual([
    "@opencode/*",
    "effect",
  ]);
  expect(bun?.ignore).toEqual([]);
  const groups = Object.keys(bun?.groups ?? {});
  expect(groups.indexOf("opencode-sdk")).toBeLessThan(
    groups.indexOf("dependencies"),
  );

  for (const update of updates) {
    expect(update.schedule.interval).toBe("daily");
    expect(update.cooldown["default-days"]).toBe(1);
  }
});
