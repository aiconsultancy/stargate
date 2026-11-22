import { expect, test } from "bun:test";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import {
  catalogRefs,
  upgradeGlobalCatalog,
} from "../src/maintenance/nightly/catalog";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const text = json({
  model: "openai-proxy/gpt-6.1-sol",
  providers: {
    "openai-proxy": {
      settings: { timeout: 10000 },
      models: {
        "gpt-6-sol": { limit: { context: 1000 } },
        "gpt-6.1-sol": {
          name: "Sol",
          limit: { context: 2000 },
          variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
          settings: { store: false },
        },
        "gpt-6-astra": { variants: [{ id: "high" }] },
        "gpt-6-mystery": { name: "Not configured" },
      },
    },
    other: { models: { "gpt-6.1-sol": { name: "Other" } } },
  },
});
const providers = ["openai-proxy"];
const families = ["gpt-sol", "gpt-astra"];

test("catalog templates are the newest declared member of configured families and providers", () => {
  expect(catalogRefs(text, families, providers)).toEqual([
    { providerID: "openai-proxy", id: "gpt-6.1-sol" },
    { providerID: "openai-proxy", id: "gpt-6-astra" },
  ]);
});

test("catalog adds only selected newer members, copying all settings without rewriting existing entries", () => {
  const result = upgradeGlobalCatalog(
    text,
    new Map([
      ["gpt-6.1-sol", "gpt-6.2-sol"],
      ["gpt-6-astra", "gpt-6.2-astra"],
      ["gpt-6-mystery", "gpt-7-mystery"],
    ]),
    families,
    providers,
  );
  const before = JSON.parse(text);
  const after = JSON.parse(result.text);
  const models = after.providers["openai-proxy"].models;
  expect(models["gpt-6.2-sol"]).toEqual(models["gpt-6.1-sol"]);
  expect(models["gpt-6.2-astra"]).toEqual(models["gpt-6-astra"]);
  delete models["gpt-6.2-sol"];
  delete models["gpt-6.2-astra"];
  expect(after).toEqual(before);
  expect(result.additions.map((a) => a.to.id)).toEqual([
    "gpt-6.2-sol",
    "gpt-6.2-astra",
  ]);
  expect(result.additions[0]?.variants).toEqual(["high"]);
  const native = Schema.decodeUnknownSync(Config.Info)(JSON.parse(result.text));
  expect(
    native.providers?.["openai-proxy"]?.models?.["gpt-6.2-sol"]?.variants?.map(
      (variant) => String(variant.id),
    ),
  ).toEqual(["high"]);
  expect(
    native.providers?.["openai-proxy"]?.models?.["gpt-6.2-sol"]?.settings?.[
      "store"
    ],
  ).toBe(false);
});

test("catalog never overwrites a declaration or creates suffixed products or downgrades", () => {
  for (const to of [
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6.2-sol-fast",
    "gpt-7-astra",
  ]) {
    expect(
      upgradeGlobalCatalog(
        text,
        new Map([["gpt-6.1-sol", to]]),
        families,
        providers,
      ).text,
    ).toBe(text);
  }
  expect(() =>
    catalogRefs(JSON.stringify(JSON.parse(text)), families, providers),
  ).toThrow("config-format");
});

test("an older route still copies the newest declared family template", () => {
  const result = upgradeGlobalCatalog(
    text,
    new Map([["gpt-6-sol", "gpt-6.2-sol"]]),
    families,
    providers,
  );
  const models = JSON.parse(result.text).providers["openai-proxy"].models;
  expect(models["gpt-6.2-sol"]).toEqual(models["gpt-6.1-sol"]);
});

test("a new declaration sends the probed model ID, not the template's API model identity", () => {
  const source = json({
    providers: {
      "openai-proxy": {
        models: {
          "gpt-6.1-sol": {
            modelID: "gpt-6.1-sol",
            settings: { store: false },
            variants: [{ id: "high" }],
          },
        },
      },
    },
  });
  const result = upgradeGlobalCatalog(
    source,
    new Map([["gpt-6.1-sol", "gpt-6.2-sol"]]),
    families,
    providers,
  );
  const models = JSON.parse(result.text).providers["openai-proxy"].models;
  expect(models["gpt-6.2-sol"]).toEqual({
    ...models["gpt-6.1-sol"],
    modelID: "gpt-6.2-sol",
  });
  expect(models["gpt-6.1-sol"].modelID).toBe("gpt-6.1-sol");
});
