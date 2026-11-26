import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitOptions = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.file.allow=always",
];

function git(checkout: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function invoke(input: unknown, args: string[]) {
  return Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      "scripts/repo-refresh.ts",
      ...args,
    ],
    {
      stdin: new Blob([`${JSON.stringify(input)}\n`]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

async function result(child: ReturnType<typeof invoke>) {
  const [output, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (status !== 0 || !output) {
    throw new Error(stderr);
  }

  return output;
}

test("origin refresh and branch reads use a verified SHA without changing checkout or FETCH_HEAD", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-refresh-")));
  const origin = join(root, "upstream");
  const checkout = join(root, "reference");
  const repository = "project";

  const execute = async (tool: string, args: Record<string, unknown>) =>
    JSON.parse(
      await result(
        invoke(
          {
            request: { tool, args: { repository, ...args } },
            checkout,
            origin,
            expectedOrigin: origin,
            gitOptions,
            gitEnvironment: {
              PATH: "/usr/bin:/bin",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
            },
            gitRunner: [],
          },
          ["execute"],
        ),
      ),
    ) as unknown;

  try {
    git(root, "init", "--quiet", "--initial-branch=main", origin);
    git(origin, "config", "user.email", "fixture@example.org");
    git(origin, "config", "user.name", "Fixture");
    writeFileSync(join(origin, "proof.md"), "first\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "first");
    git(origin, "branch", "retired");
    git(root, "clone", "--quiet", origin, checkout);
    const base = git(checkout, "rev-parse", "HEAD");

    writeFileSync(join(checkout, "proof.md"), "local edit\n");
    writeFileSync(
      join(checkout, ".git", "FETCH_HEAD"),
      "keep old fetch head\n",
    );
    writeFileSync(join(origin, "proof.md"), "published\r\nread this\n");
    writeFileSync(join(origin, "api.pem"), "restricted");
    writeFileSync(join(origin, "invalid.txt"), new Uint8Array([0xff, 0xff]));
    writeFileSync(join(origin, ".env.example"), "safe example\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "publish");
    git(origin, "branch", "-D", "retired");
    git(origin, "tag", "new-tag");
    const commit = git(origin, "rev-parse", "HEAD");

    expect(await execute("refresh_origin", {})).toEqual({
      repository,
      checkoutHead: base,
      updatedCount: 1,
      updatedRefs: [`origin/main ${commit}`],
      deletedCount: 1,
      deletedRefs: ["origin/retired"],
    });
    expect(git(checkout, "rev-parse", "HEAD")).toBe(base);
    expect(git(checkout, "tag", "--list")).toBe("");
    expect(readFileSync(join(checkout, "proof.md"), "utf8")).toBe(
      "local edit\n",
    );
    expect(readFileSync(join(checkout, ".git", "FETCH_HEAD"), "utf8")).toBe(
      "keep old fetch head\n",
    );
    expect(
      await execute("read_origin_file", {
        branch: "main",
        path: "proof.md",
        startLine: 2,
      }),
    ).toEqual({
      repository,
      commit,
      startLine: 2,
      lines: ["read this"],
      nextLine: null,
    });
    writeFileSync(join(origin, "proof.md"), "unexpected newer lines\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "newer");
    await execute("refresh_origin", {});
    expect(
      await execute("read_origin_file", {
        branch: "main",
        path: "proof.md",
        startLine: 2,
        commit,
      }),
    ).toEqual({
      repository,
      commit,
      startLine: 2,
      lines: ["read this"],
      nextLine: null,
    });
    expect(
      await execute("read_origin_file", {
        branch: "main",
        path: ".env.example",
        commit,
      }),
    ).toEqual({
      repository,
      commit,
      startLine: 1,
      lines: ["safe example"],
      nextLine: null,
    });

    for (const path of [
      "api.pem",
      "invalid.txt",
      "../proof.md",
      "/proof.md",
      "bad:ref",
    ]) {
      expect(
        await execute("read_origin_file", { branch: "main", path }),
      ).toHaveProperty("error");
    }

    expect(
      await execute("read_origin_file", { branch: "HEAD", path: "proof.md" }),
    ).toHaveProperty("error");
    git(checkout, "remote", "set-url", "origin", join(root, "different"));
    expect(await execute("refresh_origin", {})).toHaveProperty("error");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}, 20_000);

test("repository MCP relays only supported operations to the configured private socket", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-tool-")));
  const socket = join(root, "ref.sock");
  const requests: unknown[] = [];

  const server = createServer((client) => {
    client.once("data", (input) => {
      requests.push(JSON.parse(input.toString("utf8")));
      client.end('{"checkoutHead":"fixture","updatedCount":0}\n');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(socket, resolve);
  });

  try {
    const request = {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "refresh_origin", arguments: { repository: "project" } },
    };

    const reply = JSON.parse(
      await result(invoke(request, ["mcp", "--socket", socket])),
    ) as unknown;

    const refused = JSON.parse(
      await result(
        invoke(
          {
            ...request,
            params: {
              ...request.params,
              arguments: { ...request.params.arguments, url: "unconfigured" },
            },
          },
          ["mcp", "--socket", socket],
        ),
      ),
    ) as unknown;

    expect(requests).toEqual([
      { tool: "refresh_origin", args: { repository: "project" } },
    ]);
    expect(reply).toMatchObject({
      id: 1,
      result: {
        isError: false,
        content: [
          { type: "text", text: '{"checkoutHead":"fixture","updatedCount":0}' },
        ],
      },
    });
    expect(refused).toMatchObject({ id: 1, result: { isError: true } });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(new Error("Could not close fixture.", { cause: error }));
        } else {
          resolve();
        }
      });
    });
    rmSync(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "socket activation proves the peer UID before reading a configured Git commit",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-host-")));
    const socket = join(root, "worker.sock");
    const configuration = join(root, "policy.ts");
    const uid = process.getuid?.() ?? -1;

    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "fixture@example.org");
    git(root, "config", "user.name", "Fixture");
    writeFileSync(join(root, "proof.md"), "verified\n");
    git(root, "add", "proof.md");
    git(root, "commit", "--quiet", "-m", "fixture");
    const commit = git(root, "rev-parse", "HEAD");

    git(root, "update-ref", "refs/remotes/origin/main", commit);

    const workers = new Set<Promise<number>>();

    const server = createServer({ pauseOnConnect: true }, (peer) => {
      const internal: unknown = Reflect.get(peer, "_handle");
      const handle = internal as { fd?: number } | null;
      const fd = handle?.fd;

      if (fd === undefined) {
        peer.destroy();

        return;
      }

      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--no-install",
          "scripts/repo-refresh.ts",
          "serve",
          "--",
          process.execPath,
          configuration,
        ],
        { stdin: fd, stdout: "ignore", stderr: "ignore" },
      );

      const worker = child.exited.finally(() => {
        peer.destroy();
      });

      workers.add(worker);
    });

    await new Promise<void>((resolve) => {
      server.listen(socket, resolve);
    });

    async function read(peerUid: number) {
      const policy = {
        checkout: root,
        checkoutUid: uid,
        callerUid: peerUid,
        origin: "https://example.test/project",
        expectedOrigin: "https://example.test/project",
        gitOptions: [],
        gitEnvironment: { PATH: "/usr/bin:/bin" },
        gitRunner: [],
      };

      writeFileSync(
        configuration,
        `if (process.argv[2] !== "read_origin_file" || process.argv[3] !== "project" ||
             process.argv[4] !== "${uid}") process.exit(99);
        console.log(${JSON.stringify(JSON.stringify(policy))});\n`,
      );
      const client = createConnection(socket);
      const answer: Buffer[] = [];

      client.write(
        `${JSON.stringify({
          tool: "read_origin_file",
          args: { repository: "project", branch: "main", path: "proof.md" },
        })}\n`,
      );

      for await (const chunk of client) {
        if (Buffer.isBuffer(chunk)) {
          answer.push(chunk);
        }
      }

      return Buffer.concat(answer).toString("utf8");
    }

    try {
      expect(JSON.parse(await read(uid))).toEqual({
        repository: "project",
        commit,
        startLine: 1,
        lines: ["verified"],
        nextLine: null,
      });
      expect(await read(uid + 1)).toBe("");
      expect(await Promise.all(workers)).toEqual([0, 0]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(new Error("Could not close fixture.", { cause: error }));
          } else {
            resolve();
          }
        });
      });
      rmSync(root, { force: true, recursive: true });
    }
  },
  15_000,
);
