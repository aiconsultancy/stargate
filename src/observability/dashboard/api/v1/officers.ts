import { once } from "node:events";
import { type Stats, lstatSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { dirname } from "node:path";

/**
 * Officers read the whole fleet's Fleet API, read-only and with no token,
 * through a socket in each officer's own directory: the directory's group
 * (the officer's engine group) is the identity. See docs/api.md#officers.
 */
export type OfficerSocket = { officer: string; socketPath: string };

/** A refusal about an officer's socket directory; names the officer. */
export class OfficerSocketError extends Error {}

/**
 * The path of an officer's request target, or undefined. Only origin-form
 * `/api/v1/` targets, exactly as normalised: no dot segment, doubled slash,
 * encoded slash, encoded dot, NUL, backslash or fragment. A query is ignored.
 */
export function officerTarget(target: string) {
  if (!target.startsWith("/") || target.startsWith("//")) {
    return;
  }

  const query = target.indexOf("?");
  const path = query === -1 ? target : target.slice(0, query);

  if (/[\\#]|%(?:2f|5c|2e|00)/i.test(path)) {
    return;
  }

  if (!URL.canParse(target, "http://officer.invalid")) {
    return;
  }

  const url = new URL(target, "http://officer.invalid");

  if (
    url.origin !== "http://officer.invalid" ||
    url.pathname !== path ||
    path.includes("//") ||
    !path.startsWith("/api/v1/")
  ) {
    return;
  }

  return path;
}

/**
 * Each officer's socket directory, checked before anything listens: a real
 * directory that gives others no access, whose group (when it has access)
 * admits no other officer's directory. Ownership and safe ancestors are
 * checked again when the socket is bound.
 */
export function officerDirectories(sockets: readonly OfficerSocket[]) {
  const groups = new Map<number, string>();
  const directories = new Map<string, Stats>();

  for (const { officer, socketPath } of sockets) {
    let stats: Stats;

    try {
      stats = lstatSync(dirname(socketPath));
    } catch {
      throw new OfficerSocketError(
        `${officer}'s socket directory is missing; create it before the gateway starts`,
      );
    }

    if (!stats.isDirectory() || (stats.mode & 0o007) !== 0) {
      throw new OfficerSocketError(
        `${officer}'s socket directory must give others no access (for example mode 2750)`,
      );
    }

    if ((stats.mode & 0o070) !== 0) {
      const other = groups.get(stats.gid);

      if (other !== undefined) {
        throw new OfficerSocketError(
          `The socket directories of ${other} and ${officer} share a group; give each officer's engine its own`,
        );
      }

      groups.set(stats.gid, officer);
    }

    directories.set(socketPath, stats);
  }

  return directories;
}

/**
 * Without the setgid bit some systems give a socket the gateway's own group,
 * and the officer could not connect; say so instead of failing quietly.
 */
export function checkOfficerSocketGroup(
  { officer, socketPath }: OfficerSocket,
  directory: Stats,
) {
  if (
    (directory.mode & 0o070) !== 0 &&
    lstatSync(socketPath).gid !== directory.gid
  ) {
    throw new OfficerSocketError(
      `${officer}'s Fleet API socket did not get its directory's group; set the directory's setgid bit (mode 2750)`,
    );
  }
}

/** Longer than the Fleet API's own request deadline and stream heartbeat. */
const socketIdleMs = 60_000;
const maxErrorBytes = 64 * 1024;

function get(socketPath: string, path: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        path,
        method: "GET",
        agent: false,
        timeout: socketIdleMs,
        headers: { accept: "application/json, text/event-stream" },
      },
      resolve,
    );

    outgoing.once("timeout", () => {
      outgoing.destroy(new Error("timeout"));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

/** The status and, for the gateway's own refusals, their fixed code. */
async function failureText(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    size += buffer.length;

    if (size > maxErrorBytes) {
      break;
    }

    chunks.push(buffer);
  }

  let code: unknown;

  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    code =
      typeof value === "object" && value !== null && "code" in value
        ? value.code
        : undefined;
  } catch {
    // The Fleet API's own refusals have no body: the status alone.
  }

  return `The Fleet API answered HTTP ${response.statusCode ?? 0}${typeof code === "string" ? ` (${code.slice(0, 64)})` : ""}`;
}

export type FleetRequestOptions = {
  socketPath: string;
  path: string;
  /** Receives the response body as it arrives. */
  output: NodeJS.WritableStream;
  report(text: string): void;
};

/**
 * One Fleet API read through the officer's socket, for an officer or its
 * crew. The body goes to `output` as it arrives (an event stream until the
 * gateway closes it); the exit code is 0 for a 2xx answer, 1 otherwise and 2
 * for a path that is not a Fleet API path.
 */
export async function runFleetRequest(options: FleetRequestOptions) {
  if (officerTarget(options.path) === undefined) {
    options.report(
      "The path must be a Fleet API path such as /api/v1/fleet, /api/v1/ships/{id} or /api/v1/ships/{id}/crew/{member}",
    );

    return 2;
  }

  let response: IncomingMessage;

  try {
    response = await get(options.socketPath, options.path);
  } catch {
    options.report(
      "The officer's Fleet API socket is unavailable: is the gateway running, and is this the officer's own fleet.sock?",
    );

    return 1;
  }

  const status = response.statusCode ?? 0;

  if (status < 200 || status >= 300) {
    options.report(await failureText(response));

    return 1;
  }

  try {
    for await (const chunk of response) {
      if (!options.output.write(chunk as Buffer)) {
        await once(options.output, "drain");
      }
    }
  } catch {
    options.report("The Fleet API answer was cut short");

    return 1;
  }

  return 0;
}
