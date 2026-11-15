import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootTicks,
  type ProcessTable,
  signalTurnGroup,
  signalTurnProcesses,
  statStart,
  turnProcesses,
} from "../src/backends/cli-agent";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

test("a process whose identity changed is never signalled", async () => {
  // A fake /proc: PID reuse is simulated by changing the files of a PID.
  const root = await mkdtemp(join(tmpdir(), "stargate-claude-proc-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const turn = crypto.randomUUID();
  const marker = { variable: "STARGATE_TEST_TURN", value: turn };
  const id = crypto.randomUUID();
  type Fake = {
    start: number;
    group?: number;
    uids?: number[];
    marker?: string;
    cmdline?: string[];
  };
  const write = async (pid: number, fake: Fake) => {
    const directory = join(root, String(pid));
    await mkdir(directory, { recursive: true });
    const fields = Array.from({ length: 30 }, () => "0");
    fields[0] = "S";
    fields[2] = String(fake.group ?? pid);
    fields[19] = String(fake.start);
    await writeFile(
      join(directory, "stat"),
      `${pid} (name with ) paren) ${fields.join(" ")}\n`,
    );
    const uids = (fake.uids ?? [1000, 1000, 1000, 1000]).join("\t");
    await writeFile(join(directory, "status"), `Name:\tx\nUid:\t${uids}\n`);
    await writeFile(
      join(directory, "environ"),
      `PATH=/bin\0STARGATE_TEST_TURN=${fake.marker ?? turn}\0HOME=/h\0`,
    );
    await writeFile(
      join(directory, "cmdline"),
      `${(fake.cmdline ?? ["claude", `--resume=${id}`]).join("\0")}\0`,
    );
  };
  const kills: [number, string][] = [];
  const table: ProcessTable = {
    root,
    uid: 1000,
    kill: (pid, name) => kills.push([pid, name]),
  };
  await write(100, { start: 500 });
  await write(101, { start: 500, uids: [1000, 1000, 0, 1000] });
  await write(102, { start: 500, marker: crypto.randomUUID() });
  await write(103, { start: 400 });
  await writeFile(join(root, "self"), "not a process");
  const found = await turnProcesses(table, marker, 450);
  // Other user, other marker, or older than the turn: never a candidate.
  expect(found).toEqual([{ pid: 100, start: 500 }]);
  const signalled = () => signalTurnProcesses(table, found, marker, "SIGTERM");
  // The PID was reused by a newer process, another user or another turn.
  for (const reused of [
    { start: 900 },
    { start: 500, uids: [1001, 1001, 1001, 1001] },
    { start: 500, marker: crypto.randomUUID() },
  ]) {
    await write(100, reused);
    expect(signalled()).toBe(0);
  }
  await rm(join(root, "100"), { recursive: true });
  expect(signalled()).toBe(0);
  expect(kills).toEqual([]);
  await write(100, { start: 500 });
  expect(signalled()).toBe(1);
  expect(kills).toEqual([[100, "SIGTERM"]]);
  // A group is signalled only through its verified leader.
  kills.length = 0;
  const leader = { pid: 100, start: 500, marker, session: id };
  expect(signalTurnGroup(table, leader, "SIGTERM")).toBe(true);
  expect(kills).toEqual([[-100, "SIGTERM"]]);
  kills.length = 0;
  for (const [recorded, actual] of [
    [{ start: 499 }, { start: 500 }],
    [{}, { start: 500, marker: crypto.randomUUID() }],
    [{}, { start: 500, uids: [1000, 0, 1000, 1000] }],
    [{}, { start: 500, cmdline: ["claude", "--resume=other"] }],
    [{}, { start: 500, group: 99 }],
  ] satisfies [Partial<typeof leader>, Fake][]) {
    await write(100, actual);
    expect(signalTurnGroup(table, { ...leader, ...recorded }, "SIGKILL")).toBe(
      false,
    );
  }
  expect(kills).toEqual([]);
  // Without a known user ID nothing is signalled.
  await write(100, { start: 500 });
  const unknown = { ...table, uid: undefined };
  expect(signalTurnProcesses(unknown, found, marker, "SIGTERM")).toBe(0);
  expect(signalTurnGroup(unknown, leader, "SIGTERM")).toBe(false);
  expect(kills).toEqual([]);
});

test("a marker under another variable name or as a suffix never matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-cli-proc-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const value = crypto.randomUUID();
  const table: ProcessTable = { root, uid: 1000, kill: () => {} };
  const write = async (pid: number, environ: string) => {
    const directory = join(root, String(pid));
    await mkdir(directory);
    const fields = Array.from({ length: 30 }, () => "0");
    fields[2] = String(pid);
    fields[19] = "500";
    await writeFile(join(directory, "stat"), `${pid} (x) ${fields.join(" ")}`);
    await writeFile(
      join(directory, "status"),
      "Uid:\t1000\t1000\t1000\t1000\n",
    );
    await writeFile(join(directory, "environ"), environ);
  };
  await write(10, `STARGATE_A_TURN=${value}\0`);
  await write(11, `XSTARGATE_A_TURN=${value}\0`);
  await write(12, `STARGATE_B_TURN=${value}\0`);
  await write(13, `PATH=/bin\0STARGATE_A_TURN=${value}x\0`);
  await write(14, `PATH=/bin\0STARGATE_A_TURN=${value}\0`);
  expect(
    await turnProcesses(table, { variable: "STARGATE_A_TURN", value }, 0),
  ).toEqual([
    { pid: 10, start: 500 },
    { pid: 14, start: 500 },
  ]);
});

test("turn start time is read from /proc/uptime in clock ticks", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-cli-proc-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const table: ProcessTable = { root, uid: 1000, kill: () => {} };
  expect(await bootTicks(table)).toBe(0);
  await writeFile(join(root, "uptime"), "1234.56 999.00\n");
  expect(await bootTicks(table)).toBe(123454);
  expect(
    statStart("1 (a) b) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0"),
  ).toBe(777);
});
