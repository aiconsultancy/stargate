import type { Logger } from "pino";
import type { SubspaceAgentsConfig } from "../config/composition";
import { enrolOfficers } from "./enrol";
import {
  DistinctCertificates,
  SubspaceFileError,
  defaultStateDirectory,
  officerFiles,
  privateStateDirectory,
  readOfficerKey,
  writeOfficerKey,
} from "./files";

/** What the gateway runtime supplies when `subspaceAgents.enabled` is true. */
export type SubspaceAgentsHost = {
  config: SubspaceAgentsConfig;
  dataDirectory: string;
  log: Logger;
  /** Tests only: the API transport and environment. */
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

export type SubspaceAgentsRuntime = {
  close(): Promise<void>;
};

async function prepare(host: SubspaceAgentsHost) {
  const section = host.config;

  const stateDirectory =
    section.stateDirectory ?? defaultStateDirectory(host.dataDirectory);

  await privateStateDirectory(stateDirectory);

  const certificates = new DistinctCertificates();

  // A bundle that is not private, or one shared by two officers, stops start-up.
  for (const officer of section.officers) {
    const files = officerFiles(officer, stateDirectory);

    const key =
      (await readOfficerKey(officer, files)) ??
      (await writeOfficerKey(officer, files, section.keyAlgorithm));

    certificates.add(officer.name, key);
  }
}

/**
 * Only called when `subspaceAgents.enabled` is true. Makes sure each officer
 * has a private bundle, then enrols any officer the API does not hold yet,
 * in the background: an unreachable API never holds up or stops the gateway.
 * Files that are not private stop start-up, with a log line that says why.
 */
export async function startSubspaceAgents(
  host: SubspaceAgentsHost,
): Promise<SubspaceAgentsRuntime> {
  const section = host.config;
  const log = host.log.child({ subspaceAgents: true });

  try {
    await prepare(host);
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
      for (const outcome of outcomes)
        if (outcome.state === "failed")
          log.warn(
            { officer: outcome.name, reason: outcome.error },
            "Subspace enrolment failed; run stargate subspace enrol",
          );
        else if (outcome.state === "enrolled")
          log.info(
            { officer: outcome.name, fingerprint: outcome.fingerprint },
            "Subspace officer enrolled",
          );
    },
    (error: unknown) => {
      if (!stop.signal.aborted)
        log.warn(
          error instanceof SubspaceFileError
            ? error.message
            : "Subspace enrolment stopped",
        );
    },
  );

  log.info(
    { officers: section.officers.length },
    "Subspace agent identity enabled",
  );

  return {
    async close() {
      stop.abort();
      await enrolment;
    },
  };
}
