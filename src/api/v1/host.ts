import { readFile, stat, statfs } from "node:fs/promises";
import {
  arch,
  type CpuInfo,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  totalmem,
  uptime,
} from "node:os";
import type { V1Host } from "./types";

export function memAvailableBytes(meminfo: string) {
  const match = /^MemAvailable:[ \t]+(\d+)[ \t]+kB[ \t]*$/m.exec(meminfo);
  if (!match) return undefined;
  const bytes = Number(match[1]) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

type CpuTotals = { cores: number; total: number; idle: number };

export function cpuTotals(cores: readonly Pick<CpuInfo, "times">[]): CpuTotals {
  let total = 0;
  let idle = 0;
  for (const { times } of cores) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { cores: cores.length, total, idle };
}

export function cpuUsage(previous: CpuTotals, current: CpuTotals) {
  const elapsed = current.total - previous.total;
  const idle = current.idle - previous.idle;
  return current.cores === previous.cores &&
    elapsed > 0 &&
    idle >= 0 &&
    idle <= elapsed
    ? (elapsed - idle) / elapsed
    : null;
}

async function disk(path: string) {
  try {
    const { dev } = await stat(path, { bigint: true });
    const usage = await statfs(path);
    const blockBytes = usage.frsize || usage.bsize;
    return {
      dev,
      metrics: {
        totalBytes: blockBytes * usage.blocks,
        freeBytes: blockBytes * usage.bavail,
      },
    };
  } catch {
    return undefined;
  }
}

async function availableMemory() {
  if (process.platform === "linux") {
    const available = await readFile("/proc/meminfo", "utf8").then(
      memAvailableBytes,
      () => undefined,
    );
    if (available !== undefined) return available;
  }
  return freemem();
}

export function startHostMetrics(dataDirectory: string) {
  let cpu = cpuTotals(cpus());
  let usage: number | null = null;
  const sampler = setInterval(() => {
    const next = cpuTotals(cpus());
    usage = cpuUsage(cpu, next);
    cpu = next;
  }, 5000);
  function snapshot(
    disks: V1Host["disks"] = [],
    availableBytes = freemem(),
  ): V1Host {
    const [short = 0, medium = 0, long = 0] = loadavg();
    return {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      uptimeSec: uptime(),
      cpu: { cores: cpu.cores, usage, load: [short, medium, long] },
      memory: { totalBytes: totalmem(), availableBytes },
      disks,
      sampledAt: Date.now(),
    };
  }

  async function sample() {
    const [availableBytes, root, data] = await Promise.all([
      availableMemory(),
      disk("/"),
      disk(dataDirectory),
    ]);
    const disks = [];
    if (root) disks.push({ path: "/", ...root.metrics });
    if (data && data.dev !== root?.dev)
      disks.push({ path: "data", ...data.metrics });
    return snapshot(disks, availableBytes);
  }

  let latest: V1Host | undefined;
  let pending: Promise<V1Host> | undefined;
  return {
    stop: () => clearInterval(sampler),
    snapshot: () => latest ?? snapshot(),
    read() {
      pending ??= sample()
        .then((data) => {
          latest = data;
          return data;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
