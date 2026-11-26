import { sign } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Schema } from "effect";
import {
  type GitHubAdapter,
  type GitHubScope,
  check,
  field,
  text,
} from "./github-wire";

const api = "https://api.github.com";

const custody = Schema.Struct({
  home: Schema.String,
  login: Schema.String,
  role: Schema.Literals(["captain", "rear_admiral"]),
  contents: Schema.Literals(["read", "write"]),
  directPublication: Schema.Boolean,
  protectedBranches: Schema.optionalKey(Schema.Array(Schema.String)),
  repos: Schema.Record(
    Schema.String,
    Schema.Struct({
      owner: Schema.String,
      name: Schema.String,
      mergeCheckout: Schema.optionalKey(Schema.String),
    }),
  ),
});

const registry = Schema.fromJsonString(Schema.Record(Schema.String, custody));

const metadata = Schema.fromJsonString(
  Schema.Struct({
    installationId: Schema.Int,
    appId: Schema.optionalKey(Schema.Int),
    clientId: Schema.optionalKey(Schema.String),
  }),
);

const safePart = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const gitOptions = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.askPass=",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
];

function encode(value: string) {
  return Buffer.from(value).toString("base64url");
}

async function protectedFile(path: string, uid: number, privateFile: boolean) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  try {
    const info = await file.stat();

    check(
      info.isFile() &&
        info.uid === uid &&
        (info.mode & (privateFile ? 0o077 : 0o022)) === 0 &&
        info.size > 0 &&
        info.size <= 128_000,
      "Installed GitHub custody file is unavailable.",
    );
    const raw = await file.readFile();

    check(raw.length === info.size, "GitHub custody file changed.");

    return raw.toString("utf8");
  } finally {
    await file.close();
  }
}

async function protectedRegistry(path: string) {
  check(isAbsolute(path), "Configure an absolute GitHub registry path.");
  let parent = dirname(path);

  for (;;) {
    const info = await lstat(parent);

    check(
      info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0,
      "GitHub registry directory is not protected.",
    );
    const next = dirname(parent);

    if (next === parent) {
      break;
    }

    parent = next;
  }

  return Schema.decodeUnknownSync(registry)(
    await protectedFile(path, 0, false),
  );
}

async function responseBytes(response: Response, limit: number) {
  const reader = response.body?.getReader();

  check(reader, "GitHub returned no response body.");
  let size = 0;
  const chunks: Uint8Array[] = [];

  try {
    for (;;) {
      const read = await reader.read();

      if (read.done) {
        return Buffer.concat(chunks, size);
      }

      size += read.value.length;

      if (size > limit) {
        await reader.cancel();
        throw new Error("GitHub response exceeded its limit.");
      }

      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function request(path: string, token: string, options: RequestInit) {
  const headers = new Headers(options.headers);

  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "stargate-github-officer");

  return fetch(new URL(path, api), {
    ...options,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}

export function permissions(scope: GitHubScope) {
  const granted: Record<string, string> = {
    metadata: "read",
    contents: "read",
  };

  if (["push", "publish", "merge"].includes(scope)) {
    granted["contents"] = "write";
  }

  if (
    ["read", "pr-status", "pr", "review", "merge", "enqueue"].includes(scope)
  ) {
    granted["pull_requests"] =
      scope === "pr" || scope === "review" ? "write" : "read";
  }

  if (scope === "pr-status") {
    granted["checks"] = "read";
    granted["statuses"] = "read";
  }

  return granted;
}

async function git(
  directory: string,
  args: string[],
  home: string,
  token?: string,
) {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };

  if (token) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("x-access-token:" + token).toString("base64")}`,
    });
  }

  const child = Bun.spawn(
    ["/usr/bin/git", ...gitOptions, "-C", directory, ...args],
    {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(120_000),
    },
  );

  const [output, status] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);

  check(
    status === 0 && output.length <= 64_000,
    "Git operation refused or unconfirmed. Inspect remote state.",
  );

  return output.trim();
}

export async function createAdapter(
  repository: string,
): Promise<GitHubAdapter> {
  const actor = userInfo();
  const uid = actor.uid;

  check(uid > 0, "Run as an installed officer.");

  const current = (
    await protectedRegistry(text(process.env["STARGATE_GITHUB_APP_CONFIG"]))
  )[actor.username];

  check(current, "Use an installed officer with a configured GitHub App.");
  const selected = current.repos[repository];

  check(
    selected && safePart.test(selected.owner) && safePart.test(selected.name),
    "Select an assigned GitHub project key.",
  );
  const repo = selected;
  const directory = join(current.home, ".config/subspace");
  const writable = current.role === "captain" && current.contents === "write";
  const directPublication = current.directPublication;
  const base = `/repos/${repo.owner}/${repo.name}`;
  const tokens = new Map<GitHubScope, Promise<string>>();

  async function mint(scope: GitHubScope) {
    const app = Schema.decodeUnknownSync(metadata)(
      await protectedFile(join(directory, "github-app.json"), uid, true),
    );

    const key = await protectedFile(
      join(directory, "github-app.pem"),
      uid,
      true,
    );

    const now = Math.floor(Date.now() / 1000);
    const issuer = app.clientId ?? app.appId;

    check(
      issuer !== undefined && app.installationId > 0,
      "GitHub App identity is unavailable.",
    );

    const jwt =
      encode('{"alg":"RS256","typ":"JWT"}') +
      "." +
      encode(
        JSON.stringify({
          iat: now - 60,
          exp: now + 540,
          iss: String(issuer),
        }),
      );

    const signature = sign("RSA-SHA256", Buffer.from(jwt), key).toString(
      "base64url",
    );

    const result = await request(
      `/app/installations/${app.installationId}/access_tokens`,
      `${jwt}.${signature}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          permissions: permissions(scope),
          repositories: [repo.name],
        }),
      },
    );

    check(result.ok, "GitHub refused the configured App identity.");

    const parsed: unknown = JSON.parse(
      (await responseBytes(result, 65_536)).toString("utf8"),
    );

    const token = text(field(parsed, "token"));

    check(
      /^[A-Za-z0-9_.-]{10,4096}$/.test(token),
      "Invalid installation receipt.",
    );

    return token;
  }

  function token(key: string, scope: GitHubScope) {
    check(key === repository, "Request leaves the assigned GitHub project.");
    check(
      (scope !== "push" && scope !== "publish") || directPublication,
      "Checkout publication is delegated to crew.",
    );
    check(
      scope !== "enqueue" &&
        (scope !== "merge" || repo.mergeCheckout) &&
        (writable ||
          scope === "check" ||
          scope === "read" ||
          scope === "pr-status"),
      "GitHub access is restricted by the installed policy.",
    );
    let pending = tokens.get(scope);

    if (!pending) {
      pending = mint(scope);
      tokens.set(scope, pending);
    }

    return pending;
  }

  function route(path: string) {
    const url = new URL(path, api);

    check(
      url.origin === api &&
        (url.pathname === "/graphql" ||
          url.pathname === base ||
          url.pathname.startsWith(base + "/")),
      "Request leaves the assigned GitHub repository.",
    );

    return url.pathname + url.search;
  }

  const policy: GitHubAdapter["policy"] = {
    organization: repo.owner,
    repositoryNames: { [repository]: repo.name },
    caller: String(uid),
    app: current.login.replace(/\[bot\]$/, ""),
    rank: current.role,
    home: current.home,
    readRepositories: [repository],
    writeRepositories: writable ? [repository] : [],
    mergeRepositories: repo.mergeCheckout ? [repository] : [],
    reviewMarker: "stargate-review-v1:",
    captains: {},
    reviewModels: {},
    protectedBranches: current.protectedBranches ?? [
      "main",
      "master",
      "release/*",
    ],
  };

  if (repo.mergeCheckout) {
    policy.squashCheckout = repo.mergeCheckout;
  }

  return {
    policy,
    async json(key, scope, path, options = {}) {
      const init: RequestInit = {
        method: options.method ?? (options.body ? "POST" : "GET"),
        headers: { Accept: "application/json" },
      };

      if (options.body) {
        init.body = JSON.stringify(options.body);
        init.headers = {
          Accept: "application/json",
          "Content-Type": "application/json",
        };
      }

      const response = await request(
        route(path),
        await token(key, scope),
        init,
      );

      if (!response.ok) {
        await response.body?.cancel();

        if (options.allowMissing && response.status === 404) {
          return null;
        }

        throw new Error("GitHub refused the operation.");
      }

      return JSON.parse(
        (await responseBytes(response, 2 * 1024 * 1024)).toString("utf8"),
      ) as unknown;
    },
    async diff(key, scope, path, limit) {
      const response = await request(route(path), await token(key, scope), {
        headers: {
          Accept: "application/vnd.github.v3.diff",
          "Accept-Encoding": "identity",
        },
      });

      check(response.status === 200, "GitHub did not return a complete diff.");

      return responseBytes(response, limit);
    },
    async git(directory, args, publish) {
      return git(
        directory,
        args,
        current.home,
        publish ? await token(publish, "push") : undefined,
      );
    },
    proof() {
      throw new Error(
        "This fleet has no configured native review proof provider.",
      );
    },
    proofs() {
      return Promise.resolve([]);
    },
  };
}
