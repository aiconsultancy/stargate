import { constants } from "node:fs";
import { open, readdir, stat, statfs } from "node:fs/promises";
import { cpus, loadavg, totalmem, uptime } from "node:os";
import { z } from "zod";
import type { HealthConfig } from "./health-config";

const metric = z.number().finite().nonnegative();
const diskLabel = z.enum(["root", "stargate", "opencode", "crew"]);
const processMetric = z.object({
  pid: metric,
  label: z.enum(["stargate", "opencode", "proxy", "sourcebot", "other"]),
  cpuPercent: metric.nullable(),
  memoryBytes: metric.nullable(),
});
export const hostHealthSchema = z.object({
  load: z.tuple([metric, metric, metric]),
  cores: metric,
  totalMemory: metric,
  availableMemory: metric.nullable(),
  swapTotal: metric.nullable().optional(),
  swapFree: metric.nullable().optional(),
  uptimeSeconds: metric,
  disks: z
    .array(
      z.object({
        label: diskLabel,
        total: metric.nullable(),
        available: metric.nullable(),
        inodes: metric.nullable(),
        freeInodes: metric.nullable(),
      }),
    )
    .max(4),
  processes: z.array(processMetric).max(5).nullable().optional(),
  processCoverage: z.enum(["sampled", "unknown"]).optional(),
  growth: z
    .object({ label: diskLabel, bytes: metric, intervalSeconds: metric })
    .nullable()
    .optional(),
  rebootPending: z.boolean().nullable().optional(),
  timeSynchronized: z.boolean().nullable().optional(),
});

/** Regular files only; proc pseudo-files may report size zero. Never follow links. */
export async function readHealthFile(
  path: string,
  limit: number,
  privateFile = false,
): Promise<string | null> {
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > limit ||
        (privateFile &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      )
        return null;
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return bytesRead > limit
        ? null
        : buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

export type HostHealthSources = {
  now(): number;
  load(): number[];
  cores(): number;
  memory(): number;
  uptime(): number;
  files(path: string, limit: number): Promise<string | null>;
  pids(): Promise<string[] | null>;
  filesystem(path: string): Promise<{
    blocks: number;
    bsize: number;
    bavail: number;
    files: number;
    ffree: number;
  } | null>;
  marker(path: string): Promise<boolean | null>;
};
const defaults: HostHealthSources = {
  now: Date.now,
  load: loadavg,
  cores: () => cpus().length,
  memory: totalmem,
  uptime,
  files: readHealthFile,
  pids: () =>
    readdir("/proc").then(
      (items) => items.filter((id) => /^\d+$/.test(id)),
      () => null,
    ),
  filesystem: (path) => statfs(path).catch(() => null),
  marker: (path) =>
    stat(path).then(
      () => true,
      () => null,
    ),
};

type Baseline = {
  at: number;
  ticks: number | null;
  disks: z.infer<typeof hostHealthSchema>["disks"];
  processes: Map<number, { ticks: number; start: string }>;
};

/** In-memory baselines only; no health request writes a file or starts a sampler. */
export function createHostHealthReader(
  dataDirectory: string,
  config: () => HealthConfig,
  io: HostHealthSources = defaults,
) {
  let previous: Baseline | undefined;
  return async () => {
    const result = await collectHost(dataDirectory, config(), io, previous);
    previous = result.baseline;
    return result.health;
  };
}

export async function readHostHealth(
  dataDirectory: string,
  config: HealthConfig,
) {
  return (await collectHost(dataDirectory, config, defaults)).health;
}

async function collectHost(
  dataDirectory: string,
  config: HealthConfig,
  io: HostHealthSources,
  previous?: Baseline,
) {
  const at = io.now();
  const memory = await io.files("/proc/meminfo", 65536);
  const value = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(memory ?? "");
    return match ? Number(match[1]) * 1024 : null;
  };
  const paths = [
    ["root", "/"],
    ["stargate", dataDirectory],
    ["opencode", config.opencodeDataDirectory],
    ["crew", config.crewWorktreesDirectory],
  ] as const;
  const disks = await Promise.all(
    paths.map(async ([label, path]) => {
      const info = path ? await io.filesystem(path) : null;
      return {
        label,
        total: info ? info.blocks * info.bsize : null,
        available: info ? info.bavail * info.bsize : null,
        inodes: info?.files ?? null,
        freeInodes: info?.ffree ?? null,
      };
    }),
  );
  const load = io.load();
  const cores = io.cores();
  const total = /^cpu\s+([\d ]+)$/m.exec(
    (await io.files("/proc/stat", 65536)) ?? "",
  );
  const ticks =
    total?.[1]
      ?.trim()
      .split(/\s+/)
      .slice(0, 8)
      .reduce((sum, v) => sum + Number(v), 0) ?? null;
  const ids = await io.pids();
  const samples: z.infer<typeof processMetric>[] = [];
  const processTimes = new Map<number, { ticks: number; start: string }>();
  // Bounded scan, eight readers at a time. Process coverage is never represented as complete.
  const pending = (ids ?? []).filter((id) => /^\d+$/.test(id)).slice(0, 512);
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
        const [comm, cpu, status] = await Promise.all([
          io.files(`/proc/${id}/comm`, 1024),
          io.files(`/proc/${id}/stat`, 16384),
          io.files(`/proc/${id}/status`, 16384),
        ]);
        const tail = cpu
          ?.slice((cpu.lastIndexOf(")") ?? -1) + 2)
          .trim()
          .split(/\s+/);
        const user = Number(tail?.[11]);
        const system = Number(tail?.[12]);
        const start = tail?.[19];
        if (comm === null || !start || !Number.isFinite(user + system))
          continue;
        const pid = Number(id);
        const processTicks = user + system;
        processTimes.set(pid, { ticks: processTicks, start });
        const before = previous?.processes.get(pid);
        const delta =
          ticks !== null &&
          previous?.ticks !== null &&
          previous?.ticks !== undefined
            ? ticks - previous.ticks
            : 0;
        const cpuPercent =
          before?.start === start && delta > 0 && processTicks >= before.ticks
            ? ((processTicks - before.ticks) / delta) * cores * 100
            : null;
        const name = comm.trim().toLowerCase();
        const label =
          pid === process.pid
            ? "stargate"
            : name.includes("opencode")
              ? "opencode"
              : name.includes("cliproxy")
                ? "proxy"
                : name.includes("sourcebot")
                  ? "sourcebot"
                  : "other";
        const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status ?? "");
        samples.push({
          pid,
          label,
          cpuPercent,
          memoryBytes: rss?.[1] ? Number(rss[1]) * 1024 : null,
        });
      }
    }),
  );
  const leaders = new Map<number, z.infer<typeof processMetric>>();
  for (const entry of [...samples]
    .sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1))
    .slice(0, 2))
    leaders.set(entry.pid, entry);
  for (const entry of [...samples]
    .sort((a, b) => (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1))
    .slice(0, 3))
    leaders.set(entry.pid, entry);
  let growth: z.infer<typeof hostHealthSchema>["growth"] = null;
  if (previous && at > previous.at) {
    for (const disk of disks) {
      const before = previous.disks.find((old) => old.label === disk.label);
      if (before?.available == null || disk.available == null) continue;
      const bytes = Math.max(0, before.available - disk.available);
      if (!growth || bytes > growth.bytes)
        growth = {
          label: disk.label,
          bytes,
          intervalSeconds: (at - previous.at) / 1000,
        };
    }
  }
  const health = hostHealthSchema.parse({
    load: [load[0], load[1], load[2]],
    cores,
    totalMemory: io.memory(),
    availableMemory: value("MemAvailable"),
    swapTotal: value("SwapTotal"),
    swapFree: value("SwapFree"),
    uptimeSeconds: io.uptime(),
    disks,
    processes: ids === null ? null : [...leaders.values()],
    processCoverage: ids === null ? "unknown" : "sampled",
    growth,
    rebootPending: await io.marker("/run/reboot-required"),
    timeSynchronized: await io.marker("/run/systemd/timesync/synchronized"),
  });
  return { health, baseline: { at, ticks, disks, processes: processTimes } };
}
