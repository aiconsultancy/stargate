import { expect, test } from "bun:test";
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
