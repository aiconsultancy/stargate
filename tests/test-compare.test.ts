import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  parseJUnit,
  statistics,
  verdict,
} from "../scripts/test-compare-report";
import {
  admitPID,
  compare,
  parseOptions,
  pidMaximum,
  signalGroup,
} from "../scripts/test-compare";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const outputs: Promise<string>[] = [];
const script = join(import.meta.dir, "../scripts/test-compare.ts");

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }

    await child.exited;
  }

  await Promise.all(outputs.splice(0));

  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr);
  }

  return result.stdout.trim();
}

function fixtureState(path: string): string {
  const root = dirname(path);
  const pids = new Set<string>();

  const files = Object.fromEntries(
    [
      "worker.ready",
      "worker.ready.tmp",
      "counter.ready",
      "pids.json",
      "driver.pid",
      "workspace",
      "exit.json",
      "driver.stdout",
      "driver.stderr",
      "result/results.json",
    ].map((name) => {
      try {
        const text = readFileSync(join(root, name), "utf8");

        if (
          ["worker.ready", "counter.ready", "pids.json", "driver.pid"].includes(
            name,
          )
        ) {
          for (const pid of text.match(/\d+/g) ?? []) {
            pids.add(pid);
          }
        }

        return [name, text];
      } catch (error) {
        return [name, String(error)];
      }
    }),
  );

  const processes = Object.fromEntries(
    [...pids].map((text) => {
      try {
        const pid = admitPID(Number(text));

        return [text, readFileSync(`/proc/${pid}/stat`, "utf8")];
      } catch (error) {
        return [text, String(error)];
      }
    }),
  );

  return JSON.stringify({
    path,
    at: new Date().toISOString(),
    files,
    processes,
  });
}

async function captureOutput(stream: ReadableStream<Uint8Array>, path: string) {
  await writeFile(path, "");
  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of stream) {
    const part = decoder.decode(chunk, { stream: true });
    text += part;
    await appendFile(path, part);
  }

  const last = decoder.decode();
  await appendFile(path, last);

  return text + last;
}

async function waitForFile(
  path: string,
  schedule = (expire: () => void) => {
    const timer = setTimeout(expire, 10_000);

    return () => clearTimeout(timer);
  },
) {
  let watcher: FSWatcher | undefined;
  let cancel: (() => void) | undefined;

  try {
    return await new Promise<string>((resolve, reject) => {
      const read = () => {
        void readFile(path, "utf8").then(resolve, (error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          ) {
            reject(error);
          }
        });
      };

      // Subscribe before reading so publication between the two cannot be lost.
      watcher = watch(dirname(path), (_event, name) => {
        if (name === null || name === basename(path)) {
          read();
        }
      });
      watcher.once("error", reject);
      cancel = schedule(() =>
        reject(
          new Error(
            `Readiness event outer limit (10000 ms): ${fixtureState(path)}`,
          ),
        ),
      );
      read();
    });
  } finally {
    watcher?.close();
    cancel?.();
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function workerPID(text: string): number {
  try {
    if (!/^\d+$/.test(text)) {
      throw new Error("PID is not decimal");
    }

    return admitPID(Number(text));
  } catch {
    throw new Error(
      `fixture published no PID: expected integer 2..${pidMaximum}`,
    );
  }
}

test("fixture readiness refuses values that publish no positive integer PID", () => {
  for (const text of ["", " ", "0", "NaN", "-1", "1.5", "Infinity"]) {
    expect(() => workerPID(text)).toThrow("fixture published no PID");
  }

  expect(workerPID("123")).toBe(123);
});

test("PID admission bounds every signal dispatch and fixture readiness", () => {
  const kill = spyOn(process, "kill").mockImplementation(() => true);

  try {
    for (const pid of [
      0,
      1,
      -1,
      -5,
      1.5,
      NaN,
      Infinity,
      pidMaximum + 1,
      2_147_483_647,
      2_147_483_648,
      4_294_967_297,
      2 ** 53,
    ]) {
      expect(() => signalGroup(pid, 0)).toThrow(
        "Invalid owned process-group ID",
      );
      expect(() => signalGroup(pid, "SIGKILL")).toThrow(
        "Invalid owned process-group ID",
      );
      expect(() => workerPID(String(pid))).toThrow("fixture published no PID");
      expect(kill).toHaveBeenCalledTimes(0);
    }

    for (const pid of [2, pidMaximum]) {
      expect(workerPID(String(pid))).toBe(pid);
      expect(signalGroup(pid, 0)).toBe(true);
      expect(kill).toHaveBeenLastCalledWith(-pid, 0);
      expect(signalGroup(pid, "SIGKILL")).toBe(true);
      expect(kill).toHaveBeenLastCalledWith(-pid, "SIGKILL");
    }
  } finally {
    kill.mockRestore();
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "compare-test-"));
  roots.push(root);

  const repo = join(root, "repo"),
    temporary = join(root, "tmp"),
    output = join(root, "result");

  await mkdir(join(repo, "tests"), { recursive: true });
  await mkdir(temporary);
  await writeFile(
    join(repo, "tests/x.test.ts"),
    'export const value = "base";\n',
  );
  git(repo, "init", "-b", "fixture");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  await writeFile(
    join(repo, "tests/x.test.ts"),
    'export const value = "candidate";\n',
  );
  const fake = join(root, "fake.mjs");
  await writeFile(
    fake,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [junit, side, counter, mode] = process.argv.slice(2);
const previous = existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
const n = previous.filter(row => row.side === side).length + 1;
appendFileSync(counter, JSON.stringify({ side, n, source: readFileSync("tests/x.test.ts", "utf8") }) + "\\n");
writeFileSync("tests/x.test.ts", "changed only in the clone");
if (existsSync("node_modules/dep/index.js")) {
  await import("file://" + process.cwd() + "/node_modules/dep/index.js");
  writeFileSync("node_modules/dep/data.txt", "private dependency change");
}
if (existsSync("node_modules/link/data.txt")) writeFileSync("node_modules/link/data.txt", "private linked dependency change");
if (mode === "hold") {
  writeFileSync(counter + ".ready", String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const failed = side === "candidate" && n % 2 === 0;
  writeFileSync(junit, mode === "broken" ? "<bad/>" : '<testsuites><testsuite tests="2" time="' + (n + 2) + '"><testcase name="fast &amp; ordinary" time="' + n + '">' +
    (failed ? '<failure message="expected &lt;value&gt;"><![CDATA[full stack\\nline 2]]></failure>' : '') +
    '</testcase><testcase name="slow" time="' + (n * 2) + '"/></testsuite></testsuites>');
  process.exitCode = failed ? 1 : 0;
}
`,
  );
  const worker = join(root, "worker.mjs");
  await writeFile(
    worker,
    'import { writeFileSync, renameSync } from "node:fs"; writeFileSync(process.argv[2] + ".tmp", String(process.pid)); renameSync(process.argv[2] + ".tmp", process.argv[2]); setInterval(() => {}, 1000);\n',
  );

  async function launch(
    extra: string[] = [],
    mode = "normal",
    load = "[1,2,3]",
    single = false,
    cleanupProbe?:
      | "release"
      | "stuck"
      | "foreign-start"
      | "foreign-session"
      | "unreadable",
  ) {
    const driver = join(root, "driver.mjs");

    const args = [
      "--file",
      "tests/x.test.ts",
      ...(single ? [] : ["--base", "HEAD"]),
      "--candidate",
      repo,
      "--runs",
      "2",
      "--output",
      output,
      ...extra,
    ];

    await writeFile(
      driver,
      `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { compare, parseOptions } from ${JSON.stringify(script)};
let workerPID, firstWorker;
const nativeKill=process.kill.bind(process);
process.kill=(pid,signal)=>{
  if(signal==="SIGKILL")appendFileSync(${JSON.stringify(join(root, "signals.jsonl"))},JSON.stringify({groupId:-pid})+"\\n");
  return nativeKill(pid,signal);
};
const result = await compare(parseOptions(${JSON.stringify(args)}, ${JSON.stringify(repo)}), {
  load: async () => ${load},
  command: ({junit, side}) => [${JSON.stringify(process.execPath)}, ${JSON.stringify(fake)}, junit, side, ${JSON.stringify(join(root, "counter"))}, ${JSON.stringify(mode)}],
  workers: () => [[${JSON.stringify(process.execPath)}, ${JSON.stringify(worker)}, ${JSON.stringify(join(root, "worker.ready"))}]],
  workersStarted: pids => { workerPID=pids[0]; appendFileSync(${JSON.stringify(join(root, "pids.json"))}, JSON.stringify(pids) + "\\n"); },
  groupSnapshot:(pid,native)=>{
    const snapshot=native();
    if(pid!==workerPID)return snapshot;
    if(snapshot.members.length){firstWorker??=snapshot.members.find(member=>member.pid===pid);return snapshot;}
    const probe=${JSON.stringify(cleanupProbe ?? "")};
    if(probe==="unreadable")return {members:[],errors:["identity unreadable for group "+pid]};
    if(["foreign-start","foreign-session","stuck"].includes(probe)){
      const member={...firstWorker,state:"S"};
      if(probe==="foreign-start")member.startTimeTicks=String(BigInt(member.startTimeTicks)+1n);
      if(probe==="foreign-session")member.sessionId++;
      writeFileSync(${JSON.stringify(join(root, "ownership.json"))},JSON.stringify({original:firstWorker,current:member}));
      return {members:[member],errors:[]};
    }
    return snapshot;
  },
  ${
    cleanupProbe
      ? `groupExists: pid => {
    try { process.kill(-pid,0); return true; }
    catch(error) { if(error.code!=="ESRCH")throw error; }
    if(pid===workerPID && (${JSON.stringify(cleanupProbe)}==="stuck" || !existsSync(${JSON.stringify(join(root, "cleanup.release"))}))) {
      writeFileSync(${JSON.stringify(join(root, "cleanup.ready"))},String(pid)); return true;
    }
    return false;
  },`
      : ""
  }
  workspace: path => writeFileSync(${JSON.stringify(join(root, "workspace"))}, path),
});
writeFileSync(${JSON.stringify(join(root, "exit.json"))}, JSON.stringify(result));
process.exitCode = result.code;
`,
    );

    const child = Bun.spawn([process.execPath, driver], {
      cwd: repo,
      env: {
        ...process.env,
        STARGATE_TEST_COMPARE_LOCK: "",
        TMPDIR: temporary,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    children.push(child);
    await writeFile(join(root, "driver.pid"), String(child.pid));

    const stdout = captureOutput(child.stdout, join(root, "driver.stdout")),
      stderr = captureOutput(child.stderr, join(root, "driver.stderr"));

    outputs.push(stdout, stderr);

    return { child, stdout, stderr };
  }

  return { root, repo, temporary, output, launch };
}

test("readiness reads existing files and observes atomic publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "compare-test-"));
  roots.push(root);
  const ready = join(root, "worker.ready");
  await writeFile(ready, "existing");
  expect(await waitForFile(ready)).toBe("existing");
  await rm(ready);
  const waiting = waitForFile(ready);
  await writeFile(ready + ".tmp", "published");
  await rename(ready + ".tmp", ready);
  expect(await waiting).toBe("published");
});

test("readiness outer limit reports the fixture state without another poll", async () => {
  const root = await mkdtemp(join(tmpdir(), "compare-test-"));
  roots.push(root);
  const ready = join(root, "worker.ready");
  await writeFile(ready + ".tmp", "not-renamed");
  let expire: (() => void) | undefined;

  const waiting = waitForFile(ready, (callback) => {
    expire = callback;

    return () => {};
  });

  if (!expire) {
    throw new Error("Outer limit not registered");
  }

  expire();
  await expect(waiting).rejects.toThrow("not-renamed");
});

test("duration statistics use the median and nearest-rank p95", () => {
  expect(statistics([9, 1, 5, 3])).toEqual({
    samples: 4,
    median: 4,
    p95: 9,
    max: 9,
  });
  expect(
    statistics(Array.from({ length: 20 }, (_, index) => index + 1)),
  ).toEqual({
    samples: 20,
    median: 10.5,
    p95: 19,
    max: 20,
  });
});

test("JUnit retains escaped names, complete failure messages and skipped tests", () => {
  const parsed = parseJUnit(
    '<testsuites><testsuite tests="2" time="3.5"><testcase name="a &amp; b" time="1"><failure message="x &lt; y"><![CDATA[stack <raw>\nline 2]]></failure></testcase><testcase name="skipped" time="0"><skipped/></testcase></testsuite></testsuites>',
  );

  expect(parsed.fileSeconds).toBe(3.5);
  expect(parsed.tests[0]).toMatchObject({
    name: "a & b",
    status: "failed",
    messages: ["x < y\nstack <raw>\nline 2"],
  });
  expect(parsed.tests[1]?.status).toBe("skipped");
  expect(() =>
    parseJUnit('<!DOCTYPE x SYSTEM "file:///private"><testsuites/>'),
  ).toThrow("DTDs");
  expect(() =>
    parseJUnit('<testsuites><testsuite tests="1" time="1"></testsuites>'),
  ).toThrow();
});

test("arguments reject traversal and a comparison exit rule without a base", () => {
  expect(() => parseOptions(["--file", "../x.test.ts"])).toThrow();
  expect(() =>
    parseOptions(["--file", "x.test.ts", "--runs", "NaN"]),
  ).toThrow();
  expect(() =>
    parseOptions(["--file", "x.test.ts", "--fail-if-candidate-worse"]),
  ).toThrow();
  expect(parseOptions(["--file", "x.test.ts", "--runs", "3"]).runs).toBe(3);
});

test("interleaved fake runs reset private snapshots and measure failures without gating", async () => {
  const f = await fixture();
  const run = await f.launch();
  expect(await run.child.exited).toBe(0);
  const stdout = await run.stdout;
  expect(await run.stderr).toBe("");
  expect(stdout.indexOf("Rule before run 1")).toBeLessThan(
    stdout.indexOf("base 1/2 start load"),
  );

  const rows = (await readFile(join(f.root, "counter"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(rows.map((row) => row.side)).toEqual([
    "base",
    "candidate",
    "base",
    "candidate",
  ]);
  expect(rows.map((row) => row.source)).toEqual([
    'export const value = "base";\n',
    'export const value = "candidate";\n',
    'export const value = "base";\n',
    'export const value = "candidate";\n',
  ]);
  expect(await readFile(join(f.repo, "tests/x.test.ts"), "utf8")).toBe(
    'export const value = "candidate";\n',
  );

  const result = JSON.parse(
    await readFile(join(f.output, "results.json"), "utf8"),
  );

  expect(result.runs.map((row: { exitCode: number }) => row.exitCode)).toEqual([
    0, 0, 0, 1,
  ]);
  expect(result.runs[3].tests[0].messages).toEqual([
    "expected <value>\nfull stack\nline 2",
  ]);
  expect(result.runs[0].load).toEqual([1, 2, 3]);
  expect(result.runs[0].fileSeconds).toBe(3);
  const equal = structuredClone(result.runs);
  equal[0].exitCode = 1;
  expect(verdict(equal)).toContain("the same number of runs as base (1 vs 1)");
  equal[2].exitCode = 1;
  expect(verdict(equal)).toContain("fewer runs than base (1 vs 2)");
  expect(result.trees[0].sha).toBe(git(f.repo, "rev-parse", "HEAD"));
  expect(result.trees[0].snapshotTree).not.toBe(result.trees[1].snapshotTree);
  const summary = await readFile(join(f.output, "summary.md"), "utf8");
  expect(summary).toContain("Candidate failed more runs than base (1 vs 0)");
  expect(summary).toContain("| candidate | 1 / 2 |");
  expect(summary).toContain(
    "| candidate | fast & ordinary | 2 | 1.500000 | 2.000000 | 2.000000 |",
  );
  expect(await readdir(f.temporary)).toEqual([]);
}, 15_000);

test("the opt-in exit rule gates only a completed worse comparison", async () => {
  const f = await fixture();
  const run = await f.launch(["--fail-if-candidate-worse"]);
  expect(await run.child.exited).toBe(1);
  expect(await readdir(f.temporary)).toEqual([]);
}, 15_000);

test("single-tree mode accepts unavailable load and copies dependencies away from the source", async () => {
  const f = await fixture();
  await writeFile(join(f.repo, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(f.repo, "bun.lock"), "fixture-lock\n");
  git(f.repo, "add", "package.json", "bun.lock");
  await mkdir(join(f.repo, "node_modules/dep"), { recursive: true });
  await mkdir(join(f.repo, "node_modules/sibling"));
  await writeFile(
    join(f.repo, "node_modules/dep/package.json"),
    '{"name":"dep","type":"module","main":"index.js"}\n',
  );
  await writeFile(
    join(f.repo, "node_modules/dep/index.js"),
    'export { value } from "sibling";\n',
  );
  await writeFile(
    join(f.repo, "node_modules/sibling/package.json"),
    '{"name":"sibling","type":"module","main":"index.js"}\n',
  );
  await writeFile(
    join(f.repo, "node_modules/sibling/index.js"),
    "export const value = 1;\n",
  );
  await writeFile(
    join(f.repo, "node_modules/dep/data.txt"),
    "unchanged dependency",
  );
  await symlink(
    join(f.repo, "node_modules/dep"),
    join(f.repo, "node_modules/link"),
  );
  const index = await readFile(join(f.repo, ".git/index"));
  const run = await f.launch([], "normal", '"unavailable"', true);
  expect(await run.child.exited).toBe(0);

  const result = JSON.parse(
    await readFile(join(f.output, "results.json"), "utf8"),
  );

  expect(result.runs.map((row: { load: string }) => row.load)).toEqual([
    "unavailable",
    "unavailable",
  ]);
  expect(
    await readFile(join(f.repo, "node_modules/dep/data.txt"), "utf8"),
  ).toBe("unchanged dependency");
  expect(await readFile(join(f.repo, ".git/index"))).toEqual(index);
  expect(await readFile(join(f.output, "summary.md"), "utf8")).toContain(
    "Single tree failed 0 of 2 runs",
  );
  expect(await readdir(f.temporary)).toEqual([]);
}, 15_000);

test("unsafe or nonempty output paths do not change any existing tree or report", async () => {
  const f = await fixture();
  const inTree = join(f.repo, "new-output");

  const first = await compare(
    parseOptions(["--file", "tests/x.test.ts", "--output", inTree], f.repo),
  );

  expect(first.code).toBe(2);
  expect(await readdir(f.repo)).not.toContain("new-output");

  const lock = await compare(
    parseOptions(
      ["--file", "tests/x.test.ts", "--lock", join(f.repo, "new.lock")],
      f.repo,
    ),
  );

  expect(lock.code).toBe(2);
  expect(await readdir(f.repo)).not.toContain("new.lock");
  await mkdir(f.output);
  await writeFile(join(f.output, "results.json"), "retain me");

  const second = await compare(
    parseOptions(["--file", "tests/x.test.ts", "--output", f.output], f.repo),
  );

  expect(second.code).toBe(2);
  expect(await readFile(join(f.output, "results.json"), "utf8")).toBe(
    "retain me",
  );
});

test("worker readiness publishes a complete PID atomically", async () => {
  const f = await fixture();
  const fifo = join(f.root, "publish.fifo");
  const opened = join(f.root, "publish.opened");
  const ready = join(f.root, "worker.ready");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  const worker = join(f.root, "worker.mjs");
  const source = await readFile(worker, "utf8");
  await writeFile(
    worker,
    `import { openSync, readSync, writeSync, closeSync, renameSync, writeFileSync as directWrite } from "node:fs";
function writeFileSync(path, value) {
  const fd = openSync(path, "w");
  directWrite(${JSON.stringify(opened)}, "opened");
  const pipe = openSync(${JSON.stringify(fifo)}, "r");
  readSync(pipe, new Uint8Array(1)); closeSync(pipe);
  writeSync(fd, value); closeSync(fd);
}
${source.slice(source.indexOf(";") + 1)}`,
  );
  const run = await f.launch(["--load", "synthetic"], "hold");

  try {
    await waitForFile(opened);
    await expect(readFile(ready, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await writeFile(fifo, "release");
  }

  const pid = workerPID(await waitForFile(ready));

  const pids: number[] = JSON.parse(
    (await readFile(join(f.root, "pids.json"), "utf8")).trim(),
  );

  expect(pids).toEqual([pid]);
  expect(pid).toBeGreaterThan(0);
  expect(alive(pid)).toBe(true);
  run.child.kill("SIGTERM");
  expect(await run.child.exited).toBe(143);
  expect(alive(pid)).toBe(false);
}, 15_000);

test("a normal synthetic run reaps every trivial worker", async () => {
  const f = await fixture();
  const run = await f.launch(["--load", "synthetic"]);
  expect(await run.child.exited).toBe(0);

  const pids: number[] = (await readFile(join(f.root, "pids.json"), "utf8"))
    .trim()
    .split("\n")
    .flatMap((line) => JSON.parse(line));

  expect(pids.length).toBe(4);
  expect(pids.some(alive)).toBe(false);
  expect(await readdir(f.temporary)).toEqual([]);
}, 15_000);

test("an early load-worker exit stops a held test and fails as infrastructure", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "worker.mjs"), "process.exit(0);\n");
  const run = await f.launch(["--load", "synthetic"], "hold");
  expect(await run.child.exited).toBe(2);
  expect(
    JSON.parse(await readFile(join(f.output, "results.json"), "utf8")).error,
  ).toContain("load worker exited");
  expect(await readdir(f.temporary)).toEqual([]);
}, 15_000);

test("infrastructure errors and high synthetic admission load stop measurement", async () => {
  const broken = await fixture();
  const first = await broken.launch([], "broken");
  expect(await first.child.exited).toBe(2);
  expect(await readdir(broken.temporary)).toEqual([]);
  const busy = await fixture();

  const second = await busy.launch(
    ["--load", "synthetic", "--max-load", "2"],
    "normal",
    "[3,2,1]",
  );

  expect(await second.child.exited).toBe(2);
  expect(
    JSON.parse(await readFile(join(busy.output, "results.json"), "utf8")).error,
  ).toContain("use --load ambient");
  expect(await readdir(busy.temporary)).toEqual([]);
}, 15_000);

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s reaps trivial load workers before releasing the lock and removes private trees",
  async (signal) => {
    const f = await fixture();
    const lock = join(f.root, "lane.lock");
    const run = await f.launch(["--load", "synthetic", "--lock", lock], "hold");
    const pid = workerPID(await waitForFile(join(f.root, "worker.ready")));
    await waitForFile(join(f.root, "counter.ready"));
    expect(alive(pid)).toBe(true);
    expect(spawnSync("flock", ["--nonblock", lock, "true"]).status).toBe(1);
    run.child.kill(signal);
    expect(await run.child.exited).toBe(signal === "SIGINT" ? 130 : 143);
    expect(alive(pid)).toBe(false);
    expect(spawnSync("flock", ["--nonblock", lock, "true"]).status).toBe(0);
    expect(await readdir(f.temporary)).toEqual([]);

    const result = JSON.parse(
      await readFile(join(f.output, "results.json"), "utf8"),
    );

    expect(result.complete).toBe(false);
    expect(result.incompleteRun.load).toEqual([1, 2, 3]);
    expect(await readFile(join(f.repo, "tests/x.test.ts"), "utf8")).toBe(
      'export const value = "candidate";\n',
    );
  },
  15_000,
);

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s waits for process-group absence before releasing the lock",
  async (signal) => {
    const f = await fixture();
    const lock = join(f.root, "lane.lock");

    const run = await f.launch(
      ["--load", "synthetic", "--lock", lock],
      "hold",
      "[1,2,3]",
      false,
      "release",
    );

    const pid = workerPID(await waitForFile(join(f.root, "worker.ready")));
    await waitForFile(join(f.root, "counter.ready"));
    run.child.kill(signal);
    await waitForFile(join(f.root, "cleanup.ready"));
    expect(alive(pid)).toBe(false);
    expect(run.child.exitCode).toBe(null);
    expect(spawnSync("flock", ["--nonblock", lock, "true"]).status).toBe(1);
    await writeFile(join(f.root, "cleanup.release"), "release\n");
    expect(await run.child.exited).toBe(signal === "SIGINT" ? 130 : 143);
    expect(spawnSync("flock", ["--nonblock", lock, "true"]).status).toBe(0);
    expect(await readdir(f.temporary)).toEqual([]);
  },
  15_000,
);

test("normal synthetic cleanup waits for process-group absence", async () => {
  const f = await fixture();

  const run = await f.launch(
    ["--load", "synthetic"],
    "normal",
    "[1,2,3]",
    false,
    "release",
  );

  await waitForFile(join(f.root, "cleanup.ready"));
  expect(run.child.exitCode).toBe(null);
  await writeFile(join(f.root, "cleanup.release"), "release\n");
  expect(await run.child.exited).toBe(0);
  expect(await readdir(f.temporary)).toEqual([]);
}, 15_000);

test("SIGTERM cleanup deadline is an infrastructure error, not a signal exit", async () => {
  const f = await fixture();

  const run = await f.launch(
    ["--load", "synthetic"],
    "hold",
    "[1,2,3]",
    false,
    "stuck",
  );

  await waitForFile(join(f.root, "counter.ready"));
  run.child.kill("SIGTERM");
  await waitForFile(join(f.root, "cleanup.ready"));
  expect(await run.child.exited).toBe(2);
  const result = JSON.parse(await readFile(join(f.root, "exit.json"), "utf8"));
  expect(result.error).toContain("cleanup deadline");
  expect(result.verdict).toContain("Incomplete");
  const pid = workerPID(await readFile(join(f.root, "worker.ready"), "utf8"));
  const workspace = await readFile(join(f.root, "workspace"), "utf8");
  expect(result.error).toContain(`group ${pid}`);
  expect(result.error).toContain(workspace);
  expect(result.cleanup.workspace).toEqual({
    path: workspace,
    state: "retained",
  });

  const group = result.cleanup.groups.find(
    (value: { groupId: number }) => value.groupId === pid,
  );

  expect(group.currentMembers[0]).toMatchObject({ pid, groupId: pid });
  expect(group.currentMembers[0].startTimeTicks).toMatch(/^\d+$/);
  expect(result.error).toContain(group.currentMembers[0].startTimeTicks);

  const recorded = JSON.parse(
    await readFile(join(f.output, "results.json"), "utf8"),
  );

  expect(recorded.cleanup).toEqual(result.cleanup);
  const summary = await readFile(join(f.output, "summary.md"), "utf8");
  expect(summary).toContain(`group ${pid}`);
  expect(summary).toContain(group.currentMembers[0].startTimeTicks);
  expect(summary).toContain(workspace);
}, 15_000);

test.each(["foreign-start", "foreign-session", "unreadable"] as const)(
  "%s ownership: no repeated signal and actionable cleanup facts",
  async (probe) => {
    const f = await fixture();
    const lock = join(f.root, "lane.lock");

    const run = await f.launch(
      ["--load", "synthetic", "--lock", lock],
      "hold",
      "[1,2,3]",
      false,
      probe,
    );

    const pid = workerPID(await waitForFile(join(f.root, "worker.ready")));
    await waitForFile(join(f.root, "counter.ready"));
    run.child.kill("SIGTERM");
    expect(await run.child.exited).toBe(2);

    const signals = (await readFile(join(f.root, "signals.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(signals.filter((row) => row.groupId === pid)).toHaveLength(1);

    const result = JSON.parse(
      await readFile(join(f.root, "exit.json"), "utf8"),
    );

    const workspace = await readFile(join(f.root, "workspace"), "utf8");

    const group = result.cleanup.groups.find(
      (row: { groupId: number }) => row.groupId === pid,
    );

    expect(group.signalDisposition).toBe("withheld");
    expect(group.reason).toContain("ownership not proven");
    expect(result.cleanup.workspace).toEqual({
      path: workspace,
      state: "retained",
    });
    expect(result.cleanup.lock).toEqual({ path: lock, state: "released" });
    expect(result.error).toContain(`group ${pid}`);
    expect(result.error).toContain(workspace);
    expect(result.error).toContain(lock);

    if (probe !== "unreadable") {
      const identities = JSON.parse(
        await readFile(join(f.root, "ownership.json"), "utf8"),
      );

      expect(group.currentMembers).toEqual([identities.current]);
      expect(result.error).toContain(identities.current.startTimeTicks);
    } else {
      expect(group.errors).toContain(`identity unreadable for group ${pid}`);
    }

    const recorded = JSON.parse(
      await readFile(join(f.output, "results.json"), "utf8"),
    );

    expect(recorded.cleanup).toEqual(result.cleanup);
    const summary = await readFile(join(f.output, "summary.md"), "utf8");
    expect(summary).toContain(`group ${pid}`);
    expect(summary).toContain(workspace);
    expect(summary).toContain("released");
    expect(summary).toContain(lock);
  },
  15_000,
);
