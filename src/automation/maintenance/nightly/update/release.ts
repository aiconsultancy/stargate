import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Result, Schema } from "effect";
import { settingsPattern } from "../../../../config/settings-schema";
import { inspectArchive, verifyExtracted } from "./archive";
import {
  type GitHubRelease,
  githubReleaseSchema,
  githubReleases,
  selectGitHubRelease,
} from "./cooloff";
import {
  type CommandRunner,
  StepError,
  fetchJSON,
  must,
  request,
} from "../exec";
import { replaceLink } from "../files";
import { writePluginDigest } from "./plugin-digest";
import {
  type ReleaseMetadata,
  metadataFile,
  readMetadata,
} from "./release-record";
import { compareVersions, normalizeVersion, parseVersion } from "./versions";

/**
 * Install layout:
 *
 *   <root>/releases/<version>/   unpacked, installed and tested release
 *   <root>/current -> releases/<version>   what launchers and plugins load
 *   <root>/previous -> releases/<version>  the rollback target
 *
 * Only directories with `.stargate-release.json` are managed releases.
 */
export function layout(root: string) {
  return {
    root,
    releases: join(root, "releases"),
    current: join(root, "current"),
    previous: join(root, "previous"),
  };
}

/** Resolve a managed link (`current` or `previous`) to its release. */
export async function linkedRelease(
  root: string,
  which: "current" | "previous",
) {
  const paths = layout(root);

  try {
    const target = await readlink(paths[which]);
    const directory = resolve(root, target);

    if (dirname(directory) !== paths.releases) return null;
    const metadata = await readMetadata(directory);

    return metadata ? { name: basename(directory), directory, metadata } : null;
  } catch {
    return null;
  }
}

/**
 * Atomically point `current` at `releases/<name>` and `previous` at the old
 * target. Returns the old release name for rollback.
 */
export async function switchCurrent(root: string, name: string) {
  const paths = layout(root);

  if (!(await readMetadata(join(paths.releases, name))))
    throw new StepError("switch-failed");
  const old = await linkedRelease(root, "current");

  try {
    await replaceLink(paths.current, `releases/${name}`);

    if (old && old.name !== name)
      await replaceLink(paths.previous, `releases/${old.name}`);
  } catch {
    throw new StepError("switch-failed");
  }

  return old?.name ?? null;
}

/** Restore `current` to a previous release; `previous` is left unchanged. */
export async function restoreCurrent(root: string, name: string) {
  try {
    await replaceLink(layout(root).current, `releases/${name}`);
  } catch {
    throw new StepError("switch-failed");
  }
}

/**
 * One-time migration: mark an existing unpacked release directory under
 * `<root>/releases` as managed and create `current` if it is absent.
 */
export async function adoptRelease(
  root: string,
  directory: string,
  version: string,
) {
  const paths = layout(root);
  const resolved = resolve(directory);

  if (dirname(resolved) !== paths.releases)
    throw new Error(
      `Release must be a directory directly under ${paths.releases}.`,
    );

  if (!parseVersion(version))
    throw new Error("Use a MAJOR.MINOR.PATCH version.");

  const manifest: unknown = await Bun.file(join(resolved, "package.json"))
    .json()
    .catch(() => null);

  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !("name" in manifest) ||
    manifest.name !== "stargate" ||
    !(await Bun.file(join(resolved, "src", "main.ts")).exists())
  )
    throw new Error("Directory is not an unpacked Stargate release.");

  if (await readMetadata(resolved))
    throw new Error("Release is already managed.");

  const metadata: ReleaseMetadata = {
    schema: "stargate.release.v1",
    version: version.replace(/^v/, ""),
    tag: null,
    commit: null,
    sha256: null,
    installedAt: new Date().toISOString(),
    verification: "adopted",
    tree: "adopted",
  };

  await writeFile(
    join(resolved, metadataFile),
    `${JSON.stringify(metadata, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  const exists = await lstat(paths.current).catch(() => null);

  if (!exists) await symlink(`releases/${basename(resolved)}`, paths.current);

  return { current: exists ? "unchanged" : `releases/${basename(resolved)}` };
}

export async function githubToken(
  tokenEnv: string | undefined,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (tokenEnv) {
    const value = env[tokenEnv]?.trim();

    if (!value) throw new StepError("credentials-unavailable");

    return value;
  }

  const result = await runner.run(["gh", "auth", "token"], {
    timeoutMs: 15_000,
  });

  const token = result.stdout.trim();

  // An unauthenticated request still works for public repositories.
  return result.code === 0 && token && !/\s/.test(token) ? token : undefined;
}

export function githubHeaders(
  token: string | undefined,
): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token && { authorization: `Bearer ${token}` }),
  };
}

export type StargateReleaseConfig = {
  root: string;
  repository: string;
  apiURL: string;
  author: string;
  branch: string;
  checkout?: string | undefined;
  requireTreeCheck: boolean;
  coolOffHours: number;
  keep: number;
  installCommand: string[];
  testCommand: string[];
};

export type ReleaseCandidate = GitHubRelease & { version: string };

/** Newest eligible release, or null when it is not newer than `current`. */
export async function newerRelease(
  config: StargateReleaseConfig,
  headers: Record<string, string>,
  current: string | null,
  now: number,
) {
  const release = selectGitHubRelease(
    await githubReleases(config.apiURL, config.repository, headers),
    now,
    config.coolOffHours,
  );

  if (!release) return null;

  return current && compareVersions(release.version, current) <= 0
    ? null
    : release;
}

/**
 * The published release with exactly this version, for an operator update:
 * no cool-off. Looked up by its tag `v<version>`, so its age does not
 * matter. Drafts and prereleases never match. `not-found` otherwise.
 */
export async function namedRelease(
  config: StargateReleaseConfig,
  headers: Record<string, string>,
  version: string,
): Promise<ReleaseCandidate> {
  if (normalizeVersion(version) !== version) throw new StepError("not-found");

  const parsed = decodeRelease(
    await fetchJSON(
      `${config.apiURL.replace(/\/+$/, "")}/repos/${config.repository}/releases/tags/v${version}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...headers,
        },
      },
    ),
  );

  if (Result.isFailure(parsed)) throw new StepError("network");
  const found = parsed.success;

  if (
    found.draft ||
    found.prerelease ||
    normalizeVersion(found.tag_name) !== version
  )
    throw new StepError("not-found");

  return { ...found, version };
}

const decodeRelease = Schema.decodeUnknownResult(githubReleaseSchema);

const decodeRef = Schema.decodeUnknownResult(
  Schema.Struct({
    object: Schema.Struct({
      type: Schema.String,
      sha: Schema.String.check(settingsPattern(/^[a-f0-9]{40}$/)),
    }),
  }),
);

const decodeComparison = Schema.decodeUnknownResult(
  Schema.Struct({ status: Schema.String }),
);

/**
 * Release origin checks, all fail closed: the release and both assets come
 * from the configured CI author, and the tag's commit is on the branch.
 * Returns the tagged commit.
 */
export async function verifyOrigin(
  config: StargateReleaseConfig,
  release: ReleaseCandidate,
  headers: Record<string, string>,
) {
  const names = assetNames(release.version);

  const assets = release.assets.filter((asset) =>
    [names.archive, names.checksum].includes(asset.name),
  );

  if (
    release.author?.login !== config.author ||
    assets.length !== 2 ||
    // A missing uploader is not evidence of the CI author: fail closed.
    assets.some((asset) => asset.uploader?.login !== config.author)
  )
    throw new StepError("author-mismatch");
  const api = `${config.apiURL.replace(/\/+$/, "")}/repos/${config.repository}`;

  const ref = decodeRef(
    await fetchJSON(
      `${api}/git/ref/tags/${encodeURIComponent(release.tag_name)}`,
      {
        headers,
      },
    ),
  );

  if (Result.isFailure(ref)) throw new StepError("tag-not-on-branch");
  let commit = ref.success.object;

  if (commit.type === "tag") {
    const tag = decodeRef(
      await fetchJSON(`${api}/git/tags/${commit.sha}`, { headers }),
    );

    if (Result.isFailure(tag)) throw new StepError("tag-not-on-branch");
    commit = tag.success.object;
  }

  if (commit.type !== "commit") throw new StepError("tag-not-on-branch");

  const comparison = decodeComparison(
    await fetchJSON(
      `${api}/compare/${commit.sha}...${encodeURIComponent(config.branch)}`,
      { headers },
    ),
  );

  // `ahead` or `identical`: the branch contains the tagged commit.
  if (
    Result.isFailure(comparison) ||
    !["ahead", "identical"].includes(comparison.success.status)
  )
    throw new StepError("tag-not-on-branch");

  return commit.sha;
}

export function assetNames(version: string) {
  const archive = `stargate-v${version}.tar.gz`;

  return {
    prefix: `stargate-v${version}`,
    archive,
    checksum: `${archive}.sha256`,
  };
}

const maxArchiveBytes = 256 * 1024 * 1024;

/**
 * Download one asset. Credentials go only to the API origin, never to the
 * storage host it redirects to (see `request`).
 */
export async function downloadAsset(
  url: string,
  apiURL: string,
  headers: Record<string, string>,
  path: string,
  signal: AbortSignal,
) {
  if (new URL(url).origin !== new URL(apiURL).origin)
    throw new StepError("network");

  const response = await request(url, {
    headers: {
      accept: "application/octet-stream",
      ...(headers["authorization"] && {
        authorization: headers["authorization"],
      }),
    },
    signal,
    timeoutMs: 300_000,
  });

  if (!response.ok || !response.body) throw new StepError("network");

  return writeBody(response, path);
}

/** Stream a response body to a new file in a fresh staging directory. */
export async function writeBody(response: Response, path: string) {
  if (!response.body) throw new StepError("network");
  const out = Bun.file(path).writer();
  let size = 0;

  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;

      if (size > maxArchiveBytes) throw new StepError("archive-invalid");
      void out.write(chunk);
      await out.flush();
    }
  } catch (error) {
    throw error instanceof StepError ? error : new StepError("network");
  } finally {
    await out.end();
  }

  return size;
}

export async function sha256File(path: string) {
  const hash = createHash("sha256");

  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);

  return hash.digest("hex");
}

/** `sha256sum` output for exactly the expected archive name. */
export function parseChecksum(text: string, archive: string) {
  const lines = text.split("\n").filter((line) => line.trim());

  const match =
    lines.length === 1
      ? /^([a-f0-9]{64}) [ *]?(\S+)\s*$/.exec(lines[0] ?? "")
      : null;

  return match?.[2] === archive ? (match[1] ?? null) : null;
}

async function tree(directory: string) {
  const entries = new Map<string, string>();

  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const key = relative(directory, full).split(sep).join("/");
      const info = await lstat(full);

      if (info.isSymbolicLink()) entries.set(key, `l:${await readlink(full)}`);
      else if (info.isDirectory()) {
        entries.set(key, "d");
        await walk(full);
      } else if (info.isFile())
        entries.set(
          key,
          `f:${info.mode & 0o100 ? "x" : "-"}:${await sha256File(full)}`,
        );
      else entries.set(key, "other");
    }
  };

  await walk(directory);

  return entries;
}

/** Same paths, types, executable bits, file contents and link targets. */
export async function sameTree(left: string, right: string) {
  const [a, b] = await Promise.all([tree(left), tree(right)]);

  return (
    a.size === b.size && [...a].every(([key, value]) => b.get(key) === value)
  );
}

export type StageInput = {
  config: StargateReleaseConfig;
  release: ReleaseCandidate;
  headers: Record<string, string>;
  runner: CommandRunner;
  runID: string;
  /** Milliseconds left before the step must stop. */
  remaining: () => number;
  signal: AbortSignal;
};

const minutes = (n: number) => n * 60_000;

function budget(input: StageInput, cap: number) {
  const left = input.remaining();

  if (left < 30_000) throw new StepError("deadline");

  return Math.min(cap, left);
}

/** Minimal child environment for untrusted release code. */
export async function isolatedEnvironment(staging: string) {
  const home = join(staging, "home");
  const temp = join(staging, "tmp");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(temp, { recursive: true, mode: 0o700 });

  return {
    PATH: [
      dirname(process.execPath),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    HOME: home,
    TMPDIR: temp,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    LANG: "C.UTF-8",
  };
}

/**
 * Download, verify, unpack, install and test a release in its own directory.
 * Nothing live changes. On failure the partial directory is set aside as
 * `.failed-*` for inspection and later pruning.
 */
export async function stageRelease(input: StageInput) {
  const { config, release, runner } = input;
  const paths = layout(config.root);
  const names = assetNames(release.version);
  const target = join(paths.releases, release.version);
  const existing = await readMetadata(target);

  if (
    existing?.version === release.version &&
    existing.verification === "verified"
  )
    return { directory: target, metadata: existing, reused: true };

  // Attestations are unavailable: without the tree comparison, fail closed.
  if (config.requireTreeCheck && !config.checkout)
    throw new StepError("not-configured");
  const commit = await verifyOrigin(config, release, input.headers);
  await mkdir(paths.releases, { recursive: true, mode: 0o700 });
  const staging = join(paths.releases, `.staging-${input.runID}`);
  await mkdir(staging, { mode: 0o700 });
  let placed = false;

  try {
    const asset = (name: string) => {
      const found = release.assets.find((item) => item.name === name);

      if (!found) throw new StepError("not-found");

      return found;
    };

    const archive = join(staging, names.archive);
    const checksumPath = join(staging, names.checksum);
    await downloadAsset(
      asset(names.checksum).url,
      config.apiURL,
      input.headers,
      checksumPath,
      input.signal,
    );
    await downloadAsset(
      asset(names.archive).url,
      config.apiURL,
      input.headers,
      archive,
      input.signal,
    );

    const expected = parseChecksum(
      await readFile(checksumPath, "utf8"),
      names.archive,
    );

    const actual = await sha256File(archive);

    if (!expected || expected !== actual)
      throw new StepError("checksum-mismatch");
    // Validate every header before tar runs: one real root directory, no
    // Escaping paths or links, no hard links or devices.
    const entries = await inspectArchive(archive, names.prefix);
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked, { mode: 0o700 });
    await must(
      runner,
      ["tar", "-xzf", archive, "-C", unpacked, "--no-same-owner"],
      { timeoutMs: budget(input, minutes(2)) },
      "archive-invalid",
    );
    const root = await lstat(join(unpacked, names.prefix)).catch(() => null);

    if (!root?.isDirectory() || root.isSymbolicLink())
      throw new StepError("archive-invalid");
    // What tar actually wrote must be exactly what was validated.
    await verifyExtracted(unpacked, entries, names.prefix);
    const source = join(unpacked, names.prefix);
    let treeResult: ReleaseMetadata["tree"] = "not-configured";

    if (config.checkout) {
      await compareWithCheckout(
        input,
        release.tag_name,
        commit,
        source,
        staging,
      );
      treeResult = "equal";
    }

    if (await lstat(target).catch(() => null))
      await rename(
        target,
        join(paths.releases, `.failed-${release.version}-${input.runID}-old`),
      );
    await rename(source, target);
    placed = true;
    // Release code runs with a minimal environment: no inherited tokens,
    // Proxy keys or session bus, and a private HOME/TMPDIR inside staging,
    // So it cannot discover the live OpenCode service.
    const env = await isolatedEnvironment(staging);
    await must(
      runner,
      config.installCommand,
      {
        cwd: target,
        timeoutMs: budget(input, minutes(15)),
        env,
        inheritEnv: false,
      },
      "install-failed",
    );
    await must(
      runner,
      config.testCommand,
      {
        cwd: target,
        timeoutMs: budget(input, minutes(30)),
        env,
        inheritEnv: false,
      },
      "tests-failed",
    );
    // What OpenCode would load from this tree, for gateway-only updates.
    await writePluginDigest(target);

    const metadata: ReleaseMetadata = {
      schema: "stargate.release.v1",
      version: release.version,
      tag: release.tag_name,
      commit,
      sha256: actual,
      installedAt: new Date().toISOString(),
      verification: "verified",
      tree: treeResult,
    };

    await writeFile(
      join(target, metadataFile),
      `${JSON.stringify(metadata, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );

    return { directory: target, metadata, reused: false };
  } catch (error) {
    if (placed)
      await rename(
        target,
        join(paths.releases, `.failed-${release.version}-${input.runID}`),
      ).catch(() => {});
    throw error instanceof StepError ? error : new StepError("unknown");
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The unpacked archive must equal `git archive` of the tag in a configured
 * local clone. Compares trees, not compressed bytes.
 */
async function compareWithCheckout(
  input: StageInput,
  tag: string,
  commit: string,
  unpacked: string,
  staging: string,
) {
  const checkout = input.config.checkout;

  if (!checkout) return;

  const git = (
    args: string[],
    reason: "tree-mismatch" | "network" = "tree-mismatch",
  ) =>
    must(
      input.runner,
      ["git", "-C", checkout, ...args],
      {
        timeoutMs: budget(input, minutes(3)),
      },
      reason,
    );

  // A local tag that differs from GitHub's is refused, never overwritten.
  const tagged = async (): Promise<string> =>
    (
      await input.runner.run(
        [
          "git",
          "-C",
          checkout,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/tags/${tag}^{commit}`,
        ],
        { timeoutMs: budget(input, minutes(1)) },
      )
    ).stdout.trim();

  let local = await tagged();

  if (!local) {
    await git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        `refs/tags/${tag}:refs/tags/${tag}`,
      ],
      "network",
    );
    local = await tagged();
  }

  if (local !== commit) throw new StepError("tree-mismatch");
  const expectedTar = join(staging, "expected.tar");
  const prefix = basename(unpacked);
  await git([
    "archive",
    "--format=tar",
    `--prefix=${prefix}/`,
    "-o",
    expectedTar,
    commit,
  ]);
  const expected = join(staging, "expected");
  await mkdir(expected, { mode: 0o700 });
  await must(
    input.runner,
    ["tar", "-xf", expectedTar, "-C", expected, "--no-same-owner"],
    { timeoutMs: budget(input, minutes(2)) },
    "tree-mismatch",
  );

  if (!(await sameTree(unpacked, join(expected, prefix))))
    throw new StepError("tree-mismatch");
}

/**
 * Keep `current`, `previous` and the newest managed releases up to `keep`.
 * Deletes only managed releases and this tool's own staging/failed folders.
 */
export async function pruneReleases(
  root: string,
  keep: number,
  /** More releases to keep, for example one that OpenCode still runs. */
  inUse: readonly string[] = [],
) {
  const paths = layout(root);
  const current = await linkedRelease(root, "current");
  const previous = await linkedRelease(root, "previous");
  const managed: { name: string; version: string }[] = [];
  const removed: string[] = [];

  for (const entry of await readdir(paths.releases, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    if (/^\.(staging|failed)-/.test(entry.name)) {
      await rm(join(paths.releases, entry.name), {
        recursive: true,
        force: true,
      });
      removed.push(entry.name);
      continue;
    }

    const metadata = await readMetadata(join(paths.releases, entry.name));

    if (metadata) managed.push({ name: entry.name, version: metadata.version });
  }

  const protectedNames = new Set(
    [current?.name, previous?.name, ...inUse].filter(Boolean),
  );

  const ordered = managed.toSorted((a, b) =>
    compareVersions(b.version, a.version),
  );

  let kept = protectedNames.size;

  for (const release of ordered) {
    if (protectedNames.has(release.name)) continue;

    if (kept < keep) {
      kept++;
      continue;
    }

    await rm(join(paths.releases, release.name), {
      recursive: true,
      force: true,
    });
    removed.push(release.name);
  }

  return removed;
}
