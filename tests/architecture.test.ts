import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  architectureDocuments,
  buildGraph,
  boundaryViolations,
  cyclicEdges,
  documentationViolations,
  exceptionRegressions,
  graphRegressions,
  importClosure,
  normalizeGraph,
  sourceRootFiles,
  staleGraphBaseline,
  sizeRegressions,
  type GraphBaseline,
  type ArchitecturePolicy,
  type SourceGraph,
} from "./architecture-graph";
import baseline from "./architecture-baseline.json";
import policy from "./architecture-policy.json";

// Stable IDs and approved physical aliases live in the policy, not the future
// Layout table. A move changes physical paths, not IDs or exception permissions.
// Delete resolved exceptions and refresh lowered inventories in the same edit.
// Root/cycle lists only shrink; lower the closure cap by recording its members.
// Do not regenerate the baseline to accept new violations. Provenance and
// Module/edge totals are informational; guarded inventories must be current.
test("source architecture introduces no new structural or boundary violations", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const physical = await buildGraph(root);

  for (const entry of [
    "src/main.ts",
    "src/config.ts",
    "src/crew/plugin.ts",
    "src/fleet/plugin.ts",
  ])
    expect(physical.has(entry)).toBe(true);
  const source = normalizeGraph(physical, policy);

  const violations = [
    ...boundaryViolations(source, policy),
    ...(await documentationViolations(root, await architectureDocuments(root))),
  ];

  const roots = await sourceRootFiles(root);
  expect([
    ...graphRegressions(source, baseline, roots),
    ...exceptionRegressions(violations, baseline.exceptions),
    ...(await sizeRegressions(root, policy, baseline.largeFiles)),
  ]).toEqual([]);
  expect(
    staleGraphBaseline(source, baseline, roots),
    'Architecture baseline is stale. Refresh and commit the lowered baseline in this PR: mise run architecture-refresh -- --base "$(git merge-base origin/main HEAD)" --write. Do not raise caps or add permissions to accept a regression. --allow-closure-addition is only for files holding only code the closure already loaded, with a decision recorded for this change; otherwise remove the added import.',
  ).toEqual([]);
});

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

function fixturePolicy(): ArchitecturePolicy {
  return {
    slices: {
      alpha: {
        layer: "slices",
        files: [
          "src/alpha/entry.ts",
          "src/alpha/second.ts",
          "src/alpha/third.ts",
        ],
        public: ["src/alpha/entry.ts"],
        neighbours: ["beta", "lib"],
      },
      beta: {
        layer: "slices",
        files: ["src/beta/entry.ts", "src/beta/private.ts"],
        public: ["src/beta/entry.ts"],
        neighbours: ["lib"],
      },
      gamma: {
        layer: "slices",
        files: ["src/gamma/entry.ts"],
        public: ["src/gamma/entry.ts"],
        neighbours: ["lib", "beta"],
      },
      lib: {
        layer: "lib",
        files: ["src/lib/helper.ts"],
        public: ["src/lib/helper.ts"],
        neighbours: ["alpha"],
      },
      app: {
        layer: "app",
        files: ["src/main.ts"],
        public: ["src/main.ts"],
        neighbours: ["alpha"],
      },
    },
  };
}

function policyGraph(edges: Record<string, string[]>): SourceGraph {
  const files = Object.values(fixturePolicy().slices).flatMap(
    (slice) => slice.files,
  );

  return graph({
    ...Object.fromEntries(files.map((file) => [file, []])),
    ...edges,
  });
}

function movablePolicy(): ArchitecturePolicy {
  return {
    aliases: {
      "src/alpha.ts": ["src/alpha.ts", "src/alpha/entry.ts"],
      "src/private.ts": ["src/private.ts", "src/beta/private.ts"],
      "src/second-private.ts": [
        "src/second-private.ts",
        "src/beta/second-private.ts",
      ],
    },
    slices: {
      alpha: {
        layer: "slices",
        files: ["src/alpha.ts"],
        public: ["src/alpha.ts"],
        neighbours: ["beta"],
      },
      beta: {
        layer: "slices",
        files: ["src/private.ts", "src/second-private.ts"],
        public: [],
        neighbours: ["alpha"],
      },
    },
  };
}

describe("stable module identities", () => {
  test("accepted shared ownership survives the declared Stage 2 moves", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const shared = policy.slices.shared;
    expect(shared.files).toContain("src/session-history.ts");
    expect(shared.files).toContain("src/slack-format.ts");
    expect(policy.slices.slack.files).toContain("src/markdown-chunks.ts");
    expect(policy.aliases["src/slack-format.ts"]).toEqual([
      "src/slack-format.ts",
      "src/shared/slack-format.ts",
    ]);
    expect(policy.aliases["src/session-history.ts"]).toEqual([
      "src/session-history.ts",
      "src/shared/session-history.ts",
    ]);
    const physical = await buildGraph(root);

    const movedPath = (path: string) =>
      (policy.aliases as Record<string, string[]>)[path]?.at(-1) ?? path;

    const moved = new Map(
      [...physical].map(([path, imports]) => [
        movedPath(path),
        new Set([...imports].map(movedPath)),
      ]),
    );

    const original = normalizeGraph(physical, policy);
    const normalized = normalizeGraph(moved, policy);
    expect(normalized).toEqual(original);
    expect(boundaryViolations(normalized, policy)).toEqual(
      boundaryViolations(original, policy),
    );
    expect(cyclicEdges(normalized)).toEqual(cyclicEdges(original));
    // Two current consuming owners do not justify a lib promotion. Keep only
    // This exact legacy dependency until source work can remove it.
    expect(boundaryViolations(normalized, policy)).toContain(
      "shared-dependency:src/slack-format.ts -> src/markdown-chunks.ts",
    );
    expect(Object.values(policy.aliases).flat()).not.toContain(
      "src/lib/markdown-chunks.ts",
    );
  });

  test("pure approved file moves preserve cycle and private-edge exception IDs", async () => {
    const policy = movablePolicy();

    const recorded: GraphBaseline = {
      rootFiles: ["src/alpha.ts", "src/private.ts", "src/second-private.ts"],
      cyclicEdges: [
        "src/alpha.ts -> src/private.ts",
        "src/private.ts -> src/alpha.ts",
      ],
      largestCycle: 2,
      crewPlugin: {
        entry: "src/alpha.ts",
        members: ["src/alpha.ts", "src/private.ts"],
      },
    };

    const exceptions = ["private:src/alpha.ts -> src/private.ts"];

    const root = await fixture({
      "src/alpha.ts": 'import "./private";',
      "src/private.ts": 'import "./alpha";',
      "src/second-private.ts": "",
    });

    const original = normalizeGraph(await buildGraph(root), policy);
    expect(cyclicEdges(original)).toEqual(recorded.cyclicEdges);
    expect(boundaryViolations(original, policy)).toEqual(exceptions);

    await mkdir(join(root, "src/alpha"));
    await mkdir(join(root, "src/beta"));
    await rename(join(root, "src/alpha.ts"), join(root, "src/alpha/entry.ts"));
    await rename(
      join(root, "src/private.ts"),
      join(root, "src/beta/private.ts"),
    );
    await rename(
      join(root, "src/second-private.ts"),
      join(root, "src/beta/second-private.ts"),
    );
    await writeFile(
      join(root, "src/alpha/entry.ts"),
      'import "../beta/private";',
    );
    await writeFile(
      join(root, "src/beta/private.ts"),
      'import "../alpha/entry";',
    );
    const moved = normalizeGraph(await buildGraph(root), policy);
    expect(moved).toEqual(original);
    expect(
      graphRegressions(moved, recorded, await sourceRootFiles(root)),
    ).toEqual([]);
    expect(
      exceptionRegressions(boundaryViolations(moved, policy), exceptions),
    ).toEqual([]);

    await writeFile(
      join(root, "src/alpha/entry.ts"),
      'import "../beta/private"; import "../beta/second-private";',
    );
    await writeFile(
      join(root, "src/beta/second-private.ts"),
      'import "../alpha/entry";',
    );
    const changed = normalizeGraph(await buildGraph(root), policy);
    expect(
      exceptionRegressions(boundaryViolations(changed, policy), exceptions),
    ).toEqual(["new:private:src/alpha.ts -> src/second-private.ts"]);
    expect(
      graphRegressions(changed, recorded, await sourceRootFiles(root)),
    ).toContain("cycle:src/alpha.ts -> src/second-private.ts");
  });

  test("both aliases cannot coexist, and unknown paths cannot reuse permissions", () => {
    const policy = movablePolicy();
    expect(() =>
      normalizeGraph(
        graph({
          "src/alpha.ts": [],
          "src/alpha/entry.ts": [],
        }),
        policy,
      ),
    ).toThrow("simultaneous aliases");
    expect(() =>
      normalizeGraph(graph({ "src/unapproved/private.ts": [] }), policy),
    ).toThrow("unknown source path");
    const ambiguous = movablePolicy();

    if (!ambiguous.aliases) throw new Error("Missing fixture aliases");
    ambiguous.aliases["src/private.ts"] = [
      "src/private.ts",
      "src/alpha/entry.ts",
    ];
    expect(() => normalizeGraph(new Map(), ambiguous)).toThrow(
      "alias collision",
    );
  });

  test("root limits use physical paths, not the normalized module IDs", () => {
    const policy = movablePolicy();

    if (!policy.aliases) throw new Error("Missing fixture aliases");
    policy.aliases["src/alpha.ts"] = ["src/alpha.ts", "src/renamed-root.ts"];

    const normalized = normalizeGraph(
      graph({ "src/renamed-root.ts": [] }),
      policy,
    );

    expect(normalized.has("src/alpha.ts")).toBe(true);
    expect(
      graphRegressions(
        normalized,
        {
          ...emptyBaseline,
          rootFiles: ["src/alpha.ts"],
        },
        ["src/renamed-root.ts"],
      ),
    ).toEqual(["root:src/renamed-root.ts"]);
  });
});

describe("source size gate", () => {
  for (const ending of ["\n", "\r\n"])
    test(`counts non-blank lines with ${JSON.stringify(ending)}`, async () => {
      const root = await fixture({ "src/alpha/entry.ts": "" });

      for (const count of [999, 1000, 1001]) {
        for (const finalTerminator of [false, true]) {
          const source = Array.from({ length: count }, () => "// counted").join(
            ending,
          );

          await writeFile(
            join(root, "src/alpha/entry.ts"),
            source + (finalTerminator ? ending : ""),
          );
          expect(await sizeRegressions(root, fixturePolicy(), [])).toEqual(
            count > 1000
              ? [
                  "new:large-file:src/alpha/entry.ts:src/alpha/entry.ts:1001 non-blank lines > 1000",
                ]
              : [],
          );
        }
      }
    });

  test("rejects a new source module with 1001 non-blank lines", async () => {
    const root = await fixture({
      "src/alpha/entry.ts": "// counted\n".repeat(1001),
    });

    expect(await sizeRegressions(root, fixturePolicy(), [])).toEqual([
      "new:large-file:src/alpha/entry.ts:src/alpha/entry.ts:1001 non-blank lines > 1000",
    ]);
  });

  test("ignores blank and whitespace-only lines, counts comments, and excludes tests", async () => {
    const root = await fixture({
      "src/alpha/entry.ts": "",
      "tests/large.test.ts": "// not source\n".repeat(1001),
    });

    for (const ending of ["\n", "\r\n"]) {
      const blanks = ["", " ", "\t", "\f", "\r", " \t\f\r"];

      const padding = Array.from(
        { length: 500 },
        (_, index) => blanks[index % blanks.length] + ending,
      ).join("");

      await writeFile(
        join(root, "src/alpha/entry.ts"),
        padding + ("// counted" + ending).repeat(1000),
      );
      expect(await sizeRegressions(root, fixturePolicy(), [])).toEqual([]);
      await writeFile(
        join(root, "src/alpha/entry.ts"),
        padding + ("// counted" + ending).repeat(1001),
      );
      expect(await sizeRegressions(root, fixturePolicy(), [])).toEqual([
        "new:large-file:src/alpha/entry.ts:src/alpha/entry.ts:1001 non-blank lines > 1000",
      ]);
    }

    await writeFile(join(root, "src/alpha/entry.ts"), "");
    expect(await sizeRegressions(root, fixturePolicy(), [])).toEqual([]);
    expect(
      await sizeRegressions(root, fixturePolicy(), ["src/alpha/entry.ts"]),
    ).toEqual(["stale:large-file:src/alpha/entry.ts"]);
  });

  test("blank lines inside template literals do not count", async () => {
    const template =
      "export const text = `\n" + " \t\n".repeat(500) + "value`;\n";

    const root = await fixture({
      "src/alpha/entry.ts": template + "// counted\n".repeat(998),
    });

    expect(await sizeRegressions(root, fixturePolicy(), [])).toEqual([]);
    await writeFile(
      join(root, "src/alpha/entry.ts"),
      template + "// counted\n".repeat(999),
    );
    expect(await sizeRegressions(root, fixturePolicy(), [])).toEqual([
      "new:large-file:src/alpha/entry.ts:src/alpha/entry.ts:1001 non-blank lines > 1000",
    ]);
  });

  test("exceptions are exact, reject duplicates, and become stale at 1000 non-blank lines or deletion", async () => {
    const root = await fixture({
      "src/alpha/entry.ts": "// counted\n".repeat(1001),
    });

    const allowed = ["src/alpha/entry.ts"];
    expect(await sizeRegressions(root, fixturePolicy(), allowed)).toEqual([]);
    expect(
      await sizeRegressions(root, fixturePolicy(), [...allowed, ...allowed]),
    ).toEqual(["duplicate:large-file:src/alpha/entry.ts"]);
    await writeFile(
      join(root, "src/alpha/entry.ts"),
      "// counted\n".repeat(1000) + "\n".repeat(500),
    );
    expect(await sizeRegressions(root, fixturePolicy(), allowed)).toEqual([
      "stale:large-file:src/alpha/entry.ts",
    ]);
    await rm(join(root, "src/alpha/entry.ts"));
    await writeFile(
      join(root, "src/alpha/second.ts"),
      "// counted\n".repeat(1001),
    );
    expect(await sizeRegressions(root, fixturePolicy(), allowed)).toEqual([
      "new:large-file:src/alpha/second.ts:src/alpha/second.ts:1001 non-blank lines > 1000",
      "stale:large-file:src/alpha/entry.ts",
    ]);
  });

  test("approved renames retain only the exact stable Gateway exception", async () => {
    const policy: ArchitecturePolicy = {
      slices: {
        gateway: {
          layer: "gateway",
          files: [
            "src/gateway.ts",
            "src/gateway/child.ts",
            "src/other/gateway.ts",
          ],
          public: [],
          neighbours: [],
        },
      },
      aliases: {
        "src/gateway.ts": ["src/gateway.ts", "src/gateway/gateway.ts"],
      },
    };

    const root = await fixture({
      "src/gateway.ts": "// counted\n".repeat(1001),
    });

    const allowed = ["src/gateway.ts"];
    expect(await sizeRegressions(root, policy, allowed)).toEqual([]);
    await mkdir(join(root, "src/gateway"));
    await rename(
      join(root, "src/gateway.ts"),
      join(root, "src/gateway/gateway.ts"),
    );
    expect(await sizeRegressions(root, policy, allowed)).toEqual([]);
    expect(await sizeRegressions(root, policy, [])).toEqual([
      "new:large-file:src/gateway/gateway.ts:src/gateway.ts:1001 non-blank lines > 1000",
    ]);
    await writeFile(
      join(root, "src/gateway/child.ts"),
      "// counted\n".repeat(1001),
    );
    await mkdir(join(root, "src/other"));
    await writeFile(
      join(root, "src/other/gateway.ts"),
      "// counted\n".repeat(1001),
    );
    expect(await sizeRegressions(root, policy, allowed)).toEqual([
      "new:large-file:src/gateway/child.ts:src/gateway/child.ts:1001 non-blank lines > 1000",
      "new:large-file:src/other/gateway.ts:src/other/gateway.ts:1001 non-blank lines > 1000",
    ]);
    await writeFile(join(root, "src/gateway.ts"), "");
    await expect(sizeRegressions(root, policy, allowed)).rejects.toThrow(
      "simultaneous aliases",
    );
    await rm(join(root, "src/gateway.ts"));
    await writeFile(join(root, "src/gateway/unknown.ts"), "");
    await expect(sizeRegressions(root, policy, allowed)).rejects.toThrow(
      "unknown source path",
    );
  });
});

describe("architecture policy mechanics", () => {
  test("each source file has exactly one explicit owner and valid public declarations", () => {
    const policy = fixturePolicy();
    const alpha = policy.slices["alpha"];

    if (!alpha) throw new Error("Missing fixture owner");
    alpha.files.push("src/beta/private.ts");
    alpha.public.push("src/not-owned.ts");

    const failures = boundaryViolations(
      policyGraph({ "src/unknown.ts": [] }),
      policy,
    );

    expect(failures).toContain("membership:duplicate:src/beta/private.ts");
    expect(failures).toContain("membership:missing:src/unknown.ts");
    expect(failures).toContain(
      "policy:public-not-owned:alpha:src/not-owned.ts",
    );
  });

  test("a new private edge fails even when an old private edge was removed", () => {
    const violations = boundaryViolations(
      policyGraph({
        "src/alpha/entry.ts": ["src/beta/private.ts"],
      }),
      fixturePolicy(),
    );

    expect(violations).toContain(
      "private:src/alpha/entry.ts -> src/beta/private.ts",
    );
    expect(
      exceptionRegressions(violations, [
        "private:src/alpha/second.ts -> src/beta/private.ts",
        ...violations.filter((id) => !id.startsWith("private:")),
      ]),
    ).toEqual([
      "new:private:src/alpha/entry.ts -> src/beta/private.ts",
      "stale:private:src/alpha/second.ts -> src/beta/private.ts",
    ]);
    expect(exceptionRegressions([], ["private:removed -> edge"])).toEqual([
      "stale:private:removed -> edge",
    ]);
    expect(exceptionRegressions([], [])).toEqual([]);
  });

  test("public imports still obey layer direction and directed neighbour lists", () => {
    const failures = boundaryViolations(
      policyGraph({
        "src/alpha/entry.ts": ["src/main.ts", "src/gamma/entry.ts"],
        "src/beta/entry.ts": ["src/alpha/entry.ts"],
      }),
      fixturePolicy(),
    );

    expect(failures).toContain("direction:src/alpha/entry.ts -> src/main.ts");
    expect(failures).toContain(
      "neighbour:src/alpha/entry.ts -> src/gamma/entry.ts",
    );
    expect(failures).toContain(
      "neighbour:src/beta/entry.ts -> src/alpha/entry.ts",
    );
  });

  test("contract files precede composing config and cannot import slice implementation", () => {
    const policy = fixturePolicy();
    const alpha = policy.slices["alpha"];
    const app = policy.slices["app"];

    if (!alpha || !app) throw new Error("Missing fixture owner");
    alpha.contracts = ["src/alpha/entry.ts"];
    app.layer = "config";

    const failures = boundaryViolations(
      policyGraph({
        "src/alpha/entry.ts": ["src/alpha/second.ts"],
        "src/main.ts": ["src/alpha/entry.ts"],
      }),
      policy,
    );

    expect(failures).toContain(
      "direction:src/alpha/entry.ts -> src/alpha/second.ts",
    );
    expect(failures).not.toContain(
      "direction:src/main.ts -> src/alpha/entry.ts",
    );
  });

  test("rule of three counts distinct consuming slices, not files or tests", () => {
    const one = boundaryViolations(
      policyGraph({
        "src/alpha/entry.ts": ["src/lib/helper.ts"],
        "src/alpha/second.ts": ["src/lib/helper.ts"],
        "src/alpha/third.ts": ["src/lib/helper.ts"],
      }),
      fixturePolicy(),
    );

    expect(one).toContain("rule-three:underused:src/lib/helper.ts");

    const three = boundaryViolations(
      policyGraph({
        "src/alpha/entry.ts": ["src/lib/helper.ts", "src/beta/private.ts"],
        "src/beta/entry.ts": ["src/lib/helper.ts", "src/beta/private.ts"],
        "src/gamma/entry.ts": ["src/lib/helper.ts", "src/beta/private.ts"],
      }),
      fixturePolicy(),
    );

    expect(three.filter((id) => id.startsWith("rule-three:"))).toEqual([
      "rule-three:extract:src/beta/private.ts",
    ]);
    const publicPolicy = fixturePolicy();
    publicPolicy.slices["beta"]?.public.push("src/beta/private.ts");
    expect(
      boundaryViolations(
        policyGraph({
          "src/alpha/entry.ts": ["src/lib/helper.ts", "src/beta/private.ts"],
          "src/beta/entry.ts": ["src/lib/helper.ts", "src/beta/private.ts"],
          "src/gamma/entry.ts": ["src/lib/helper.ts", "src/beta/private.ts"],
        }),
        publicPolicy,
      ).filter((id) => id.startsWith("rule-three:")),
    ).toEqual([]);
  });

  test("lib/shared imports do not manufacture extra consuming slices", () => {
    const policy = fixturePolicy();
    policy.slices["shared"] = {
      layer: "contracts",
      files: ["src/shared/model.ts"],
      public: ["src/shared/model.ts"],
      neighbours: ["lib"],
    };

    const current = policyGraph({
      "src/alpha/entry.ts": ["src/lib/helper.ts"],
      "src/lib/helper.ts": ["src/lib/helper.ts"],
      "src/shared/model.ts": ["src/lib/helper.ts"],
      "tests/consumer.test.ts": ["src/lib/helper.ts"],
    });

    expect(boundaryViolations(current, policy)).toContain(
      "rule-three:underused:src/lib/helper.ts",
    );
  });

  test("retained stores/services are explicit; shared code cannot import slices", () => {
    const policy = fixturePolicy();
    const beta = policy.slices["beta"];

    if (!beta) throw new Error("Missing fixture owner");
    beta.retained = { "src/beta/private.ts": "store" };

    const failures = boundaryViolations(
      policyGraph({
        "src/alpha/entry.ts": ["src/beta/private.ts"],
        "src/beta/entry.ts": ["src/beta/private.ts"],
        "src/gamma/entry.ts": ["src/beta/private.ts"],
        "src/lib/helper.ts": ["src/alpha/entry.ts"],
      }),
      policy,
    );

    expect(failures).not.toContain("rule-three:extract:src/beta/private.ts");
    expect(failures).toContain(
      "shared-dependency:src/lib/helper.ts -> src/alpha/entry.ts",
    );
  });

  test("documentation checks current paths, including code, but not local target examples or external URLs", async () => {
    const root = await fixture({ "src/existing.ts": "" });

    const violations = await documentationViolations(root, {
      "docs/design.md": [
        "Current `./src/existing` and `src/**/*.ts`.",
        "Current `src/missing.ts`.",
        "```ts",
        'import "./src/fenced-missing.ts";',
        "```",
        "TARGET-LAYOUT: `src/future.ts`.",
        "Current `src/also-missing.ts`.",
        "```text TARGET-LAYOUT",
        "src/future-directory/",
        "```",
        "https://example.com/repo/src/external.ts",
      ].join("\n"),
    });

    expect(violations).toEqual([
      "source-path:docs/design.md:src/also-missing.ts",
      "source-path:docs/design.md:src/fenced-missing.ts",
      "source-path:docs/design.md:src/missing.ts",
    ]);
  });
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "stargate-architecture-"));
  temporary.push(root);

  for (const [name, source] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }

  return root;
}

function graph(edges: Record<string, string[]>): SourceGraph {
  return new Map(
    Object.entries(edges).map(([file, imports]) => [file, new Set(imports)]),
  );
}

const emptyBaseline: GraphBaseline = {
  rootFiles: [],
  cyclicEdges: [],
  crewPlugin: { entry: "src/crew/plugin.ts", members: ["src/crew/plugin.ts"] },
};

describe("architecture graph mechanics", () => {
  test("parses type imports, re-exports and literal dynamic imports, not text", async () => {
    const root = await fixture({
      "src/entry.ts": [
        'import type { A } from "./type-only";',
        'export type { B } from "./type-export";',
        'export * from "./star.js";',
        'export { value } from "./directory";',
        'import "./side-effect";',
        'const dynamic = import("./dynamic");',
        "const templateLiteral = import(`./literal-template`);",
        'type C = import("./type-query").C;',
        'const escaped = import("./escap\\u0065d");',
        '// import "./comment";',
        '/* export * from "./block-comment"; */',
        "const text = 'import(\"./string\")';",
        'const expression = /import\\(".\\/regex"\\)/;',
        'const template = `export * from "./template-text" ${import("./template-expression")}`;',
        'const object = { import(path: string) {} }; object.import("./method");',
        'const computed = import("./" + name);',
        'throw new Error("Production module executed");',
      ].join("\n"),
      "src/type-only.ts": "export type A = string;",
      "src/type-export.ts": "export type B = string;",
      "src/star.ts": "export const value = 1;",
      "src/directory/index.ts": "export const value = 1;",
      "src/side-effect.ts": "",
      "src/dynamic.ts": "",
      "src/literal-template.ts": "",
      "src/type-query.ts": "export type C = string;",
      "src/escaped.ts": "",
      "src/template-expression.ts": "",
    });

    const result = await buildGraph(root);
    expect([...(result.get("src/entry.ts") ?? [])].sort()).toEqual([
      "src/directory/index.ts",
      "src/dynamic.ts",
      "src/escaped.ts",
      "src/literal-template.ts",
      "src/side-effect.ts",
      "src/star.ts",
      "src/template-expression.ts",
      "src/type-export.ts",
      "src/type-only.ts",
      "src/type-query.ts",
    ]);
    expect(result.size).toBe(11);
  });

  test("rejects unresolved local imports rather than dropping their edges", async () => {
    const root = await fixture({ "src/main.ts": 'import "./missing";' });

    // Bun 1.4.4's rejects matcher blocks native parser filesystem callbacks.
    // Await the result before passing it to a synchronous matcher.
    const error: unknown = await buildGraph(root).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("./missing");
  });

  test("resolves local aliases rather than mistaking them for dependencies", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        imports: { "#feature": "./src/feature.ts" },
      }),
      "src/main.ts": 'import type { Value } from "#feature";',
      "src/feature.ts": "export type Value = string;",
    });

    const result = await buildGraph(root);
    expect([...(result.get("src/main.ts") ?? [])]).toEqual(["src/feature.ts"]);
  });

  test("rejects path traversal outside the repository", async () => {
    const root = await fixture({ "src/main.ts": 'import "../../outside.ts";' });

    const error: unknown = await buildGraph(root).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("outside repository");
  });

  test("rejects symlinked files and directories, even inside the repository", async () => {
    const root = await fixture({
      "src/main.ts": 'import "./alias";',
      "src/real/index.ts": "",
    });

    await symlink(join(root, "src/real"), join(root, "src/alias"));
    await expect(buildGraph(root)).rejects.toThrow("symbolic link");
    await rm(join(root, "src/alias"));
    await symlink(join(root, "src/real/index.ts"), join(root, "src/alias.ts"));
    await expect(buildGraph(root)).rejects.toThrow("symbolic link");
  });

  test("does not turn an invalid file suffix into a directory import", async () => {
    const root = await fixture({
      "src/main.ts": 'import "./folder.ts";',
      "src/folder/index.ts": "",
    });

    const error: unknown = await buildGraph(root).catch(
      (error: unknown) => error,
    );

    expect(String(error)).toContain("unresolved local import ./folder.ts");
  });

  test("rejects an absolute import rather than treating it as a package", async () => {
    const root = await fixture({
      "src/main.ts": 'import "/outside/module.ts";',
    });

    const error: unknown = await buildGraph(root).catch(
      (error: unknown) => error,
    );

    expect(String(error)).toContain("absolute source import");
  });

  test("new root identities fail even when the root count stays flat", () => {
    expect(
      graphRegressions(graph({ "src/new.ts": [] }), {
        ...emptyBaseline,
        rootFiles: ["src/old.ts"],
      }),
    ).toContain("root:src/new.ts");
  });

  test("new non-code root files cannot bypass the root identity limit", async () => {
    const root = await fixture({ "src/main.ts": "", "src/data.json": "{}" });
    const result = await buildGraph(root);
    expect(
      graphRegressions(
        result,
        {
          ...emptyBaseline,
          rootFiles: ["src/main.ts"],
        },
        await sourceRootFiles(root),
      ),
    ).toEqual(["root:src/data.json"]);
  });

  test("new small cycles and new edges inside legacy cycles fail", () => {
    const baseline = {
      ...emptyBaseline,
      cyclicEdges: [
        "src/a/x.ts -> src/a/y.ts",
        "src/a/y.ts -> src/a/z.ts",
        "src/a/z.ts -> src/a/x.ts",
      ],
    };

    const current = graph({
      "src/a/x.ts": ["src/a/y.ts", "src/a/z.ts"],
      "src/a/y.ts": ["src/a/z.ts"],
      "src/a/z.ts": ["src/a/x.ts"],
      "src/b/x.ts": ["src/b/y.ts"],
      "src/b/y.ts": ["src/b/x.ts"],
    });

    expect(graphRegressions(current, baseline)).toEqual([
      "cycle:src/a/x.ts -> src/a/z.ts",
      "cycle:src/b/x.ts -> src/b/y.ts",
      "cycle:src/b/y.ts -> src/b/x.ts",
    ]);
    expect(
      cyclicEdges(
        graph({
          "src/a/x.ts": ["src/a/y.ts"],
          "src/a/y.ts": [],
        }),
      ),
    ).toEqual([]);
    expect(cyclicEdges(graph({ "src/a/self.ts": ["src/a/self.ts"] }))).toEqual([
      "src/a/self.ts -> src/a/self.ts",
    ]);
    expect(
      graphRegressions(
        graph({
          "src/a/x.ts": ["src/a/y.ts"],
          "src/a/y.ts": ["src/a/x.ts"],
        }),
        {
          ...emptyBaseline,
          cyclicEdges: [
            "src/a/x.ts -> src/a/y.ts",
            "src/a/y.ts -> src/a/x.ts",
            "src/a/z.ts -> src/a/x.ts",
          ],
        },
      ),
    ).toEqual([]);
  });

  test("plugin closure counts type and dynamic edges, permits smaller replacements", () => {
    const current = graph({
      "src/crew/plugin.ts": ["src/types.ts", "src/dynamic.ts"],
      "src/types.ts": ["src/leaf.ts"],
      "src/dynamic.ts": ["src/leaf.ts"],
      "src/leaf.ts": [],
    });

    expect(importClosure(current, "src/crew/plugin.ts")).toEqual([
      "src/crew/plugin.ts",
      "src/dynamic.ts",
      "src/leaf.ts",
      "src/types.ts",
    ]);
    expect(
      graphRegressions(current, {
        ...emptyBaseline,
        rootFiles: ["src/types.ts", "src/dynamic.ts", "src/leaf.ts"],
      }),
    ).toContain("crew-closure:4 > 1");
    expect(
      graphRegressions(
        graph({
          "src/crew/plugin.ts": ["src/lib/replacement.ts"],
          "src/lib/replacement.ts": [],
        }),
        {
          ...emptyBaseline,
          crewPlugin: {
            entry: "src/crew/plugin.ts",
            members: ["src/crew/plugin.ts", "src/old.ts", "src/older.ts"],
          },
        },
      ),
    ).toEqual([]);
  });
});
