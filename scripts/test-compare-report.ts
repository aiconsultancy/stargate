/** The small XML subset emitted by Bun JUnit. No DTD or external entities. */
type Xml = {
  tag: string;
  attributes: Record<string, string>;
  children: Xml[];
  text: string;
};

export type LoadAverage = [number, number, number] | "unavailable";

export type ProcessIdentity = {
  pid: number;
  parentPid: number;
  groupId: number;
  sessionId: number;
  startTimeTicks: string;
  state: string;
};

export type GroupSnapshot = { members: ProcessIdentity[]; errors: string[] };

export type CleanupReport = {
  groups: {
    groupId: number;
    sessionId: number | null;
    spawnLeader: ProcessIdentity | null;
    firstSignalMembers: ProcessIdentity[];
    currentMembers: ProcessIdentity[];
    errors: string[];
    reason: string;
    signalDisposition: "sent" | "withheld" | "not-needed";
    signalsSent: number;
  }[];
  workspace: {
    path: string | null;
    state: "not-created" | "retained" | "removed" | "not-confirmed";
  };
  lock: {
    path: string | null;
    state:
      | "not-used"
      | "not-acquired"
      | "held"
      | "released"
      | "not-confirmed-released";
  };
};

export function cleanupMessage(cleanup: CleanupReport): string {
  const lines = [
    cleanup.groups.length > 0 ? "Cleanup failed:" : "Cleanup status:",
  ];

  for (const group of cleanup.groups) {
    lines.push(
      `group ${group.groupId}: ${group.reason}; signal ${group.signalDisposition}; signals sent ${group.signalsSent}`,
      `expected session ${group.sessionId ?? "unreadable"}; spawn leader start ticks ${group.spawnLeader?.startTimeTicks ?? "unreadable"}`,
    );

    for (const member of group.currentMembers)
      lines.push(
        `PID ${member.pid}, parent ${member.parentPid}, group ${member.groupId}, session ${member.sessionId}, start ticks ${member.startTimeTicks}, state ${member.state}`,
      );

    if (group.currentMembers.length === 0)
      lines.push("No readable current group members.");

    for (const error of group.errors)
      lines.push(`Identity unavailable: ${error}`);
  }

  lines.push(
    `workspace ${cleanup.workspace.state}: ${cleanup.workspace.path ?? "none"}`,
    `lock ${cleanup.lock.state}: ${cleanup.lock.path ?? "none"}`,
  );

  return lines.join("\n");
}

export type Side = "base" | "candidate" | "tree";

export type TreeInfo = {
  side: Side;
  source: string;
  sha: string;
  snapshotTree: string;
};

export type TestResult = {
  id: string;
  name: string;
  className: string;
  seconds: number;
  status: "passed" | "failed" | "skipped";
  messages: string[];
};

export type Measurement = {
  side: Side;
  iteration: number;
  load: LoadAverage;
  exitCode: number;
  fileSeconds: number;
  wallSeconds: number;
  startedAt: string;
  command: string[];
  workersReaped: boolean;
  tests: TestResult[];
  log: string;
  junit: string;
};

function entity(text: string): string {
  return text.replace(/&([^;]*);/g, (_, name: string) => {
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };

    if (named[name] !== undefined) return named[name];

    if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(name)) {
      const value = /^#x/i.test(name)
        ? Number.parseInt(name.slice(2), 16)
        : Number(name.slice(1));

      if (
        value > 0 &&
        value <= 0x10_ff_ff &&
        !(value >= 0xd8_00 && value <= 0xdf_ff)
      )
        return String.fromCodePoint(value);
    }

    throw new Error("Unsupported JUnit XML entity");
  });
}

function parseXml(text: string): Xml {
  if (text.length > 32 * 1024 * 1024)
    throw new Error("JUnit report exceeds 32 MiB");
  const root: Xml = { tag: "document", attributes: {}, children: [], text: "" };
  const stack = [root];
  let index = 0;

  while (index < text.length) {
    const current = stack.at(-1);

    if (!current) throw new Error("Invalid JUnit XML nesting");

    const special = [
      ["<!--", "-->", false],
      ["<?", "?>", false],
      ["<![CDATA[", "]]>", true],
    ] as const;

    const match = special.find(([open]) => text.startsWith(open, index));

    if (match) {
      const end = text.indexOf(match[1], index + match[0].length);

      if (end === -1) throw new Error("Unclosed JUnit XML section");

      if (match[2]) current.text += text.slice(index + match[0].length, end);
      index = end + match[1].length;
    } else if (text[index] === "<") {
      if (text.startsWith("<!", index))
        throw new Error("JUnit DTDs are not allowed");
      let end = index + 1;
      let quote = "";

      for (; end < text.length; end++) {
        const char = text[end];

        if (quote) {
          if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === ">") break;
      }

      if (end === text.length) throw new Error("Unclosed JUnit XML tag");
      const tag = text.slice(index + 1, end).trim();

      if (tag.startsWith("/")) {
        if (stack.length < 2 || current.tag !== tag.slice(1).trim())
          throw new Error("Mismatched JUnit XML tag");
        stack.pop();
      } else {
        const name = /^[\w:.-]+/.exec(tag)?.[0];

        if (!name) throw new Error("Invalid JUnit XML tag");
        const node: Xml = { tag: name, attributes: {}, children: [], text: "" };
        const selfClosing = tag.endsWith("/");

        let attributes = tag
          .slice(name.length, selfClosing ? -1 : undefined)
          .trim();

        while (attributes) {
          const attr = /^([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2\s*/.exec(
            attributes,
          );

          if (!attr?.[1] || attr[3] === undefined)
            throw new Error("Invalid JUnit XML attribute");

          if (Object.hasOwn(node.attributes, attr[1]))
            throw new Error("Duplicate JUnit XML attribute");
          node.attributes[attr[1]] = entity(attr[3]);
          attributes = attributes.slice(attr[0].length);
        }

        current.children.push(node);

        if (!selfClosing) stack.push(node);
      }

      index = end + 1;
    } else {
      const end = text.indexOf("<", index);
      current.text += entity(text.slice(index, end === -1 ? undefined : end));
      index = end === -1 ? text.length : end;
    }
  }

  if (stack.length !== 1 || root.children.length !== 1)
    throw new Error("Incomplete JUnit XML");
  const document = root.children[0];

  if (!document) throw new Error("Empty JUnit report");

  return document;
}

function descendants(node: Xml, tag: string): Xml[] {
  return [
    ...(node.tag === tag ? [node] : []),
    ...node.children.flatMap((child) => descendants(child, tag)),
  ];
}

function seconds(value: string | undefined): number {
  if (!value?.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)
    throw new Error("Missing or invalid JUnit duration");

  return Number(value);
}

function fullText(node: Xml): string {
  return node.text + node.children.map(fullText).join("");
}

export function parseJUnit(text: string) {
  const document = parseXml(text);

  if (!["testsuites", "testsuite"].includes(document.tag))
    throw new Error("Not a JUnit report");
  const suites = descendants(document, "testsuite");

  if (suites.length !== 1)
    throw new Error("Expected one test file in JUnit report");
  const suite = suites[0];

  if (!suite) throw new Error("Missing JUnit test suite");
  const seen = new Map<string, number>();

  const tests: TestResult[] = descendants(suite, "testcase").map((node) => {
    const name = node.attributes["name"];

    if (!name) throw new Error("JUnit testcase has no name");
    const className = node.attributes["classname"] ?? "";
    const key = JSON.stringify([className, name]);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    const failures = node.children.filter((child) =>
      ["failure", "error"].includes(child.tag),
    );

    return {
      id: JSON.stringify([className, name, occurrence]),
      name,
      className,
      seconds: seconds(node.attributes["time"]),
      status:
        failures.length > 0
          ? "failed"
          : node.children.some((child) => child.tag === "skipped")
            ? "skipped"
            : "passed",
      messages: failures.map((failure) =>
        [failure.attributes["message"], fullText(failure)]
          .filter(Boolean)
          .join("\n"),
      ),
    };
  });

  if (tests.length === 0 || Number(suite.attributes["tests"]) !== tests.length)
    throw new Error("Incomplete JUnit testcase list");

  return { fileSeconds: seconds(suite.attributes["time"]), tests };
}

export function statistics(values: number[]) {
  const sorted = [...values].toSorted((a, b) => a - b);

  if (sorted.length === 0)
    return { samples: 0, median: null, p95: null, max: null };
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[Math.ceil(sorted.length / 2) - 1];
  const upper = sorted[mid];

  if (lower === undefined || upper === undefined)
    throw new Error("Invalid duration sample");

  return {
    samples: sorted.length,
    median: (lower + upper) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

export const verdictRule =
  "Compare failed file runs only: candidate more / same / fewer than base; if neither fails, none failed. This is not statistical significance.";

export function verdict(runs: Measurement[], complete = true): string {
  if (!complete) return "Incomplete measurement; no comparison verdict.";

  const failed = (side: Side) =>
    runs.filter((run) => run.side === side && run.exitCode !== 0).length;

  if (runs.some((run) => run.side === "tree"))
    return `Single tree failed ${failed("tree")} of ${runs.length} runs; no comparison.`;

  const base = failed("base");
  const candidate = failed("candidate");

  if (!base && !candidate) return "None failed; no observed difference.";

  return `Candidate failed ${candidate > base ? "more runs than" : candidate < base ? "fewer runs than" : "the same number of runs as"} base (${candidate} vs ${base}).`;
}

const cell = (text: string) =>
  text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");

export function renderSummary(
  trees: TreeInfo[],
  runs: Measurement[],
  loadMode: string,
  complete: boolean,
  cleanup?: CleanupReport,
): string {
  const lines = [
    "# Repeated test comparison",
    "",
    verdict(runs, complete),
    "",
    `Rule: ${verdictRule}`,
    `Load mode: ${loadMode}. No cause or statistical significance is established.`,
    "",
    "| Tree | Failed runs / completed runs | Source | Commit SHA | Snapshot tree |",
    "| --- | ---: | --- | --- | --- |",
  ];

  const loadLines: string[] = [];

  for (const tree of trees) {
    const selected = runs.filter((run) => run.side === tree.side);
    lines.push(
      `| ${tree.side} | ${selected.filter((run) => run.exitCode !== 0).length} / ${selected.length} | ${cell(tree.source)} | ${tree.sha} | ${tree.snapshotTree} |`,
    );

    const loads = selected.flatMap((run) =>
      run.load === "unavailable" ? [] : [run.load],
    );

    const range = [0, 1, 2].map((index) => {
      const values = loads.flatMap((load) =>
        load[index] === undefined ? [] : [load[index]],
      );

      return values.length > 0
        ? `${Math.min(...values).toFixed(2)}–${Math.max(...values).toFixed(2)}`
        : "unavailable";
    });

    loadLines.push(
      `${tree.side} start load range (1/5/15 min): ${range.join(" / ")}; ${selected.length - loads.length} unavailable.`,
    );
  }

  lines.push("", ...loadLines);

  if (cleanup)
    lines.push("", "## Cleanup", "", "```text", cleanupMessage(cleanup), "```");
  lines.push(
    "",
    "Durations are seconds from JUnit. Median averages middle values; p95 uses nearest rank.",
    "",
    "| Tree | Test | Samples | Median | p95 | Maximum |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );

  for (const tree of trees) {
    const tests = new Map<string, { name: string; durations: number[] }>();

    for (const run of runs.filter((row) => row.side === tree.side)) {
      for (const test of run.tests) {
        const row = tests.get(test.id) ?? {
          name: [test.className, test.name].filter(Boolean).join(" / "),
          durations: [],
        };

        row.durations.push(test.seconds);
        tests.set(test.id, row);
      }
    }

    for (const row of tests.values()) {
      const stats = statistics(row.durations);
      lines.push(
        `| ${tree.side} | ${cell(row.name)} | ${stats.samples} | ${stats.median?.toFixed(6)} | ${stats.p95?.toFixed(6)} | ${stats.max?.toFixed(6)} |`,
      );
    }
  }

  lines.push(
    "",
    "Full failure messages, per-run load and file durations are in results.json. Raw logs and JUnit files are retained.",
    "",
  );

  return lines.join("\n");
}
