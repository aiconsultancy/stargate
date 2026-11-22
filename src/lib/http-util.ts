// Adapted from CFP Starfleet Teams 0.4.0; transport logic is independent of Claude Code.
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export class BodyTooLargeError extends Error {}

export function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;

      if (size > maxBytes) {
        failed = true;
        reject(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
        req.resume();

        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body?: unknown,
): void {
  if (res.headersSent) {
    res.end();

    return;
  }

  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();

      return;
    }

    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
