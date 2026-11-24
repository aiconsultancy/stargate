import type { SubspaceAgentsConfig } from "../config/composition";

/** Fixed, credential-free text about the API or the gateway's own settings. */
export class SubspaceUpstreamError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SubspaceUpstreamError";
  }
}

/** The one API this gateway talks to for its officers. */
export type SubspaceUpstream = {
  /** The configured API origin, where `/api/v1/` and `/mcp` live. */
  base: string;
  /** The API's public origin: every agent token's `aud`. */
  audience: string;
  timeoutMs: number;
  /** Configured private-access headers, read from the environment now. */
  accessHeaders(): [string, string][];
};

export function subspaceUpstream(
  section: SubspaceAgentsConfig,
  env: NodeJS.ProcessEnv,
): SubspaceUpstream {
  // The API's audience check takes exact origin form: scheme, lower-case host
  // And optional port, with no path or trailing slash.
  const base = new URL(section.api.baseUrl).origin;

  return {
    base,
    audience: section.api.audience ?? new URL(base).origin,
    timeoutMs: section.api.timeoutSeconds * 1000,
    accessHeaders: () =>
      Object.entries(section.api.headersEnv).map(([name, variable]) => {
        const value = env[variable]?.trim();

        if (!value)
          throw new SubspaceUpstreamError(
            "A Subspace API access header variable is not set",
          );

        return [name, value];
      }),
  };
}

/** A response body as text, refused past `maxBytes` without buffering more. */
export async function boundedText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();

  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    size += value.byteLength;

    if (size > maxBytes) {
      await reader.cancel();
      throw new SubspaceUpstreamError(
        "The Subspace API response is too large",
        response.status,
      );
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}
