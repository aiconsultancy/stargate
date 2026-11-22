import { describe, expect, test } from "bun:test";
import {
  graphRegressions,
  staleGraphBaseline,
  type GraphBaseline,
  type SourceGraph,
} from "./architecture-graph";

type StrictBaseline = GraphBaseline & {
  largestCycle: number;
  cycleComponents: string[][];
};

const a = "src/crew/a.ts";
const b = "src/crew/b.ts";
const root = "src/main.ts";
const ab = "src/crew/a.ts -> src/crew/b.ts";
const ba = "src/crew/b.ts -> src/crew/a.ts";

function fixture(): Map<string, Set<string>> {
  return new Map([
    [a, new Set([b])],
    [b, new Set([a])],
    [root, new Set<string>()],
  ]);
}

function baseline(): StrictBaseline {
  return {
    rootFiles: [root],
    cyclicEdges: [ab, ba],
    largestCycle: 2,
    cycleComponents: [[a, b]],
    crewPlugin: { entry: a, members: [a, b] },
  };
}

function failures(
  graph: SourceGraph,
  recorded: StrictBaseline,
  roots = [root],
) {
  return [
    ...graphRegressions(graph, recorded, roots),
    ...staleGraphBaseline(graph, recorded, roots),
  ];
}

describe("strict architecture baseline", () => {
  test("largest cycle: actual below, equal to, and above the cap", () => {
    const recorded = baseline();
    expect(failures(fixture(), { ...recorded, largestCycle: 3 })).toEqual([
      "stale:largest-cycle:2 < 3",
    ]);
    expect(failures(fixture(), recorded)).toEqual([]);
    expect(failures(fixture(), { ...recorded, largestCycle: 1 })).toEqual([
      "largest-cycle:2 > 1",
    ]);
  });

  test("component inventory detects missing and extra groups", () => {
    const recorded = baseline();
    expect(
      failures(fixture(), {
        ...recorded,
        cycleComponents: [[a, b], ["src/old/self.ts"]],
      }),
    ).toEqual(["stale:cycle-components"]);
    expect(failures(fixture(), recorded)).toEqual([]);
    expect(failures(fixture(), { ...recorded, cycleComponents: [] })).toEqual([
      "stale:cycle-components",
    ]);
  });

  test("cyclic edge inventory detects removed, added, and replaced edges", () => {
    const recorded = baseline();
    const old = "src/old/a.ts -> src/old/b.ts";
    expect(
      failures(fixture(), { ...recorded, cyclicEdges: [ab, ba, old] }),
    ).toEqual([`stale:cycle:${old}`]);
    expect(failures(fixture(), recorded)).toEqual([]);
    expect(failures(fixture(), { ...recorded, cyclicEdges: [ab] })).toEqual([
      `cycle:${ba}`,
    ]);
    expect(
      failures(fixture(), { ...recorded, cyclicEdges: [ab, old] }),
    ).toEqual([`cycle:${ba}`, `stale:cycle:${old}`]);
  });

  test("crew closure detects count changes and equal-count replacement", () => {
    const recorded = baseline();
    const old = "src/crew/old.ts";
    expect(
      failures(fixture(), {
        ...recorded,
        crewPlugin: { entry: a, members: [a, b, old] },
      }),
    ).toEqual(["stale:crew-closure:2 < 3", `stale:crew-member:${old}`]);
    expect(failures(fixture(), recorded)).toEqual([]);
    expect(
      failures(fixture(), {
        ...recorded,
        crewPlugin: { entry: a, members: [a] },
      }),
    ).toEqual(["crew-closure:2 > 1"]);
    expect(
      failures(fixture(), {
        ...recorded,
        crewPlugin: { entry: a, members: [a, old] },
      }),
    ).toEqual([`stale:crew-member:${old}`]);
  });

  test("physical roots detect removed, added, and replaced paths", () => {
    const recorded = baseline();
    const old = "src/old.ts";
    expect(
      failures(fixture(), { ...recorded, rootFiles: [root, old] }),
    ).toEqual([`stale:root:${old}`]);
    expect(failures(fixture(), recorded)).toEqual([]);
    expect(failures(fixture(), { ...recorded, rootFiles: [] })).toEqual([
      `root:${root}`,
    ]);
    expect(failures(fixture(), { ...recorded, rootFiles: [old] })).toEqual([
      `root:${root}`,
      `stale:root:${old}`,
    ]);
  });

  test("self-loops are components and component ordering is immaterial", () => {
    const current = fixture();
    const self = "src/other/self.ts";
    current.set(self, new Set([self]));
    const recorded = baseline();
    recorded.cyclicEdges.push("src/other/self.ts -> src/other/self.ts");
    recorded.cycleComponents = [[self], [b, a]];
    expect(failures(current, recorded)).toEqual([]);
    expect(
      failures(current, { ...recorded, cycleComponents: [[b, a]] }),
    ).toEqual(["stale:cycle-components"]);
  });

  test("a self-loop exceeds a zero largest-cycle cap", () => {
    const self = "src/other/self.ts";
    const current: SourceGraph = new Map([[self, new Set([self])]]);
    const recorded: StrictBaseline = {
      rootFiles: [],
      cyclicEdges: ["src/other/self.ts -> src/other/self.ts"],
      largestCycle: 0,
      cycleComponents: [[self]],
      crewPlugin: { entry: self, members: [self] },
    };
    expect(failures(current, recorded, [])).toEqual(["largest-cycle:1 > 0"]);
  });

  test("informational measurements do not cap unrelated acyclic modules or edges", () => {
    const current = fixture();
    current.set("src/other/new.ts", new Set(["src/other/leaf.ts"]));
    current.set("src/other/leaf.ts", new Set());
    const recorded = {
      ...baseline(),
      sourceFiles: 3,
      sourceEdges: 2,
      sourceCommit: "recorded-commit",
      measurementStatus: "recorded",
    };
    expect(failures(current, recorded)).toEqual([]);
  });
});
