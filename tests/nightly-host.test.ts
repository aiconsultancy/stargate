import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { maintenanceSchema } from "../src/maintenance/nightly/config";
import { processRunner } from "../src/maintenance/nightly/exec";
import {
  binaryPath,
  cliProxyCandidate,
  cliProxyPrepare,
  npmInstallCommand,
} from "../src/maintenance/nightly/update/host";
import { restoreCutoff } from "../src/maintenance/nightly/run";
import { tarball } from "./tar";

const root = await mkdtemp(join(tmpdir(), "stargate-host-"));
const now = Date.parse("2026-11-12T00:10:00Z");
const old = new Date(now - 72 * 3_600_000).toISOString();

const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

let asset = tarball([
  { path: "cli-proxy-api", data: "new-binary", mode: 0o755 },
]);

let digest = sha(asset);
let port = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;

    if (path === "/repos/router-for-me/CLIProxyAPI/releases")
      return Response.json([
        {
          id: 1,
          tag_name: "v8.0.60",
          draft: false,
          prerelease: false,
          published_at: old,
          author: { login: "github-actions[bot]" },
          assets: [
            {
              id: 9,
              name: "CLIProxyAPI_8.0.60_linux_amd64.tar.gz",
              size: asset.length,
              url: `http://127.0.0.1:${port}/api/asset`,
              browser_download_url: `http://127.0.0.1:${port}/download`,
              created_at: old,
              updated_at: old,
              digest: digest ? `sha256:${digest}` : null,
            },
          ],
        },
      ]);

    if (path === "/download") return new Response(asset);

    return new Response("missing", { status: 404 });
  },
});

port = server.port ?? 0;

afterAll(async () => {
  void server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const settings = (dir: string) => {
  const parsed = Schema.decodeUnknownSync(maintenanceSchema)({
    cliproxyapi: {
      link: join(dir, "current"),
      binary: join(dir, "{version}", "cliproxyapi"),
      apiURL: `http://127.0.0.1:${port}`,
    },
    agentClis: { prefix: "/home/me/.local" },
  });

  if (!parsed.cliproxyapi || !parsed.agentClis) throw new Error("config");

  return { cpa: parsed.cliproxyapi, clis: parsed.agentClis };
};

describe("agent CLI installs", () => {
  test("unlisted install scripts fail the install; an empty list runs none", () => {
    const { clis } = settings(root);

    const command = npmInstallCommand(
      clis,
      [{ name: "@openai/codex", version: "1.0.0" }],
      old,
    );

    expect(command).toContain(
      "--allow-scripts=@opencode/cli,@anthropic-ai/claude-code,protobufjs,koffi",
    );
    expect(command).toContain("--strict-allow-scripts");
    expect(command).not.toContain("--ignore-scripts");
    expect(command).toContain(`--before=${old}`);
    const none = npmInstallCommand({ ...clis, allowScripts: [] }, [], old);
    expect(none).toContain("--ignore-scripts");
    expect(none.some((arg) => arg.startsWith("--allow-scripts"))).toBe(false);
  });

  test("a rollback reuses the cutoff of the previous install, never now", () => {
    const plan = {
      before: "2.2.7",
      beforePublished: "2026-10-01T00:00:00.000Z",
    };

    expect(
      restoreCutoff(plan, {
        version: "2.2.7",
        before: "2026-10-20T00:00:00.000Z",
      }),
    ).toBe("2026-10-20T00:00:00.000Z");
    // Recorded for another version: fall back to the version's publication.
    expect(
      restoreCutoff(plan, {
        version: "2.2.6",
        before: "2026-09-20T00:00:00.000Z",
      }),
    ).toBe("2026-10-01T00:00:00.000Z");
    expect(() =>
      restoreCutoff({ before: "2.2.7", beforePublished: null }, undefined),
    ).toThrow("install-failed");
  });
});

describe("CLIProxyAPI asset pinning", () => {
  const prepare = async (dir: string) => {
    const { cpa } = settings(dir);
    const candidate = await cliProxyCandidate(cpa, now);

    if (!candidate) throw new Error("no candidate");

    return cliProxyPrepare(
      cpa,
      candidate,
      join(dir, "staging"),
      processRunner,
      AbortSignal.timeout(10_000),
    );
  };

  test("installs the executable after its GitHub digest matches", async () => {
    const dir = await mkdtemp(join(root, "ok-"));
    asset = tarball([
      { path: "cli-proxy-api", data: "new-binary", mode: 0o755 },
      { path: "README.md", data: "docs" },
    ]);
    digest = sha(asset);
    const result = await prepare(dir);
    expect(result.asset).toBe(digest);
    const installed = binaryPath(settings(dir).cpa, "8.0.60");
    expect(await readFile(installed, "utf8")).toBe("new-binary");
    expect((await stat(installed)).mode & 0o777).toBe(0o700);
    expect(result.binary).toBe(sha(new TextEncoder().encode("new-binary")));
  });

  test("a replaced asset, a missing digest or an escaping archive fails closed", async () => {
    const dir = await mkdtemp(join(root, "bad-"));
    asset = tarball([{ path: "cli-proxy-api", data: "evil" }]);
    digest = "0".repeat(64);
    await expect(prepare(dir)).rejects.toThrow("checksum-mismatch");
    digest = "";
    await expect(prepare(dir)).rejects.toThrow("checksum-mismatch");
    asset = tarball([
      { path: "cli-proxy-api", data: "x" },
      { path: "plugins", type: "2", link: "../../outside" },
    ]);
    digest = sha(asset);
    await expect(prepare(dir)).rejects.toThrow("archive-invalid");
    asset = tarball([{ path: "README.md", data: "no binary" }]);
    digest = sha(asset);
    await expect(prepare(dir)).rejects.toThrow("archive-invalid");
    expect(
      await stat(binaryPath(settings(dir).cpa, "8.0.60")).catch(() => null),
    ).toBeNull();
  });

  test("never replaces a different binary already installed for that version", async () => {
    const dir = await mkdtemp(join(root, "existing-"));
    const target = binaryPath(settings(dir).cpa, "8.0.60");
    await mkdir(join(dir, "8.0.60"));
    await writeFile(target, "running-binary", { mode: 0o700 });
    asset = tarball([{ path: "cli-proxy-api", data: "new-binary" }]);
    digest = sha(asset);
    await expect(prepare(dir)).rejects.toThrow("checksum-mismatch");
    expect(await readFile(target, "utf8")).toBe("running-binary");
  });

  test("an installed binary that is a hard link is refused", async () => {
    const dir = await mkdtemp(join(root, "hardlink-"));
    const target = binaryPath(settings(dir).cpa, "8.0.60");
    await mkdir(join(dir, "8.0.60"));
    // Same bytes, but shared with a file another process can rewrite.
    await writeFile(join(dir, "shared"), "new-binary", { mode: 0o700 });
    await link(join(dir, "shared"), target);
    asset = tarball([{ path: "cli-proxy-api", data: "new-binary" }]);
    digest = sha(asset);
    await expect(prepare(dir)).rejects.toThrow("archive-invalid");
  });
});
