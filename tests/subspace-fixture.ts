import { X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { jwtVerify } from "jose";
import pino, { type Logger } from "pino";
import { subspaceAgentsSchema } from "../src/config/composition";
import type { Ownership } from "../src/lib/unix-socket";

/** A synthetic one-time token: never a real credential. */
export const ENROLMENT_TOKEN = "senr1.example-enrolment-token";

const directories: string[] = [];

export async function removeDirectories() {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A private (0700) directory with a resolved path, as the gateway needs. */
export async function privateDirectory(prefix = "stargate-subspace-") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  directories.push(directory);

  return directory;
}

/** A child directory with an exact mode, for socket directory checks. */
export async function childDirectory(
  parent: string,
  name: string,
  mode: number,
) {
  const directory = join(parent, name);
  await mkdir(directory);
  await chmod(directory, mode);

  return directory;
}

/** Util-linux flock is absent on some development hosts; Python's is not. */
export const ownership: Ownership = {
  lockCommand: (path) => ({
    command: "python3",
    args: [
      "-u",
      "-c",
      "import fcntl,sys;f=open(sys.argv[1]);fcntl.flock(f,fcntl.LOCK_EX);print('R',flush=True);sys.stdin.read()",
      path,
    ],
  }),
};

export function capturedLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];

  const log = pino(
    { level: "debug" },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );

  return { log, lines };
}

export type Recorded = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

/** A local stand-in for the Subspace API that records what reaches it. */
export class StubApi {
  public readonly requests: Recorded[] = [];
  public handler: (request: Recorded) => Response | Promise<Response> = () =>
    Response.json({ ok: true });
  private readonly server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (incoming) => {
      const url = new URL(incoming.url);

      const recorded = {
        method: incoming.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(incoming.headers.entries()),
        body: await incoming.text(),
      };

      this.requests.push(recorded);

      return this.handler(recorded);
    },
  });

  public get url() {
    return `http://127.0.0.1:${this.server.port}`;
  }

  public stop() {
    return this.server.stop(true);
  }
}

/** An enabled section for the given officers, decoded as configuration is. */
export function section(
  apiUrl: string,
  officers: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) {
  return Schema.decodeUnknownSync(subspaceAgentsSchema)({
    enabled: true,
    api: { baseUrl: apiUrl, timeoutSeconds: 2 },
    enrolment: { tokenEnv: "SUBSPACE_ENROLMENT" },
    officers,
    ...extra,
  });
}

export const captain = (name: string, more: Record<string, unknown> = {}) => ({
  name,
  rank: "captain",
  ship: `${name}-ship`,
  model: "example-model",
  ircNick: name,
  ...more,
});

/** The API's answer to an enrolment, echoing the certificate's fingerprint. */
export function enrolled(recorded: Recorded, status = 201) {
  const body = JSON.parse(recorded.body) as {
    certificate: string;
    name: string;
  };

  const fingerprint = new X509Certificate(body.certificate).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();

  return Response.json(
    {
      agentId: `agent-${body.name}`,
      credentialId: `credential-${fingerprint.slice(0, 8)}`,
      fingerprint,
    },
    { status },
  );
}

/** Verifies an agent token with the certificate's own public key. */
export async function verifyAgentToken(
  token: string,
  certificate: string,
  audience: string,
) {
  const publicKey = new X509Certificate(certificate).publicKey;

  return jwtVerify(token, publicKey, {
    issuer: "subspace-agent",
    audience,
    typ: "subspace-agent+jwt",
    algorithms: ["EdDSA", "ES256"],
  });
}

export const bearer = (recorded: Recorded) =>
  (recorded.headers["authorization"] ?? "").replace(/^Bearer /, "");

export type SocketAnswer = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** A raw request over a Unix socket: the target is sent exactly as given. */
export function overSocket(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<SocketAnswer> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { socketPath, method, path, headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.once("error", reject);
      },
    );

    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
