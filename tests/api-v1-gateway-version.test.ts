import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageManifest from "../package.json";
import { gatewayVersion } from "../src/api/v1/gateway";

test("the Fleet API reports the installed release's version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-release-"));
  try {
    await writeFile(
      join(directory, ".stargate-release.json"),
      JSON.stringify({
        schema: "stargate.release.v1",
        version: "0.40.0",
        tag: "v0.40.0",
        commit: null,
        sha256: null,
        installedAt: new Date().toISOString(),
        verification: "verified",
        tree: "equal",
      }),
    );
    expect(await gatewayVersion(directory)).toBe("0.40.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source checkout without a release record reports the package version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-source-"));
  try {
    expect(await gatewayVersion(directory)).toBe(packageManifest.version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function gitCheckout(directory: string, tags: string[]) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
      },
    });
  git("init", "-q");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "release",
  );
  for (const tag of tags) git("tag", tag);
}

test("a git checkout at a release tag reports that tag's version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-tagged-"));
  try {
    gitCheckout(directory, ["v0.40.1"]);
    expect(await gatewayVersion(directory)).toBe("0.40.1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an untagged or ambiguously tagged checkout reports the package version", async () => {
  const untagged = await mkdtemp(join(tmpdir(), "stargate-untagged-"));
  const ambiguous = await mkdtemp(join(tmpdir(), "stargate-ambiguous-"));
  try {
    gitCheckout(untagged, ["not-a-release"]);
    gitCheckout(ambiguous, ["v0.40.0", "v0.40.1"]);
    expect(await gatewayVersion(untagged)).toBe(packageManifest.version);
    expect(await gatewayVersion(ambiguous)).toBe(packageManifest.version);
  } finally {
    await rm(untagged, { recursive: true, force: true });
    await rm(ambiguous, { recursive: true, force: true });
  }
});
