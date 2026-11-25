import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { BackendConfig } from "../config";
import type { SubspaceAgentsConfig } from "../config/composition";
import type { Ownership } from "../lib/unix-socket";
import type { AgentKey } from "./certificate";
import type { ReadChatUpload } from "../chat/attachments/attachments";
import { chatUploadReader } from "./chat-uploads";
import { enrolOfficers } from "./enrol";
import {
  DistinctCertificates,
  type OfficerFiles,
  SubspaceFileError,
  type SubspaceOfficer,
  defaultStateDirectory,
  officerFiles,
  privateStateDirectory,
  readOfficerKey,
  writeOfficerKey,
} from "./files";
import { OfficerProxy, checkSocketDirectory } from "./proxy";
import { subspaceUpstream } from "./upstream";

/** What the gateway runtime supplies when `subspaceAgents.enabled` is true. */
export type SubspaceAgentsHost = {
  config: SubspaceAgentsConfig;
  dataDirectory: string;
  log: Logger;
  /** Tests only: the API transport, environment and socket lock command. */
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  ownership?: Ownership;
};

export type SubspaceAgentsRuntime = {
  /** A gateway-launched backend's configuration with its officer's bridge. */
  backend(registration: string, backend: BackendConfig): BackendConfig;
  upload(registration: string, account: string): ReadChatUpload | undefined;
  close(): Promise<void>;
};

const stamp = (path: string) => {
  try {
    const stats = lstatSync(path);

    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch {
    return "absent";
  }
};

/** The officer's key, read again (and checked again) whenever its bundle changes. */
function currentKey(
  officer: SubspaceOfficer,
  files: OfficerFiles,
  initial: AgentKey,
) {
  let cached = { key: initial, stamp: stamp(files.bundle) };

  return async () => {
    const now = stamp(files.bundle);

    if (now !== cached.stamp) {
      const key = await readOfficerKey(officer, files);

      if (!key) {
        throw new SubspaceFileError(
          `${officer.name}'s Subspace bundle is missing`,
        );
      }

      cached = { key, stamp: now };
    }

    return cached.key;
  };
}

/** `stargate subspace mcp`, run by the officer's harness, beside this module. */
const bridge = {
  command: process.execPath,
  main: fileURLToPath(new URL("../main.ts", import.meta.url)),
};

async function prepare(host: SubspaceAgentsHost, log: Logger) {
  const section = host.config;

  const stateDirectory =
    section.stateDirectory ?? defaultStateDirectory(host.dataDirectory);

  await privateStateDirectory(stateDirectory);
  const keys = new Map<string, () => Promise<AgentKey>>();
  const certificates = new DistinctCertificates();

  // A bundle that is not private stops start-up before anything listens.
  for (const officer of section.officers) {
    const files = officerFiles(officer, stateDirectory);

    const key =
      (await readOfficerKey(officer, files)) ??
      (await writeOfficerKey(officer, files, section.keyAlgorithm));

    certificates.add(officer.name, key);
    keys.set(officer.name, currentKey(officer, files, key));
  }

  // A group that may enter one officer's socket directory must not enter another's.
  const groups = new Map<number, string>();

  for (const officer of section.officers) {
    if (!officer.socketPath) {
      continue;
    }

    const stats = checkSocketDirectory(
      dirname(officer.socketPath),
      officer.name,
    );

    if ((stats.mode & 0o070) === 0) {
      continue;
    }

    const other = groups.get(stats.gid);

    if (other !== undefined) {
      throw new SubspaceFileError(
        `The socket directories of ${other} and ${officer.name} share a group; give each officer's engine its own`,
      );
    }

    groups.set(stats.gid, officer.name);
  }

  const upstream = subspaceUpstream(section, host.env ?? process.env);
  const proxies: OfficerProxy[] = [];

  try {
    for (const officer of section.officers) {
      const key = keys.get(officer.name);

      if (!officer.socketPath || !key) {
        continue;
      }

      proxies.push(
        await OfficerProxy.open({
          officer: officer.name,
          socketPath: officer.socketPath,
          upstream,
          key,
          log: log.child({ officer: officer.name }),
          ...(host.fetch && { fetch: host.fetch }),
          ...(host.ownership && { ownership: host.ownership }),
        }),
      );
    }
  } catch (error) {
    await Promise.allSettled(proxies.map((proxy) => proxy.close()));
    throw error;
  }

  return proxies;
}

/**
 * Only called when `subspaceAgents.enabled` is true. Makes sure each officer
 * has a private bundle, opens each officer's signing proxy and enrols any
 * officer the API does not hold yet, in the background: an unreachable API
 * never holds up or stops the gateway. Files that are not private stop
 * start-up, with a log line that says why.
 */
export async function startSubspaceAgents(
  host: SubspaceAgentsHost,
): Promise<SubspaceAgentsRuntime> {
  const section = host.config;
  const log = host.log.child({ subspaceAgents: true });
  let proxies: OfficerProxy[];

  try {
    proxies = await prepare(host, log);
  } catch (error) {
    log.error(
      error instanceof SubspaceFileError
        ? error.message
        : "Subspace agent identity could not start",
    );
    throw error;
  }

  const stop = new AbortController();

  const enrolment = enrolOfficers({
    section,
    dataDirectory: host.dataDirectory,
    env: host.env ?? process.env,
    signal: stop.signal,
    ...(host.fetch && { fetch: host.fetch }),
  }).then(
    (outcomes) => {
      for (const outcome of outcomes) {
        if (outcome.state === "failed") {
          log.warn(
            { officer: outcome.name, reason: outcome.error },
            "Subspace enrolment failed; run stargate subspace enrol",
          );
        } else if (outcome.state === "enrolled") {
          log.info(
            { officer: outcome.name, fingerprint: outcome.fingerprint },
            "Subspace officer enrolled",
          );
        }
      }
    },
    (error: unknown) => {
      if (!stop.signal.aborted) {
        log.warn(
          error instanceof SubspaceFileError
            ? error.message
            : "Subspace enrolment stopped",
        );
      }
    },
  );

  log.info(
    { officers: section.officers.length, sockets: proxies.length },
    "Subspace agent identity enabled",
  );

  return {
    upload(registration, account) {
      const explicit = section.officers.find(
        (entry) => entry.registration === registration,
      );

      const matching = section.officers.filter(
        (entry) =>
          entry.registration === undefined &&
          entry.ircNick?.toLowerCase() === account.toLowerCase(),
      );

      const officer =
        explicit ?? (matching.length === 1 ? matching[0] : undefined);

      return officer?.socketPath
        ? chatUploadReader(officer.socketPath)
        : undefined;
    },
    backend(registration, backend) {
      const officer = section.officers.find(
        (entry) => entry.registration === registration,
      );

      if (!officer?.socketPath || backend.type !== "claude") {
        return backend;
      }

      return {
        ...backend,
        mcpServers: {
          ...backend.mcpServers,
          subspace: {
            type: "stdio",
            command: bridge.command,
            args: [
              bridge.main,
              "subspace",
              "mcp",
              "--socket",
              officer.socketPath,
            ],
          },
        },
      };
    },
    async close() {
      stop.abort();
      await enrolment;
      await Promise.allSettled(proxies.map((proxy) => proxy.close()));
    },
  };
}
