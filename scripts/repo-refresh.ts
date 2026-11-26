import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { TextDecoder, parseArgs } from "node:util";
import { Result, Schema } from "effect";

const refreshTool = "refresh_origin";
const readTool = "read_origin_file";
const refspec = "+refs/heads/*:refs/remotes/origin/*";
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const tools = [
  {
    name: refreshTool,
    description: "Fetch current origin refs for an assigned repository.",
    inputSchema: {
      type: "object",
      properties: { repository: { type: "string" } },
      required: ["repository"],
      additionalProperties: false,
    },
  },
  {
    name: readTool,
    description:
      "Read lines and the verified commit from a fetched origin branch. Pass the returned commit and nextLine as startLine to continue.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string" },
        branch: { type: "string" },
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        commit: {
          type: "string",
          description: "Commit returned by the initial read.",
        },
      },
      required: ["repository", "branch", "path"],
      additionalProperties: false,
    },
  },
];

const refreshArgs = Schema.Struct({ repository: Schema.String });

const readArgs = Schema.Struct({
  repository: Schema.String,
  branch: Schema.String,
  path: Schema.String,
  startLine: Schema.optionalKey(Schema.Int),
  commit: Schema.optionalKey(Schema.String),
});

const decodeOperation = Schema.decodeUnknownResult(
  Schema.Union([
    Schema.Struct({ tool: Schema.Literal(refreshTool), args: refreshArgs }),
    Schema.Struct({ tool: Schema.Literal(readTool), args: readArgs }),
  ]),
  { onExcessProperty: "error" },
);

const decodeMcp = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(
        Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])),
      ),
      method: Schema.String,
      params: Schema.optionalKey(
        Schema.Struct({
          name: Schema.optionalKey(Schema.String),
          arguments: Schema.optionalKey(Schema.Unknown),
          protocolVersion: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);

const installedJob = Schema.Struct({
  request: Schema.Unknown,
  checkout: Schema.String,
  origin: Schema.String,
  expectedOrigin: Schema.String,
  gitOptions: Schema.Array(Schema.String),
  gitEnvironment: Schema.Record(Schema.String, Schema.String),
  gitRunner: Schema.Array(Schema.String),
});

const decodeJob = Schema.decodeUnknownSync(Schema.fromJsonString(installedJob));

const relayResponse = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

function runGit(args: string[], env: NodeJS.ProcessEnv) {
  const [command, ...arguments_] = args;

  if (!command) {
    throw new Error("Git runner is unavailable.");
  }

  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      command,
      arguments_,
      { timeout: 90_000, maxBuffer: 512_000, encoding: "buffer", env },
      (error, stdout) => {
        if (error) {
          reject(new Error("Git operation failed.", { cause: error }));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

const unavailable = {
  error:
    "The repository tool is unavailable. Check the origin refs before repeating a refresh.",
};

const failed = {
  error:
    "Repository operation failed. Check the repository key, branch and path or report the error to the operator.",
};

type Git = (...args: string[]) => Promise<string>;

export function operation(tool: unknown, args: unknown) {
  const parsed = decodeOperation({ tool, args });

  if (
    Result.isFailure(parsed) ||
    !repositoryPattern.test(parsed.success.args.repository)
  ) {
    throw new Error("Use a configured repository key.");
  }

  if (parsed.success.tool === readTool) {
    const { branch, path, startLine = 1 } = parsed.success.args;

    if (
      !branch ||
      branch.length > 200 ||
      branch === "HEAD" ||
      !path ||
      path.length > 500 ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      Array.from(path).some(
        (character) =>
          character < " " || character === ":" || character === "\\",
      ) ||
      startLine < 1 ||
      startLine > 500_000
    ) {
      throw new Error("Use a branch name and a relative file path for reads.");
    }
  }

  return parsed.success;
}

function verifiedSha(value: string) {
  if (!shaPattern.test(value)) {
    throw new Error("Git did not return a commit SHA.");
  }

  return value;
}

export async function readOriginFile(
  git: Git,
  branch: string,
  path: string,
  startLine = 1,
  requestedCommit?: string,
) {
  for (const part of path.split("/")) {
    if (
      part !== ".env.example" &&
      /(?:\.env(?:\..*)?|^\.(?:npmrc|netrc)|^id_(?:rsa|dsa|ecdsa|ed25519)|^credentials\.json|\.(?:pem|key|p12|pfx))$/i.test(
        part,
      )
    ) {
      throw new Error("The file matches a restricted credential filename.");
    }
  }

  const ref = `refs/remotes/origin/${branch}`;

  await git("check-ref-format", ref);

  const head = verifiedSha(
    await git("rev-parse", "--verify", `${ref}^{commit}`),
  );

  const commit =
    requestedCommit === undefined ? head : verifiedSha(requestedCommit);

  if (commit !== head) {
    await git("merge-base", "--is-ancestor", commit, head);
  }

  const blob = `${commit}:${path}`;
  const type = await git("cat-file", "-t", blob);
  const size = Number(await git("cat-file", "-s", blob));

  if (
    type !== "blob" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > 500_000
  ) {
    throw new Error("The path must name a text file no larger than 500 KB.");
  }

  const text = await git("cat-file", "blob", blob);

  if (text.includes("\0") || Buffer.byteLength(text) !== size) {
    throw new Error("The file is binary.");
  }

  // Preserve line numbers for LF, CRLF and legacy CR text.
  const lines = text.split(/\r\n?|\n/u);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  const chunk: string[] = [];
  let remaining = 4000;

  for (const textLine of lines.slice(startLine - 1, startLine + 78)) {
    const points = Array.from(textLine);

    const line =
      points.length <= 2000
        ? textLine
        : `${points.slice(0, 2000).join("")} [line shortened]`;

    const encodedLength = JSON.stringify(line).replace(
      /[\u007f-\uffff]/gu,
      "\\u0000",
    ).length;

    if (chunk.length > 0 && encodedLength > remaining) {
      break;
    }

    chunk.push(line);
    remaining -= encodedLength;
  }

  const following = startLine + chunk.length;

  return {
    commit,
    startLine,
    lines: chunk,
    nextLine: following <= lines.length ? following : null,
  };
}

async function originRefs(git: Git) {
  const list = await git(
    "for-each-ref",
    "--format=%(if)%(symref)%(then)%(else)%(refname:strip=2) %(objectname)%(end)",
    "refs/remotes/origin/",
  );

  const refs = new Map<string, string>();

  for (const line of list.split("\n")) {
    const ref = /^([^ ]+) ([a-f0-9]+)$/.exec(line);

    if (ref?.[1] && ref[2]) {
      refs.set(ref[1], verifiedSha(ref[2]));
    }
  }

  return refs;
}

export async function refreshRefs(
  git: Git,
  origin: string,
  expectedOrigin: string,
) {
  const remote = URL.parse(origin);

  if (
    !(
      origin.startsWith("/") &&
      Array.from(origin).every((character) => character.charCodeAt(0) >= 32)
    ) &&
    !(
      remote &&
      ["https:", "http:"].includes(remote.protocol) &&
      !remote.username &&
      !remote.password &&
      !remote.search &&
      !remote.hash
    )
  ) {
    throw new Error("The source URL must not carry credentials or options.");
  }

  if ((await git("remote", "get-url", "origin")) !== expectedOrigin) {
    throw new Error(
      "The checkout origin does not match the configured repository.",
    );
  }

  const checkoutHead = verifiedSha(await git("rev-parse", "HEAD"));
  const before = await originRefs(git);

  await git(
    "fetch",
    "--atomic",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "--prune",
    "--no-prune-tags",
    "--refmap=",
    "--",
    origin,
    refspec,
  );

  if (verifiedSha(await git("rev-parse", "HEAD")) !== checkoutHead) {
    throw new Error("The checkout changed during the refresh.");
  }

  const after = await originRefs(git);

  const updated = Array.from(after).filter(
    ([name, sha]) => before.get(name) !== sha,
  );

  const deleted = Array.from(before.keys())
    .filter((name) => !after.has(name))
    .toSorted();

  return {
    checkoutHead,
    updatedCount: updated.length,
    updatedRefs: updated.slice(0, 25).map(([name, sha]) => `${name} ${sha}`),
    deletedCount: deleted.length,
    deletedRefs: deleted.slice(0, 25),
  };
}

export async function execute(input: string) {
  const job = decodeJob(input);

  const envelope = Schema.decodeUnknownSync(
    Schema.Struct({ tool: Schema.String, args: Schema.Unknown }),
  )(job.request);

  const request = operation(envelope.tool, envelope.args);

  const git: Git = async (...args) => {
    const stdout = await runGit(
      [
        ...job.gitRunner,
        "/usr/bin/git",
        ...job.gitOptions,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        "-c",
        "fetch.recurseSubmodules=false",
        "-c",
        "http.followRedirects=false",
        "-c",
        "fetch.writeCommitGraph=false",
        "-C",
        job.checkout,
        ...args,
      ],
      job.gitEnvironment,
    );

    const output = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(stdout);

    return args[0] === "cat-file" && args[1] === "blob"
      ? output
      : output.trim();
  };

  if (
    (await git("rev-parse", "--absolute-git-dir")) !== `${job.checkout}/.git`
  ) {
    throw new Error("The checkout does not own its Git metadata.");
  }

  const result =
    request.tool === refreshTool
      ? await refreshRefs(git, job.origin, job.expectedOrigin)
      : await readOriginFile(
          git,
          request.args.branch,
          request.args.path,
          request.args.startLine,
          request.args.commit,
        );

  return { repository: request.args.repository, ...result };
}

async function* lines(stream: AsyncIterable<unknown>, maximum: number) {
  let pending = Buffer.alloc(0);

  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("Use a byte stream.");
    }

    let start = 0;

    while (start < chunk.length) {
      const end = chunk.indexOf(10, start) + 1;
      const piece = chunk.subarray(start, end === 0 ? chunk.length : end);

      if (pending.length + piece.length > maximum) {
        return;
      }

      pending = Buffer.concat([pending, piece]);

      if (end === 0) {
        break;
      }

      yield pending.toString("utf8");
      pending = Buffer.alloc(0);
      start = end;
    }
  }
}

export async function firstLine(
  stream: AsyncIterable<unknown>,
  maximum: number,
) {
  const input = lines(stream, maximum);

  try {
    const line = await input.next();

    return line.done ? undefined : line.value;
  } finally {
    await input.return(undefined);
  }
}

async function requestRelay(
  socket: string,
  payload: ReturnType<typeof operation>,
) {
  const connection = createConnection(socket);

  connection.setTimeout(105_000, () => {
    connection.destroy(new Error("Repository refresh timed out."));
  });

  try {
    connection.write(`${JSON.stringify(payload)}\n`);

    return Schema.decodeUnknownSync(relayResponse)(
      await firstLine(connection, 32_768),
    );
  } catch {
    return unavailable;
  } finally {
    connection.destroy();
  }
}

async function mcpReply(line: string, socket: string) {
  const decoded = decodeMcp(line);
  const error = { error: { code: -32_600, message: "Invalid request" } };

  if (Result.isFailure(decoded)) {
    return { jsonrpc: "2.0", id: null, ...error };
  }

  const { method, params, id } = decoded.success;

  if (id === undefined) {
    return;
  }

  let reply: { result: unknown } | typeof error = error;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const versions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

    const protocolVersion =
      requested && versions.includes(requested) ? requested : "2025-06-18";

    reply = {
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "repository-refresh", version: "1" },
      },
    };
  } else if (method === "ping") {
    reply = { result: {} };
  } else if (method === "tools/list") {
    reply = { result: { tools } };
  } else if (
    method === "tools/call" &&
    (params?.name === refreshTool || params?.name === readTool)
  ) {
    let result: Record<string, unknown>;

    try {
      result = await requestRelay(
        socket,
        operation(params.name, params.arguments),
      );
    } catch {
      result = {
        error:
          "Use a configured repository key and a relative file path for reads.",
      };
    }

    reply = {
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: "error" in result,
      },
    };
  }

  return { jsonrpc: "2.0", id, ...reply };
}

async function mcp(socket: string) {
  const requests = new Set<Promise<void>>();

  for await (const line of lines(process.stdin, 32_768)) {
    const request = mcpReply(line, socket).then((reply) => {
      if (reply) {
        process.stdout.write(`${JSON.stringify(reply)}\n`);
      }
    });

    requests.add(request);
    request.then(
      () => {
        requests.delete(request);
      },
      () => {
        requests.delete(request);
      },
    );

    if (requests.size >= 8) {
      await Promise.race(requests);
    }
  }

  await Promise.all(requests);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { socket: { type: "string" } },
    allowPositionals: true,
  });

  if (positionals[0] === "serve" && positionals[1]?.startsWith("/")) {
    const { serveRepositorySocket } = await import("./repo-refresh-host");

    await serveRepositorySocket(positionals.slice(1), {
      firstLine,
      operation,
      execute,
    });

    return;
  }

  if (
    positionals.length === 1 &&
    positionals[0] === "mcp" &&
    values.socket?.startsWith("/")
  ) {
    await mcp(values.socket);

    return;
  }

  if (
    positionals.length === 1 &&
    positionals[0] === "execute" &&
    values.socket === undefined
  ) {
    const line = await firstLine(process.stdin, 32_768);

    if (line !== undefined) {
      try {
        process.stdout.write(`${JSON.stringify(await execute(line))}\n`);
      } catch {
        process.stdout.write(`${JSON.stringify(failed)}\n`);
      }

      return;
    }
  }

  process.stderr.write(
    "Configure mcp --socket PATH, or pass one trusted job on stdin to execute.\n",
  );
  process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
