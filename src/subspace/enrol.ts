import { Result, Schema } from "effect";
import type { SubspaceAgentsConfig } from "../config/composition";
import { type AgentKey, generateAgentKey } from "./certificate";
import {
  DistinctCertificates,
  type OfficerFiles,
  SubspaceFileError,
  type SubspaceOfficer,
  defaultStateDirectory,
  officerFiles,
  privateStateDirectory,
  readEnrolmentRecord,
  readOfficerKey,
  readPrivateFile,
  writeEnrolmentRecord,
  writeOfficerKey,
} from "./files";
import {
  type SubspaceUpstream,
  SubspaceUpstreamError,
  boundedText,
  subspaceUpstream,
} from "./upstream";

const enrolledSchema = Schema.Struct({
  agentId: Schema.String,
  credentialId: Schema.String,
  fingerprint: Schema.String,
});

/** The fleet's one-time enrolment token, from its private file or variable. */
async function enrolmentToken(
  section: SubspaceAgentsConfig,
  env: NodeJS.ProcessEnv,
) {
  const source = section.enrolment;

  if (!source)
    throw new SubspaceUpstreamError(
      "No enrolment token is configured (subspaceAgents.enrolment)",
    );

  let raw: string | undefined;

  try {
    raw = source.tokenFile
      ? await readPrivateFile(
          source.tokenFile,
          4096,
          "The enrolment token file",
        )
      : env[source.tokenEnv ?? ""];
  } catch (error) {
    throw new SubspaceUpstreamError(
      error instanceof SubspaceFileError
        ? error.message
        : "The enrolment token file is unreadable",
    );
  }

  const token = raw?.trim();

  if (!token) throw new SubspaceUpstreamError("The enrolment token is not set");

  if (!/^senr1\.[\u0021-\u007e]+$/.test(token))
    throw new SubspaceUpstreamError(
      "The configured enrolment token is not a Subspace enrolment token",
    );

  return token;
}

const problemSchema = Schema.Struct({ detail: Schema.optional(Schema.String) });

/** Why the API did not enrol a certificate, in fixed words. */
function reason(status: number, officer: SubspaceOfficer) {
  switch (status) {
    case 401:
    case 403:
      return "The API refused the enrolment token: it may be expired, used up or revoked";
    case 409:
      return `The API refused to enrol ${officer.name} (HTTP 409): its name may belong to another fleet, a deactivated agent or another rank, its IRC nick may be taken, or its certificate may be registered elsewhere`;
    case 400:
    case 422:
      return `The API refused ${officer.name}'s enrolment details (HTTP ${status})`;
    default:
      return `The Subspace API answered HTTP ${status}`;
  }
}

/**
 * The fixed reason, then the API's own one-line detail, which says which
 * check failed. The token is removed from it regardless.
 */
function refusal(
  status: number,
  officer: SubspaceOfficer,
  text: string,
  token: string,
) {
  const problem = Schema.decodeUnknownResult(
    Schema.fromJsonString(problemSchema),
  )(text);

  const detail = Result.isSuccess(problem)
    ? problem.success.detail
        ?.replaceAll(token, "[token]")
        .replace(/\p{Cc}/gu, " ")
        .slice(0, 200)
    : undefined;

  return detail
    ? `${reason(status, officer)}. The API says: ${detail}`
    : reason(status, officer);
}

/**
 * Registers the officer's certificate with the API. 201 enrols it; 200 means
 * the API already holds it for this agent. Nothing here is logged.
 */
export async function enrolCertificate(options: {
  upstream: SubspaceUpstream;
  token: string;
  officer: SubspaceOfficer;
  key: AgentKey;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}) {
  const { upstream, officer, key } = options;
  const headers = new Headers(upstream.accessHeaders());
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${options.token}`);

  const body = {
    name: officer.name,
    rank: officer.rank,
    ...(officer.ship !== undefined && { ship: officer.ship }),
    model: officer.model,
    ...(officer.ircNick !== undefined && { ircNick: officer.ircNick }),
    certificate: key.certificate,
    scopes: ["api", "irc"],
  };

  let response: Response;

  try {
    response = await (options.fetch ?? fetch)(
      `${upstream.base}/api/v1/agents/enrol`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(upstream.timeoutMs),
        ]),
      },
    );
  } catch {
    options.signal?.throwIfAborted();
    throw new SubspaceUpstreamError("The Subspace API is unreachable");
  }

  const text = await boundedText(response, 64 * 1024).catch(() => "");

  if (response.status !== 200 && response.status !== 201)
    throw new SubspaceUpstreamError(
      refusal(response.status, officer, text, options.token),
      response.status,
    );

  const decoded = Schema.decodeUnknownResult(
    Schema.fromJsonString(enrolledSchema),
  )(text);

  if (Result.isFailure(decoded))
    throw new SubspaceUpstreamError(
      "The Subspace API's enrolment answer is unreadable",
      response.status,
    );

  if (decoded.success.fingerprint.toLowerCase() !== key.fingerprint)
    throw new SubspaceUpstreamError(
      "The API reported a different certificate fingerprint",
      response.status,
    );

  return {
    agentId: decoded.success.agentId,
    credentialId: decoded.success.credentialId,
  };
}

export type EnrolmentOutcome = {
  name: string;
  /** The certificate now in the officer's bundle; none when there is no bundle. */
  fingerprint?: string;
  state: "unchanged" | "enrolled" | "rotated" | "failed";
  agentId?: string;
  credentialId?: string;
  /** After rotation: the fingerprint an administrator should revoke. */
  previousFingerprint?: string;
  error?: string;
};

export type EnrolmentContext = {
  section: SubspaceAgentsConfig;
  dataDirectory: string;
  env: NodeJS.ProcessEnv;
  /** Rotate: a new key for each named officer (all when absent). */
  rotate?: boolean;
  names?: readonly string[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

/** The state directory, checked private, with every configured officer. */
export async function prepareState(context: EnrolmentContext) {
  const stateDirectory =
    context.section.stateDirectory ??
    defaultStateDirectory(context.dataDirectory);

  await privateStateDirectory(stateDirectory);

  return stateDirectory;
}

/**
 * Makes sure each officer has a private bundle and that the API holds its
 * certificate. An officer already enrolled with its current bundle is left
 * alone. With `rotate`, a new key is enrolled first and only then replaces the
 * bundle. A file that is not private stops everything; an API refusal is that
 * officer's outcome, and the others go on.
 */
export async function enrolOfficers(
  context: EnrolmentContext,
): Promise<EnrolmentOutcome[]> {
  const { section } = context;
  const stateDirectory = await prepareState(context);
  const upstream = subspaceUpstream(section, context.env);

  const unknown = context.names?.filter(
    (name) => !section.officers.some((officer) => officer.name === name),
  );

  if (unknown?.length)
    throw new SubspaceUpstreamError(
      `No configured officer is named ${unknown.join(", ")}`,
    );

  const officers = section.officers.filter(
    (officer) => !context.names || context.names.includes(officer.name),
  );

  let token: Promise<string> | undefined;
  const outcomes: EnrolmentOutcome[] = [];
  const certificates = new DistinctCertificates();

  const prepared: {
    officer: SubspaceOfficer;
    files: OfficerFiles;
    existing: AgentKey | undefined;
    key: AgentKey;
  }[] = [];

  // Every file is checked, and every certificate is its officer's own, before
  // The API hears of any of them.
  for (const officer of officers) {
    const files = officerFiles(officer, stateDirectory);
    const existing = await readOfficerKey(officer, files);

    const key = context.rotate
      ? generateAgentKey(officer.name, section.keyAlgorithm)
      : (existing ??
        (await writeOfficerKey(officer, files, section.keyAlgorithm)));

    certificates.add(officer.name, key);
    prepared.push({ officer, files, existing, key });
  }

  for (const { officer, files, existing, key } of prepared) {
    context.signal?.throwIfAborted();

    const record = context.rotate
      ? undefined
      : await readEnrolmentRecord(officer, files);

    if (
      record?.fingerprint === key.fingerprint &&
      record.audience === upstream.audience
    ) {
      outcomes.push({
        name: officer.name,
        fingerprint: key.fingerprint,
        state: "unchanged",
        agentId: record.agentId,
        credentialId: record.credentialId,
      });
      continue;
    }

    try {
      token ??= enrolmentToken(section, context.env);

      const enrolled = await enrolCertificate({
        upstream,
        token: await token,
        officer,
        key,
        ...(context.fetch && { fetch: context.fetch }),
        ...(context.signal && { signal: context.signal }),
      });

      // A rotated key replaces the bundle only once the API holds it.
      if (context.rotate)
        await writeOfficerKey(officer, files, section.keyAlgorithm, key);
      await writeEnrolmentRecord(files, {
        fingerprint: key.fingerprint,
        agentId: enrolled.agentId,
        credentialId: enrolled.credentialId,
        audience: upstream.audience,
        enrolledAt: new Date().toISOString(),
      });
      outcomes.push({
        name: officer.name,
        fingerprint: key.fingerprint,
        state: context.rotate ? "rotated" : "enrolled",
        ...enrolled,
        ...(context.rotate &&
          existing && { previousFingerprint: existing.fingerprint }),
      });
    } catch (error) {
      context.signal?.throwIfAborted();

      if (!(error instanceof SubspaceUpstreamError)) throw error;
      // A failed rotation leaves the old bundle, if any, in place.
      const current = context.rotate ? existing : key;

      outcomes.push({
        name: officer.name,
        ...(current && { fingerprint: current.fingerprint }),
        state: "failed",
        error: error.message,
      });
    }
  }

  return outcomes;
}
