import { dlopen } from "bun:ffi";
import { execFile } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";

const policyResult = Schema.fromJsonString(
  Schema.Struct({
    checkout: Schema.String,
    checkoutUid: Schema.Int,
    callerUid: Schema.Int,
    origin: Schema.String,
    expectedOrigin: Schema.String,
    gitOptions: Schema.Array(Schema.String),
    gitEnvironment: Schema.Record(Schema.String, Schema.String),
    gitRunner: Schema.Array(Schema.String),
  }),
);

const envelope = Schema.fromJsonString(
  Schema.Struct({ tool: Schema.String, args: Schema.Unknown }),
);

type SocketDependencies = {
  firstLine(
    stream: AsyncIterable<unknown>,
    maximum: number,
  ): Promise<string | undefined>;
  operation(
    tool: unknown,
    args: unknown,
  ): { tool: string; args: { repository: string } };
  execute(input: string): Promise<unknown>;
};

function readPolicy(
  command: string[],
  tool: string,
  repository: string,
  peerUid: number,
) {
  const [executable, ...args] = command;

  if (!executable) {
    throw new Error("Repository policy command is missing.");
  }

  return new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      [...args, tool, repository, String(peerUid)],
      {
        timeout: 25_000,
        maxBuffer: 32_768,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Repository policy is unavailable."));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

async function writeSocket(value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);

  if (bytes.length > 32_768) {
    throw new Error("Repository response is too large.");
  }

  const socket = createWriteStream("/dev/null", { fd: 0, autoClose: false });

  await new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function serveRepositorySocket(
  command: string[],
  dependencies: SocketDependencies,
) {
  if (process.platform !== "linux") {
    throw new Error("Systemd repository sockets need Linux.");
  }

  const libc = dlopen("libc.so.6", {
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    flock: { args: ["i32", "i32"], returns: "i32" },
  });

  try {
    // Linux SO_PEERCRED returns pid, uid and gid of the connected officer.
    const peer = new Uint32Array(3);
    const length = new Uint32Array([peer.byteLength]);

    if (
      libc.symbols.getsockopt(0, 1, 17, peer, length) !== 0 ||
      length[0] !== peer.byteLength
    ) {
      return;
    }

    const read = new AbortController();
    const stdin = process.stdin.iterator({ destroyOnReturn: false });
    let line: string | undefined;

    try {
      line = await Promise.race([
        dependencies.firstLine(stdin, 4096),
        setTimeout(5000, undefined, { signal: read.signal }),
      ]);
    } finally {
      read.abort();
    }

    const { tool, args } = Schema.decodeUnknownSync(envelope)(line);
    const request = dependencies.operation(tool, args);

    const policy = Schema.decodeUnknownSync(policyResult)(
      await readPolicy(command, tool, request.args.repository, peer[1] ?? -1),
    );

    if (policy.callerUid !== peer[1]) {
      return;
    }

    const git = join(policy.checkout, ".git");

    for (const folder of [policy.checkout, git]) {
      const info = await stat(folder);

      if (
        !info.isDirectory() ||
        info.uid !== policy.checkoutUid ||
        (info.mode & 0o022) !== 0 ||
        (await realpath(folder)) !== folder
      ) {
        throw new Error("Protected checkout ownership differs.");
      }
    }

    const directory = await open(
      git,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );

    try {
      // LOCK_EX | LOCK_NB on the existing directory inode. Keep the descriptor
      // Live across Git execution without creating a lockfile in the checkout.
      if (
        tool === "refresh_origin" &&
        libc.symbols.flock(directory.fd, 6) !== 0
      ) {
        throw new Error("Repository refresh is already running.");
      }

      const result = await dependencies.execute(
        JSON.stringify({ ...policy, request }),
      );

      await writeSocket(result);
    } finally {
      await directory.close();
    }
  } catch {
    await writeSocket({
      error:
        "Repository operation failed. Check the repository, branch and path or report it to the operator.",
    }).catch(() => {});
  } finally {
    libc.close();
    process.stdin.destroy();
  }
}
