import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { inspectArchive, verifyExtracted } from "./archive";
import type { MaintenanceConfig } from "./config";
import {
  type GitHubRelease,
  githubReleases,
  npmPackument,
  publishedAt,
  selectGitHubRelease,
  selectNpmVersion,
} from "./cooloff";
import { type CommandRunner, fetchOK, must, request, StepError } from "./exec";
import { replaceLink } from "./files";
import { sha256File, writeBody } from "./release";
import { compareVersions, parseVersion } from "./versions";

export type ProxyConfig = NonNullable<MaintenanceConfig["proxy"]>;
export type CliProxyConfig = NonNullable<MaintenanceConfig["cliproxyapi"]>;
export type AgentCliConfig = NonNullable<MaintenanceConfig["agentClis"]>;

/** Read the proxy client key from a private file. Never log or return it. */
export async function readClientKey(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error();
    const key = (await readFile(path, "utf8")).trim();
    if (!key || /\s/.test(key)) throw new Error();
    return key;
  } catch {
    throw new StepError("credentials-unavailable");
  }
}

/** `GET /v1/models`; returns model IDs. Fails unless the proxy answers. */
export async function proxyModels(proxy: ProxyConfig, signal: AbortSignal) {
  const key = await readClientKey(proxy.clientKeyFile);
  const response = await fetchOK(`${proxy.url.replace(/\/+$/, "")}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal,
    timeoutMs: 15_000,
  }).catch(() => {
    throw new StepError("health-failed");
  });
  const parsed = z
    .object({ data: z.array(z.object({ id: z.string() })) })
    .safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.data.length === 0)
    throw new StepError("health-failed");
  return parsed.data.data.map((model) => model.id);
}

/**
 * Smallest useful request through the proxy, in the protocol the OpenCode
 * provider uses: Anthropic Messages for `claude-*`, OpenAI Responses for the
 * rest. Any non-2xx status, timeout or unexpected body fails the probe. An
 * `incomplete` response still proves that the model answers.
 */
export async function probeModel(
  proxy: ProxyConfig,
  model: string,
  signal: AbortSignal,
) {
  try {
    const key = await readClientKey(proxy.clientKeyFile);
    const claude = model.startsWith("claude-");
    const prompt = "Reply with the single word OK.";
    const response = await fetchOK(
      `${proxy.url.replace(/\/+$/, "")}${claude ? "/v1/messages" : "/v1/responses"}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "x-api-key": key,
          "content-type": "application/json",
          ...(claude ? { "anthropic-version": "2023-06-01" } : {}),
        },
        body: JSON.stringify(
          claude
            ? {
                model,
                max_tokens: 16,
                messages: [{ role: "user", content: prompt }],
              }
            : { model, input: prompt, max_output_tokens: 16, store: false },
        ),
        signal,
        timeoutMs: 60_000,
      },
    );
    const body = z
      .union([
        z.object({ content: z.array(z.unknown()) }),
        z.object({ output: z.array(z.unknown()) }),
        z.object({ status: z.enum(["completed", "incomplete"]) }),
      ])
      .safeParse(await response.json());
    return body.success;
  } catch {
    return false;
  }
}

function binaryPattern(template: string) {
  const [before = "", after = ""] = template.split("{version}");
  const escapeRegExp = (text: string) =>
    text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escapeRegExp(before)}(\\d+\\.\\d+\\.\\d+)${escapeRegExp(after)}$`,
  );
}

export const binaryPath = (config: CliProxyConfig, version: string) =>
  config.binary.replaceAll("{version}", version);

/**
 * Installed version from the stable link. Null means the install still pins
 * a versioned path directly: the documented one-time migration is required.
 */
export async function cliProxyCurrent(config: CliProxyConfig) {
  try {
    if (!(await lstat(config.link)).isSymbolicLink()) return null;
    const target = resolve(dirname(config.link), await readlink(config.link));
    return binaryPattern(config.binary).exec(target)?.[1] ?? null;
  } catch {
    return null;
  }
}

export type ProxyCandidate = {
  version: string;
  asset: GitHubRelease["assets"][number];
  /** Pinned SHA-256 from GitHub's asset digest. */
  digest: string;
};

/**
 * Newest eligible release whose platform asset exists with a GitHub
 * SHA-256 digest. Release and asset ages both obey the cool-off.
 */
export async function cliProxyCandidate(
  config: CliProxyConfig,
  now: number,
): Promise<ProxyCandidate | null> {
  const release = selectGitHubRelease(
    await githubReleases(config.apiURL, config.repository),
    now,
    config.coolOffHours,
  );
  if (!release) return null;
  const name = config.asset.replaceAll("{version}", release.version);
  const asset = release.assets.find((item) => item.name === name);
  const digest = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? "")?.[1];
  if (!asset || !digest) throw new StepError("checksum-mismatch");
  return { version: release.version, asset, digest };
}

/**
 * Download the pinned asset, verify its digest and archive headers, and
 * install the executable as `binary` for that version. A different binary
 * already at that path is never replaced. Nothing live changes.
 */
export async function cliProxyPrepare(
  config: CliProxyConfig,
  candidate: ProxyCandidate,
  staging: string,
  runner: CommandRunner,
  signal: AbortSignal,
) {
  if (!parseVersion(candidate.version)) throw new StepError("install-failed");
  const url = candidate.asset.browser_download_url;
  if (!url) throw new StepError("not-found");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const archive = join(staging, "asset.tar.gz");
    const response = await request(url, { signal, timeoutMs: 600_000 });
    if (!response.ok) throw new StepError("network");
    await writeBody(response, archive);
    const asset = await sha256File(archive);
    if (asset !== candidate.digest) throw new StepError("checksum-mismatch");
    const entries = await inspectArchive(archive);
    const executable = entries.filter(
      (entry) => entry.path === config.executable && entry.type === "file",
    );
    if (executable.length !== 1) throw new StepError("archive-invalid");
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked, { mode: 0o700 });
    await must(
      runner,
      [
        "tar",
        "-xzf",
        archive,
        "-C",
        unpacked,
        "--no-same-owner",
        config.executable,
      ],
      { timeoutMs: 120_000 },
      "archive-invalid",
    );
    // Only the one regular file was written; nothing else, no link.
    await verifyExtracted(unpacked, executable);
    const extracted = join(unpacked, config.executable);
    const binary = await sha256File(extracted);
    const target = binaryPath(config, candidate.version);
    const existing = await lstat(target).catch(() => null);
    if (existing) {
      if (
        existing.isSymbolicLink() ||
        !existing.isFile() ||
        (await sha256File(target)) !== binary
      )
        throw new StepError("checksum-mismatch");
    } else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.stargate-${process.pid}`;
      await copyFile(extracted, temp, constants.COPYFILE_EXCL);
      await chmod(temp, 0o700);
      await rename(temp, target);
    }
    const installed = await lstat(target);
    if (
      installed.isSymbolicLink() ||
      !installed.isFile() ||
      installed.nlink !== 1
    )
      throw new StepError("archive-invalid");
    return { asset, binary };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cliProxySwitch(config: CliProxyConfig, version: string) {
  try {
    await replaceLink(config.link, binaryPath(config, version));
  } catch {
    throw new StepError("switch-failed");
  }
}

export async function npmInstalledVersion(prefix: string, name: string) {
  try {
    const manifest = JSON.parse(
      await readFile(
        join(prefix, "lib", "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    const version = z.object({ version: z.string() }).parse(manifest).version;
    return parseVersion(version) ? version : null;
  } catch {
    return null;
  }
}

export type AgentPlan = {
  name: string;
  command: string;
  before: string | null;
  candidate: string | null;
  /** Registry publication time of `before`: the fallback restore cutoff. */
  beforePublished: string | null;
};

export async function agentCliPlan(config: AgentCliConfig, now: number) {
  const plans: AgentPlan[] = [];
  for (const item of config.packages) {
    const before = await npmInstalledVersion(config.prefix, item.name);
    let candidate: string | null = null;
    let beforePublished: string | null = null;
    try {
      const raw = await npmPackument(config.registry, item.name);
      candidate = selectNpmVersion(raw, now, config.coolOffHours);
      beforePublished = before ? publishedAt(raw, before) : null;
    } catch {
      candidate = null;
    }
    plans.push({ ...item, before, candidate, beforePublished });
  }
  return plans;
}

/** Only installed packages are updated; maintenance never adds a CLI. */
export const needsUpdate = (plan: AgentPlan) =>
  plan.candidate !== null &&
  plan.before !== null &&
  compareVersions(plan.candidate, plan.before) > 0;

/**
 * One npm transaction. `--before` applies the cool-off to dependencies too.
 * Install scripts run only for listed packages: `--strict-allow-scripts`
 * turns an unlisted script into a failed install (plain `--allow-scripts`
 * only warns); an empty list disables every script.
 */
export function npmInstallCommand(
  config: AgentCliConfig,
  specs: { name: string; version: string }[],
  cutoff: string,
) {
  return [
    ...(config.lockFile ? ["flock", "--nonblock", config.lockFile] : []),
    ...config.npm,
    "install",
    "--global",
    "--prefix",
    config.prefix,
    "--registry",
    config.registry,
    `--before=${cutoff}`,
    ...(config.allowScripts.length
      ? [
          `--allow-scripts=${config.allowScripts.join(",")}`,
          "--strict-allow-scripts",
        ]
      : ["--ignore-scripts"]),
    ...specs.map((spec) => `${spec.name}@${spec.version}`),
  ];
}

export async function agentCliInstall(
  config: AgentCliConfig,
  specs: { name: string; version: string }[],
  cutoff: string,
  runner: CommandRunner,
  timeoutMs: number,
) {
  if (!specs.length) return;
  await must(
    runner,
    npmInstallCommand(config, specs, cutoff),
    { timeoutMs },
    "install-failed",
  );
}

/** The installed command reports the expected version. */
export async function agentCliVerify(
  config: AgentCliConfig,
  plan: { name: string; command: string },
  version: string,
  runner: CommandRunner,
) {
  const installed = await npmInstalledVersion(config.prefix, plan.name);
  const result = await runner.run(
    [join(config.prefix, "bin", plan.command), "--version"],
    {
      timeoutMs: 30_000,
    },
  );
  return (
    installed === version &&
    result.code === 0 &&
    new RegExp(`(^|[^0-9.])${version.replaceAll(".", "\\.")}([^0-9.]|$)`).test(
      result.stdout,
    )
  );
}
