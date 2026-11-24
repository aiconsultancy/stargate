import { lstat } from "node:fs/promises";
import { clientPem } from "./client-pem";

type CredentialReferences = {
  passwordEnv?: string | undefined;
  clientPemFile?: string | undefined;
};

/** Check local references without opening a connection or logging values. */
export async function checkIrcCredentials(
  registration: CredentialReferences & {
    crew: readonly CredentialReferences[];
    server: { caFile?: string | undefined };
  },
  env: NodeJS.ProcessEnv,
) {
  const members = [registration, ...registration.crew];

  for (const { passwordEnv } of members)
    if (passwordEnv && !env[passwordEnv]?.trim())
      throw new Error(
        "Missing IRC password environment reference. Set it in the environment or <config>.env; use --schema-only to skip credential checks.",
      );

  const pemFiles = new Set(
    members.flatMap(({ clientPemFile }) =>
      clientPemFile ? [clientPemFile] : [],
    ),
  );

  for (const path of pemFiles) await clientPem(path);
  const ca = registration.server.caFile;

  if (ca && !(await lstat(ca).catch(() => {}))?.isFile())
    throw new Error("IRC caFile is not a readable file.");
}
