import { expect, test } from "bun:test";
import { Schema } from "effect";
import { healthConfigSchema } from "../src/health-config";
import {
  createHostHealthReader,
  type HostHealthSources,
} from "../src/health-host";

test("host snapshots expose safe process leaders and growth only after a baseline", async () => {
  let tick = 0;
  const sources: HostHealthSources = {
    now: () => (tick ? 2000 : 1000),
    load: () => [1, 2, 3],
    cores: () => 4,
    memory: () => 16000,
    uptime: () => 50,
    files: async (path) => {
      if (path === "/proc/meminfo")
        return "MemAvailable: 8 kB\nSwapTotal: 2 kB\nSwapFree: 1 kB\n";
      if (path === "/proc/stat") return `cpu ${tick ? 200 : 100} 0 0 0 0 0 0 0`;
      if (path.endsWith("/comm")) return "opencode\n";
      if (path.endsWith("/status")) return "VmRSS: 4 kB\nSecret: private-token";
      if (path.endsWith("/stat")) {
        const fields = Array(22).fill("0");
        fields[0] = "S";
        fields[11] = tick ? "15" : "10";
        fields[19] = "123";
        return `12 (secret process name) ${fields.join(" ")}`;
      }
      return null;
    },
    pids: async () => ["12"],
    filesystem: async () => ({
      blocks: 100,
      bsize: 1024,
      bavail: tick ? 50 : 60,
      files: 10,
      ffree: 5,
    }),
    marker: async () => null,
  };
  const read = createHostHealthReader(
    "/data",
    () => Schema.decodeUnknownSync(healthConfigSchema)({}),
    sources,
  );
  const first = await read();
  expect(first.processes?.[0]).toMatchObject({
    pid: 12,
    label: "opencode",
    cpuPercent: null,
    memoryBytes: 4096,
  });
  expect(first.growth).toBeNull();
  tick = 1;
  const second = await read();
  expect(second.processes?.[0]?.cpuPercent).toBe(20);
  expect(second.growth).toMatchObject({
    label: "root",
    bytes: 10240,
    intervalSeconds: 1,
  });
  expect(JSON.stringify(second)).not.toContain("secret");
  expect(second.timeSynchronized).toBeNull();
});

test("unreadable process and filesystem data stays unknown, never a zero leader", async () => {
  const sources: HostHealthSources = {
    now: () => 1000,
    load: () => [0, 0, 0],
    cores: () => 1,
    memory: () => 100,
    uptime: () => 1,
    files: async () => null,
    pids: async () => null,
    filesystem: async () => null,
    marker: async () => null,
  };
  const data = await createHostHealthReader(
    "/data",
    () => Schema.decodeUnknownSync(healthConfigSchema)({}),
    sources,
  )();
  expect(data.processes).toBeNull();
  expect(data.availableMemory).toBeNull();
  expect(data.disks.every((disk) => disk.available === null)).toBe(true);
  expect(data.rebootPending).toBeNull();
});
