import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { LogLevel, WebClient } from "@slack/web-api";
import { type BotConfig, secret } from "./config";

export type BotFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Bot token from the environment, then `<config>.env`; never logged. */
export async function botToken(
  bot: BotConfig,
  configPath: string,
): Promise<string> {
  let companion: NodeJS.ProcessEnv = {};
  try {
    companion = parseEnv(await readFile(`${configPath}.env`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return secret(bot.slack.botTokenEnv, { ...companion, ...process.env });
}

// Third-party errors can contain request headers/bodies. Never log them.
const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  setName() {},
  getLevel() {
    return LogLevel.ERROR;
  },
};

/** Request-scoped, no-retry client: a lost response is never resent. */
export function botWebClient(
  token: string,
  signal: AbortSignal,
  request: BotFetch = globalThis.fetch,
): WebClient {
  return new WebClient(token, {
    timeout: 10000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logger: silent,
    fetch: (url, init) =>
      request(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
  });
}
