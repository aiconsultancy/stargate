import { Schema } from "effect";

const path = Schema.String.check(
  Schema.isPattern(
    /^(src|plugins|tests|scripts|perf)\/(?:[\w-]+\/)*[\w.-]+\.ts$/,
  ),
);

const config = Schema.Struct({
  ignorePatterns: Schema.optional(Schema.Array(Schema.String)),
  overrides: Schema.Array(
    Schema.Struct({
      files: Schema.optional(Schema.Array(Schema.String)),
      excludeFiles: Schema.optional(Schema.Array(path)),
      rules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

export const spacingRule = "anti-slop/require-readable-spacing";
export const lintRoots = ["src", "plugins", "tests", "scripts", "perf"];

export async function hardModeConfig() {
  const input: unknown = await Bun.file(".oxlintrc.json").json();
  const { ignorePatterns, overrides } = Schema.decodeUnknownSync(config)(input);

  const [zod, extra] = overrides.flatMap(({ excludeFiles }) =>
    excludeFiles ? [excludeFiles] : [],
  );

  if (!zod || extra || new Set(zod).size !== zod.length) {
    throw new Error(
      "Expected one list of unique Zod lint exclusions in .oxlintrc.json",
    );
  }

  const fixed =
    overrides.find((ruleSet) => ruleSet.rules?.[spacingRule] === "off")
      ?.files ?? [];

  return {
    zod,
    fixed: Schema.decodeUnknownSync(Schema.Array(path))(fixed),
    ignorePatterns,
  };
}
