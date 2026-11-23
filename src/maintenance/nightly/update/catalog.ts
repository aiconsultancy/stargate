import { homedir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { StepError } from "../exec";
import { type ModelRef, compareModels, parseModel } from "./versions";

const record = Schema.Record(Schema.String, Schema.Unknown);
const decodeRecord = Schema.decodeUnknownSync(record);

const decodeModels = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, record),
);

const decodeVariants = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ id: Schema.String })),
);

export function globalCatalogPath(settings: {
  globalConfigFile?: string | undefined;
}) {
  return (
    settings.globalConfigFile ??
    join(
      process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
      "opencode",
      "opencode.json",
    )
  );
}

function parseCatalog(text: string) {
  try {
    const config = decodeRecord(JSON.parse(text));

    if (`${JSON.stringify(config, null, 2)}\n` !== text)
      throw new Error("Model catalog is not canonical JSON");
    const providers = decodeRecord(config["providers"]);

    return { config, providers };
  } catch {
    throw new StepError("config-format");
  }
}

/** One template per provider/family: the newest existing exact member. */
export function catalogRefs(
  text: string,
  families: readonly string[],
  providers: readonly string[],
): ModelRef[] {
  const parsed = parseCatalog(text);
  const refs: ModelRef[] = [];

  for (const providerID of providers) {
    if (!Object.hasOwn(parsed.providers, providerID)) continue;
    const provider = decodeRecord(parsed.providers[providerID]);

    if (provider["models"] === undefined) continue;
    const models = decodeModels(provider["models"]);
    const newest = new Map<string, string>();

    for (const id of Object.keys(models)) {
      const model = parseModel(id);

      if (!model || !families.includes(model.family)) continue;
      const previous = newest.get(model.family);
      const before = previous ? parseModel(previous) : null;

      if (!before || compareModels(model, before) > 0)
        newest.set(model.family, id);
    }

    refs.push(...[...newest.values()].map((id) => ({ providerID, id })));
  }

  return refs;
}

export type CatalogAddition = {
  from: ModelRef;
  to: ModelRef;
  variants: string[];
};

/** Additive only. Copy settings verbatim; keep every existing declaration. */
export function upgradeGlobalCatalog(
  text: string,
  upgrades: ReadonlyMap<string, string>,
  families: readonly string[],
  providers: readonly string[],
) {
  const parsed = parseCatalog(text);
  const additions: CatalogAddition[] = [];
  const updatedProviders = { ...parsed.providers };

  for (const from of catalogRefs(text, families, providers)) {
    const before = parseModel(from.id);

    for (const next of new Set(
      [...upgrades].flatMap(([id, to]) =>
        parseModel(id)?.family === before?.family ? [to] : [],
      ),
    )) {
      const after = next ? parseModel(next) : null;

      if (
        !next ||
        !before ||
        !after ||
        before.family !== after.family ||
        compareModels(after, before) <= 0
      )
        continue;
      const provider = { ...decodeRecord(updatedProviders[from.providerID]) };
      const models = { ...decodeModels(provider["models"]) };

      if (Object.hasOwn(models, next)) continue;
      const template = models[from.id];

      if (!template) throw new StepError("config-format");

      const variants =
        template["variants"] === undefined
          ? []
          : decodeVariants(template["variants"]).map((variant) => variant.id);

      Object.defineProperty(models, next, {
        value: {
          ...structuredClone(template),
          ...(Object.hasOwn(template, "modelID") ? { modelID: next } : {}),
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      provider["models"] = models;
      updatedProviders[from.providerID] = provider;
      additions.push({
        from,
        to: { providerID: from.providerID, id: next },
        variants,
      });
    }
  }

  return {
    text: additions.length
      ? `${JSON.stringify({ ...parsed.config, providers: updatedProviders }, null, 2)}\n`
      : text,
    additions,
  };
}
