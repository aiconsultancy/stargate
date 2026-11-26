import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureUser = process.env["STARGATE_TEST_APP_USER"];

test.skipIf(
  process.platform !== "linux" || process.getuid?.() !== 0 || !fixtureUser,
)(
  "the local App reads protected custody and mints only the configured repository scope",
  async () => {
    const user = fixtureUser ?? "";
    const uid = Number((await Bun.$`id -u ${user}`.quiet()).text());
    const gid = Number((await Bun.$`id -g ${user}`.quiet()).text());
    const root = mkdtempSync("/opt/stargate-app-test-");
    const registry = join(root, "registry.json");
    const badRegistry = join(root, "replaceable.json");
    const home = join(root, "officer");
    const files = join(home, ".config", "subspace");
    const privateKey = join(files, "github-app.pem");
    const metadata = join(files, "github-app.json");
    const runner = join(root, "runner.ts");

    const module = fileURLToPath(
      new URL("../scripts/github-local-app.ts", import.meta.url),
    );

    try {
      chmodSync(root, 0o755);
      mkdirSync(files, { recursive: true, mode: 0o755 });
      chownSync(home, uid, gid);
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      writeFileSync(
        privateKey,
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      );
      writeFileSync(
        metadata,
        JSON.stringify({ clientId: "fixture-client", installationId: 17 }),
        { mode: 0o600 },
      );
      chownSync(privateKey, uid, gid);
      chownSync(metadata, uid, gid);

      const configuration = JSON.stringify({
        [user]: {
          home,
          login: "fixture-app[bot]",
          role: "rear_admiral",
          contents: "read",
          directPublication: false,
          protectedBranches: ["main"],
          repos: { project: { owner: "example", name: "project" } },
        },
      });

      writeFileSync(registry, configuration, { mode: 0o644 });
      writeFileSync(badRegistry, configuration, { mode: 0o644 });
      chmodSync(badRegistry, 0o666);
      writeFileSync(
        runner,
        `
import { createAdapter } from ${JSON.stringify(module)};
import { strict as assert } from "node:assert";
const validRegistry = ${JSON.stringify(registry)};
process.env.STARGATE_GITHUB_APP_CONFIG = ${JSON.stringify(badRegistry)};
await assert.rejects(createAdapter("project"), /custody file/);
process.env.STARGATE_GITHUB_APP_CONFIG = validRegistry;
await assert.rejects(createAdapter("unassigned"), /assigned GitHub project/);
const requests = [];
globalThis.fetch = async (target, config) => {
  const endpoint = new URL(target);
  assert.equal(endpoint.origin, "https://api.github.com");
  assert.equal(config.redirect, "error");
  assert.ok(new Headers(config.headers).get("authorization")?.startsWith("Bearer "));
  requests.push(endpoint.pathname);
  if (endpoint.pathname === "/app/installations/17/access_tokens") {
    assert.deepEqual(JSON.parse(config.body), { permissions: { metadata: "read", contents: "read" }, repositories: ["project"] });
    return Response.json({ token: "fixture-read-token" });
  }
  assert.equal(endpoint.pathname, "/repos/example/project");
  return Response.json({ full_name: "example/project" });
};
const adapter = await createAdapter("project");
await assert.rejects(adapter.json("project", "publish", "/graphql"), /delegated to crew/);
await assert.rejects(adapter.json("project", "check", "/repos/example/project/../other"), /repository/);
assert.equal(requests.length, 0);
assert.deepEqual(await adapter.json("project", "check", "/repos/example/project"), { full_name: "example/project" });
assert.deepEqual(requests, ["/app/installations/17/access_tokens", "/repos/example/project"]);
`,
      );

      const child = Bun.spawn(
        [
          "/usr/sbin/runuser",
          "-u",
          user,
          "--",
          process.execPath,
          "--config=/dev/null",
          "--no-env-file",
          "--no-install",
          runner,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );

      const [status, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
