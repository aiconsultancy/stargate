import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Transcriber, TranscriptionConfig } from "../transcription";

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Azure Instance Metadata Service: reachable only from the virtual machine. */
const identityURL =
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fcognitiveservices.azure.com%2F";
// Refresh early so a request never starts with a token about to expire.
const refreshMarginMs = 5 * 60_000;
const maxResponseBytes = 1024 * 1024;
// A small deployment can admit one request each minute.
const maxRetryAfterSeconds = 300;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_on: z.coerce.number().int().positive(),
});
const transcriptResponse = z.object({ text: z.string() });

async function boundedJSON(response: Response): Promise<unknown> {
  const body = await response.arrayBuffer();
  if (body.byteLength > maxResponseBytes) throw new Error("Response too large");
  return JSON.parse(new TextDecoder().decode(body));
}

/**
 * Azure OpenAI audio transcription with the host's managed identity. No key
 * is configured or stored. Errors carry no token, URL, body or spoken text.
 */
export class AzureOpenAITranscriber implements Transcriber {
  readonly label: string;
  private readonly url: string;
  private readonly request: Fetch;
  private readonly identity: string;
  private readonly now: () => number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private token: { value: string; refreshAt: number } | undefined;

  constructor(
    provider: TranscriptionConfig["provider"],
    options: {
      fetch?: Fetch;
      identityURL?: string;
      now?: () => number;
      wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.label = `Azure OpenAI deployment ${provider.deployment}`;
    const url = new URL(
      `/openai/deployments/${encodeURIComponent(provider.deployment)}/audio/transcriptions`,
      provider.endpoint,
    );
    url.searchParams.set("api-version", provider.apiVersion);
    this.url = url.href;
    this.request = options.fetch ?? globalThis.fetch;
    this.identity = options.identityURL ?? identityURL;
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  private async accessToken(signal: AbortSignal) {
    if (this.token && this.now() < this.token.refreshAt)
      return this.token.value;
    this.token = undefined;
    const response = await this.request(this.identity, {
      headers: { Metadata: "true" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    try {
      if (response.status !== 200) throw new Error("Identity token refused");
      const token = tokenResponse.parse(await boundedJSON(response));
      const refreshAt = token.expires_on * 1000 - refreshMarginMs;
      // A token inside the margin serves this request and is not kept.
      if (refreshAt > this.now())
        this.token = { value: token.access_token, refreshAt };
      return token.access_token;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }

  async transcribe(
    file: { data: Uint8Array; mime: string; extension: string },
    signal: AbortSignal,
  ): Promise<string> {
    let status: number | undefined;
    try {
      signal.throwIfAborted();
      const token = await this.accessToken(signal);
      const form = new FormData();
      // The provider needs the container format, not the user's file name.
      form.set(
        "file",
        new File([new Uint8Array(file.data)], `audio.${file.extension}`, {
          type: file.mime,
        }),
      );
      form.set("response_format", "json");
      for (;;) {
        const response = await this.request(this.url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: form,
          redirect: "error",
          signal,
        });
        let retryMs: number | undefined;
        try {
          status = response.status;
          if (status === 200)
            return transcriptResponse.parse(await boundedJSON(response)).text;
          // The rate limit names its own delay; the caller's signal bounds
          // the total wait. Any other refusal is final.
          const after = response.headers.get("retry-after") ?? "";
          const seconds = /^\d{1,3}$/.test(after) ? Number(after) : -1;
          if (status !== 429 || seconds < 0 || seconds > maxRetryAfterSeconds)
            throw new Error("Transcription refused");
          retryMs = Math.max(1, seconds) * 1000;
        } finally {
          await response.body?.cancel().catch(() => {});
        }
        await this.wait(retryMs, signal);
      }
    } catch {
      // A rejected token is not reused. The request is not repeated here.
      if (status === 401 || status === 403) this.token = undefined;
      signal.throwIfAborted();
      throw new Error("Transcription request failed");
    }
  }
}

export function createTranscriber(config: TranscriptionConfig): Transcriber {
  return new AzureOpenAITranscriber(config.provider);
}
