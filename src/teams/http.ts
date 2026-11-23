// Adapted from CFP Starfleet Teams 0.4.0; transport logic is independent of Claude Code.
// The Bot Framework messaging endpoint, served on the ship's Unix socket. The
// The ingress connector forwards https://<bot-hostname>/api/messages
// To it. Cloudflare only limits the hostname to POST /api/messages and does not
// Authenticate, so anyone on the internet can reach this handler: the Bot Framework
// Token is checked before the request body is read.

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { VerifiedToken } from "./botframework-auth";
import { AuthError } from "./botframework-auth";
import { BodyTooLargeError, readBody, sendJson } from "../lib/http-util";
import type { Logger } from "./log";
import { describeError } from "./log";

// Answers before the body has been read, and drops the connection so a client
// Cannot keep it open by trickling an unwanted body.
function refuse(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
): void {
  res.setHeader("connection", "close");
  res.once("finish", () => {
    if (!req.complete) req.destroy();
  });
  sendJson(res, status);
}

export const MESSAGES_PATH = "/api/messages";
export const MAX_ACTIVITY_BYTES = 512 * 1024;
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export type TeamsListenerOptions = {
  verifyToken: (authorization: string | undefined) => Promise<VerifiedToken>;
  checkActivity: (
    token: VerifiedToken,
    activity: Record<string, unknown>,
  ) => void;
  onActivity: (activity: Record<string, unknown>) => Promise<void>;
  log: Logger;
  // Overridable so tests can prove the limits without waiting 30 seconds.
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  connectionsCheckingIntervalMs?: number;
  maxActivityBytes?: number;
};

export function createTeamsListener(options: TeamsListenerOptions): Server {
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxActivityBytes ?? MAX_ACTIVITY_BYTES;

  const server = createServer(
    {
      connectionsCheckingInterval:
        options.connectionsCheckingIntervalMs ?? 1000,
    },
    (req, res) => {
      handle(req, res).catch((err) => {
        options.log(`failed to handle a Teams activity: ${describeError(err)}`);
        sendJson(res, 500);
      });
    },
  );

  server.headersTimeout = Math.min(
    options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
    requestTimeout,
  );
  server.requestTimeout = requestTimeout;

  return server;

  function reject(
    req: IncomingMessage,
    res: ServerResponse,
    err: unknown,
  ): void {
    if (err instanceof AuthError) {
      options.log(`rejected a request to ${MESSAGES_PATH}: ${err.message}`);
      refuse(req, res, err.status);

      return;
    }

    // Signing keys unavailable or a refresh deferred: the Bot Connector service retries.
    options.log(
      `cannot validate a request to ${MESSAGES_PATH} yet: ${describeError(err)}`,
    );
    refuse(req, res, 503);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? "").split("?")[0];

    if (path !== MESSAGES_PATH) {
      refuse(req, res, 404);

      return;
    }

    if (req.method !== "POST") {
      res.setHeader("allow", "POST");

      refuse(req, res, 405);

      return;
    }

    // 1. Signature, issuer, audience and expiry, before anything else.
    let token: VerifiedToken;

    try {
      token = await options.verifyToken(req.headers.authorization);
    } catch (err) {
      reject(req, res, err);

      return;
    }

    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      refuse(req, res, 415);

      return;
    }

    let activity: unknown;

    try {
      activity = JSON.parse(await readBody(req, maxBytes));
    } catch (err) {
      if (err instanceof BodyTooLargeError) refuse(req, res, 413);
      else sendJson(res, 400);

      return;
    }

    if (
      activity === null ||
      typeof activity !== "object" ||
      Array.isArray(activity)
    ) {
      sendJson(res, 400);

      return;
    }

    // 2. The token's serviceUrl claim and channel endorsement must match the activity.
    try {
      options.checkActivity(token, activity as Record<string, unknown>);
    } catch (err) {
      reject(req, res, err);

      return;
    }

    // 3. Tenant, sender allow-list and forwarding happen in the channel.
    await options.onActivity(activity as Record<string, unknown>);
    sendJson(res, 200);
  }
}
