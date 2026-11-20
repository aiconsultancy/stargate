import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpuTotals, cpuUsage, memAvailableBytes } from "../src/api/v1/host";
import {
  defaultCorsOrigins,
  originMatcher,
  parseApiListen,
  peerAddress,
} from "../src/api/v1/network";
import { apiToken } from "../src/api/v1/token";
import { runCli } from "../src/cli";
import { configSchema } from "../src/config";
import { restartRequired } from "../src/config-reload";
import { decodeSettings } from "../src/settings-errors";
import example from "../stargate.example.json";

test("Fleet API bind is limited to supported private literal addresses", () => {
  for (const listen of [
    ":8080",
    "127.0.0.2:8080",
    "10.0.0.1:8080",
    "172.31.1.1:8080",
    "192.168.0.2:8080",
    "100.101.102.103:8080",
    "[::1]:8080",
    "[fd12::2]:8080",
  ]) {
    expect(
      decodeSettings(configSchema, { ...example, api: { listen } }).api?.listen,
    ).toBe(listen);
  }
  expect(parseApiListen(":8080")).toEqual({
    hostname: "127.0.0.1",
    port: 8080,
  });
  for (const listen of [
    "8080",
    "localhost:8080",
    "0.0.0.0:8080",
    "8.8.8.8:8080",
    "[::]:8080",
    "[::ffff:127.0.0.1]:8080",
    "[2001:db8::1]:8080",
    "[fe80::1%lo0]:8080",
    "100.128.0.1:8080",
    "172.32.0.1:8080",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "::1:8080",
    "[127.0.0.1]:8080",
    "127.1:8080",
    "127.0.0.1",
  ]) {
    expect(() =>
      decodeSettings(configSchema, { ...example, api: { listen } }),
    ).toThrow("private-network only");
  }
  expect(
    decodeSettings(configSchema, { ...example, api: undefined }).api,
  ).toBeUndefined();
});

test("Fleet API rejects CIDRs reaching outside private ranges and unknown config keys", () => {
  const listen = "127.0.0.1:8080";
  for (const cidr of [
    "0.0.0.0/0",
    "172.16.0.0/11",
    "192.168.1.0/15",
    "100.64.0.0/9",
    "127.0.0.1/33",
    "::1/127",
    "fc00::/6",
    "::ffff:127.0.0.1/128",
    "fe80::/10",
    "8.8.8.0/24",
    "10.0.0.1",
  ]) {
    expect(() =>
      decodeSettings(configSchema, {
        ...example,
        api: { listen, allowedNetworks: [cidr] },
      }),
    ).toThrow("private-network only");
  }
  const allowedNetworks = [
    "127.0.0.1/32",
    "100.101.102.0/24",
    "fd12::/32",
    "::1/128",
  ];
  expect(
    decodeSettings(configSchema, {
      ...example,
      api: { listen, allowedNetworks },
    }).api?.allowedNetworks,
  ).toEqual(allowedNetworks);
  for (const extra of [
    { allowedNetworks: [] },
    { corsOrigins: ["https://subspace*"] },
    { corsOrigins: ["https://example.com/path"] },
    { corsOrigins: ["null"] },
    { enabled: true },
  ]) {
    expect(() =>
      decodeSettings(configSchema, { ...example, api: { listen, ...extra } }),
    ).toThrow();
  }
});

test("Fleet API settings are restart-only", () => {
  const environment = {};
  const off = {
    config: decodeSettings(configSchema, { ...example, api: undefined }),
    environment,
  };
  const on = {
    config: decodeSettings(configSchema, {
      ...example,
      api: { listen: ":8080" },
    }),
    environment,
  };
  const changed = {
    config: decodeSettings(configSchema, {
      ...example,
      api: { listen: ":8081" },
    }),
    environment,
  };
  expect(restartRequired(off, on)).toEqual(["api"]);
  expect(restartRequired(on, off)).toEqual(["api"]);
  expect(restartRequired(on, changed)).toEqual(["api.listen"]);
});

test("Unix API mode is an explicit exclusive opt-in without an enabled alias", () => {
  const api = { listen: "unix", allowedNetworks: ["127.0.0.1/32"] };
  expect(decodeSettings(configSchema, { ...example, api }).api).toEqual(api);
  for (const extra of [{ enabled: true }, { socket: "/other.sock" }]) {
    expect(() =>
      decodeSettings(configSchema, { ...example, api: { ...api, ...extra } }),
    ).toThrow();
  }
});

test("origin wildcards match exactly one ASCII label", () => {
  const allows = originMatcher([
    ...defaultCorsOrigins,
    "https://subspace.*",
    "https://console.example.com:8443",
  ]);
  for (const origin of [
    "subspace://space-123",
    "https://subspace.space-123",
    "https://subspace.123",
    "https://console.example.com:8443",
  ])
    expect(allows(origin)).toBe(true);
  for (const origin of [
    null,
    "null",
    "subspace://",
    "subspace://space.example",
    "https://subspace.space.example",
    "https://subspace.space:8080",
    "https://subspace.space@evil.example",
    "https://subspace.space/",
    "https://subspace.space_123",
    "https://console.example.com",
    "https://consoleXexampleXcom:8443",
    "https://subspace.Space",
    "http://subspace.space",
  ])
    expect(allows(origin)).toBe(false);
  const defaults = originMatcher(defaultCorsOrigins);
  expect(defaults("subspace://space-123")).toBe(true);
  expect(defaults("https://subspace.space-123")).toBe(false);
  expect(defaults("https://subspace.com")).toBe(false);
  expect(peerAddress("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
  expect(peerAddress("0:0:0:0:0:0:0:1")).toBe("::1");
});

test("host parsers compute available bytes and aggregate CPU deltas", () => {
  expect(
    memAvailableBytes(
      "MemTotal: 99999 kB\nMemFree: 100 kB\nMemAvailable:   40000 kB\n",
    ),
  ).toBe(40_000 * 1024);
  expect(memAvailableBytes("MemAvailable: -1 kB\n")).toBeUndefined();
  expect(memAvailableBytes("MemAvailable: 100 MB\n")).toBeUndefined();
  expect(memAvailableBytes("MemFree: 100 kB\n")).toBeUndefined();
  expect(
    memAvailableBytes("MemAvailable: 9999999999999999 kB\n"),
  ).toBeUndefined();
  const first = cpuTotals([
    { times: { user: 20, nice: 5, sys: 5, idle: 70, irq: 0 } },
  ]);
  const next = cpuTotals([
    { times: { user: 50, nice: 10, sys: 20, idle: 110, irq: 10 } },
  ]);
  expect(cpuUsage(first, next)).toBe(0.6);
  expect(cpuUsage(first, first)).toBeNull();
  expect(cpuUsage(next, first)).toBeNull();
  expect(cpuUsage(first, { ...next, cores: 2 })).toBeNull();
});

test("api token CLI creates one private token, prints only it, and rotates it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-token-"));
  const config = join(directory, "stargate.json");
  const dataDirectory = join(directory, "private");
  const path = join(dataDirectory, "api-token");
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  const run = (...args: string[]) => runCli([...args, "--config", config]);
  try {
    await writeFile(
      config,
      JSON.stringify({ ...example, api: { listen: "0.0.0.0:8080" } }),
    );
    await expect(run("config", "check", "--schema-only")).rejects.toThrow(
      "api.listen: Fleet API is private-network only",
    );
    await writeFile(config, JSON.stringify({ ...example, api: undefined }));
    await expect(run("api", "token")).rejects.toThrow("Enable api");
    expect(stdout).not.toHaveBeenCalled();
    await writeFile(
      config,
      JSON.stringify({
        ...example,
        api: { listen: ":8080" },
        dataDirectory: "private",
      }),
    );
    expect(await run("api", "token")).toEqual({ command: "exit" });
    const contents = await readFile(path, "utf8");
    expect(stdout.mock.calls).toEqual([[contents]]);
    expect(contents).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(Buffer.from(contents.trim(), "base64url")).toHaveLength(32);
    expect((await stat(path)).mode & 0o7777).toBe(0o600);
    await run("api", "token");
    await run("api", "token", "--rotate");
    const rotated = await readFile(path, "utf8");
    expect(rotated).not.toBe(contents);
    expect(stdout.mock.calls).toEqual([[contents], [contents], [rotated]]);
    expect(stderr).not.toHaveBeenCalled();
    expect((await stat(path)).mode & 0o7777).toBe(0o600);
    const concurrentDirectory = join(directory, "concurrent");
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => apiToken(concurrentDirectory)),
    );
    expect(new Set(tokens).size).toBe(1);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
