// Adapted from CFP Starfleet Teams 0.4.0; transport logic is independent of Claude Code.
// Outbound side: a Bot Connector token from Azure IMDS for the ship's user-assigned
// Identity, and posts to {serviceUrl}/v3/conversations/{conversationId}/activities.
//
// Accepted risk (contract revision 2026-11-06): IMDS serves any attached identity's
// Token to any local user, so a process on the VM can post to Teams as any ship.
// It cannot forge inbound traffic: inbound tokens must be issued and signed by Bot
// Framework (iss https://api.botframework.com), and an Entra token from IMDS fails
// That check.
import { serviceUrlBase } from "./service-url";

export const IMDS_TOKEN_ENDPOINT =
  "http://169.254.169.254/metadata/identity/oauth2/token";

// IMDS takes a resource rather than a scope; this is https://api.botframework.com/.default.
export const BOT_FRAMEWORK_RESOURCE = "https://api.botframework.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const IMDS_TIMEOUT_MS = 5000;
const CONNECTOR_TIMEOUT_MS = 15_000;

type FetchFn = typeof fetch;

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Settles with the promise, or rejects as soon as the signal aborts. The underlying
// Work (a shared token request, say) carries on, but this caller stops waiting.
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;

  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export interface TokenProvider {
  getToken(): Promise<string>;
  invalidate(): void;
}

// The error code and a short description from an error response, where it has them.
async function readError(
  res: Response,
): Promise<{ code?: string; detail: string }> {
  try {
    const text = (await res.text()).slice(0, 2000);

    try {
      const body = JSON.parse(text) as Record<string, unknown>;

      const error = body["error"] as
        | Record<string, unknown>
        | string
        | undefined;

      const code =
        typeof error === "string"
          ? error
          : typeof error?.["code"] === "string"
            ? error["code"]
            : undefined;

      const parts = [
        code,
        typeof error === "object" ? error?.["message"] : undefined,
        body["error_description"],
        body["message"],
      ].filter((part) => typeof part === "string" && part);

      return {
        ...(code ? { code } : {}),
        detail: parts.length ? `: ${parts.join(" - ").slice(0, 300)}` : "",
      };
    } catch {
      return { detail: "" };
    }
  } catch {
    return { detail: "" };
  }
}

async function errorDetail(res: Response): Promise<string> {
  return (await readError(res)).detail;
}

// A Bot Connector refusal, with its HTTP status and, where the body gives one, its
// Error code. afterServerError: an earlier try of the same send got a 5xx answer,
// So the activity may have been delivered all the same.
export class ConnectorError extends Error {
  status: number;
  code: string | undefined;
  afterServerError: boolean;
  constructor(
    message: string,
    status: number,
    code?: string,
    afterServerError = false,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.afterServerError = afterServerError;
  }
}

// Whether a failed send certainly did not deliver its activity: the Bot Connector
// Refused it with a 4xx status, and no earlier try of it got a 5xx answer. Any
// Other failure, such as a timeout, a network error (a lost answer among them) or
// A 5xx answer, leaves it unknown whether the activity was delivered.
export function isDefiniteRefusal(err: unknown): boolean {
  return (
    err instanceof ConnectorError &&
    err.status >= 400 &&
    err.status < 500 &&
    !err.afterServerError
  );
}

// Teams refuses a message over its size limit with HTTP 413 and the error code
// MessageSizeTooBig (see TEAMS_SAFE_MESSAGE_BYTES in teams.ts). Either is taken
// To mean the message was too large, so a smaller one may still go through.
export function isMessageTooLarge(err: unknown): boolean {
  return (
    err instanceof ConnectorError &&
    (err.status === 413 || err.code?.toLowerCase() === "messagesizetoobig")
  );
}

export class ManagedIdentityTokenProvider implements TokenProvider {
  readonly #clientId: string;
  readonly #fetch: FetchFn;
  readonly #now: () => number;
  readonly #sleep: Sleep;
  readonly #endpoint: string;
  #cached: { token: string; expiresAt: number } | undefined;
  #inflight: Promise<string> | undefined;

  constructor(options: {
    clientId: string;
    fetch?: FetchFn;
    now?: () => number;
    sleep?: Sleep;
    endpoint?: string;
  }) {
    this.#clientId = options.clientId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#endpoint = options.endpoint ?? IMDS_TOKEN_ENDPOINT;
  }

  async getToken(): Promise<string> {
    const cached = this.#cached;

    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.#now())
      return cached.token;
    this.#inflight ??= this.#request().finally(() => {
      this.#inflight = undefined;
    });

    return this.#inflight;
  }

  invalidate(): void {
    this.#cached = undefined;
  }

  async #request(): Promise<string> {
    const url = new URL(this.#endpoint);
    url.searchParams.set("api-version", "2018-02-01");
    url.searchParams.set("resource", BOT_FRAMEWORK_RESOURCE);
    url.searchParams.set("client_id", this.#clientId);
    let lastError = new Error("IMDS token request was not attempted");

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await this.#sleep(500 * 2 ** attempt);
      let res: Response;

      try {
        res = await this.#fetch(url, {
          headers: { Metadata: "true" },
          redirect: "error",
          signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = new Error(
          `IMDS token request failed: ${(err as Error).message}`,
        );
        continue;
      }

      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        const token = body["access_token"];

        if (typeof token !== "string" || !token)
          throw new Error("IMDS returned no access token");
        const expiresOn = Number(body["expires_on"]) * 1000;
        const expiresIn = Number(body["expires_in"]) * 1000;

        const expiresAt =
          expiresOn > 0
            ? expiresOn
            : this.#now() + (expiresIn > 0 ? expiresIn : 10 * 60 * 1000);

        this.#cached = { token, expiresAt };

        return token;
      }

      lastError = new Error(
        `IMDS token request failed: HTTP ${res.status}${await errorDetail(res)}`,
      );

      // IMDS asks callers to retry throttling, server errors and identity propagation (404).
      if (!(res.status === 404 || res.status === 429 || res.status >= 500))
        break;
    }

    throw lastError;
  }
}

export type OutgoingActivity = {
  type: "message" | "typing";
  text?: string;
  textFormat?: "markdown" | "plain" | "xml";
  attachments?: {
    contentType: "image/png" | "image/jpeg";
    contentUrl: string;
    name: string;
  }[];
  replyToId?: string;
  entities?: {
    type: "streamInfo";
    streamType: "informative" | "final";
    streamId?: string;
    streamSequence?: number;
  }[];
};

export class ConnectorClient {
  readonly #tokens: TokenProvider;
  readonly #fetch: FetchFn;
  readonly #sleep: Sleep;

  constructor(options: {
    tokenProvider: TokenProvider;
    fetch?: FetchFn;
    sleep?: Sleep;
  }) {
    this.#tokens = options.tokenProvider;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  // Options.signal bounds the whole send, token and retry included.
  async sendToConversation(
    serviceUrl: string,
    conversationId: string,
    activity: OutgoingActivity,
    options: { signal?: AbortSignal; retryServerErrors?: boolean } = {},
  ): Promise<{ id?: string }> {
    // Validate the host before a token is fetched, so it can never be sent elsewhere.
    const base = serviceUrlBase(serviceUrl);
    const url = `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    let afterServerError = false;

    for (let attempt = 0; ; attempt++) {
      const { signal } = options;
      const token = await untilAborted(this.#tokens.getToken(), signal);
      const timeout = AbortSignal.timeout(CONNECTOR_TIMEOUT_MS);

      const res = await this.#fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(activity),
        // A redirect would carry the bearer token to a host that was never checked.
        redirect: "error",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });

      if (res.ok) {
        const text = await res.text();

        try {
          return text ? (JSON.parse(text) as { id?: string }) : {};
        } catch {
          return {};
        }
      }

      if (attempt === 0 && (res.status === 401 || res.status === 403)) {
        await res.body?.cancel().catch(() => {});
        this.#tokens.invalidate();
        continue;
      }

      if (
        attempt === 0 &&
        (res.status === 429 ||
          (res.status >= 500 && options.retryServerErrors !== false))
      ) {
        afterServerError = res.status >= 500;
        await res.body?.cancel().catch(() => {});
        const retryAfter = Number(res.headers.get("retry-after"));
        await untilAborted(
          this.#sleep(retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 1000),
          options.signal,
        );
        continue;
      }

      const { code, detail } = await readError(res);
      throw new ConnectorError(
        `Bot Connector refused the activity: HTTP ${res.status}${detail}`,
        res.status,
        code,
        afterServerError,
      );
    }
  }
}
