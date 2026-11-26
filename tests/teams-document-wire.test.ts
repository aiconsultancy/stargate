import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxAttachmentBytes } from "../src/chat/attachments/attachments";
import { readAttachmentResponse } from "../src/transports/teams/inbound-body";
import { requestDocument } from "../src/transports/teams/inbound-documents";

const openssl =
  spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

test.skipIf(!openssl)(
  "Teams file HTTPS preserves the signed target and fails closed",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-teams-wire-"));

    try {
      const generated = spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-keyout",
          "server.key",
          "-out",
          "server.pem",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { cwd: directory, stdio: "ignore" },
      );

      if (generated.status !== 0) {
        throw new Error("Could not create the TLS fixture");
      }

      const [cert, key] = await Promise.all([
        readFile(join(directory, "server.pem")),
        readFile(join(directory, "server.key")),
      ]);

      const exact = "/_layouts/15/download.aspx?token=+%2B'%22";
      const received: [string | undefined, string | undefined][] = [];

      const server = createServer({ cert, key }, (request, response) => {
        received.push([request.url, request.headers.authorization]);

        switch (request.url) {
          case exact:
            response
              .writeHead(200, {
                "content-type": "text/plain",
                "content-length": "7",
              })
              .end("example");

            return;
          case "/redirect":
            response.writeHead(302, { location: "/must-not-follow" }).end();

            return;
          case "/unauthorised":
            response.writeHead(401).end();

            return;
          case "/oversized":
            response
              .writeHead(200, {
                "content-length": String(maxAttachmentBytes + 1),
              })
              .end();

            return;
          default:
            response.writeHead(404).end();
        }
      });

      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();

        if (!address || typeof address === "string") {
          throw new Error("TLS fixture is not listening");
        }

        const signal = AbortSignal.timeout(4000);

        const fetchFile = (path: string) =>
          requestDocument(
            "example-my.sharepoint.com",
            path,
            "test-file-token",
            signal,
            (options, respond) =>
              get(
                {
                  ...options,
                  hostname: "127.0.0.1",
                  port: address.port,
                  ca: cert,
                },
                respond,
              ),
          );

        const response = await fetchFile(exact);

        expect(response.headers.get("content-type")).toBe("text/plain");

        const bytes = await readAttachmentResponse(
          response,
          maxAttachmentBytes,
          signal,
        );

        expect(new TextDecoder().decode(bytes)).toBe("example");
        expect((await fetchFile("/redirect")).ok).toBe(false);
        expect((await fetchFile("/unauthorised")).status).toBe(401);
        const oversized = await fetchFile("/oversized");

        await expect(
          readAttachmentResponse(oversized, maxAttachmentBytes, signal),
        ).rejects.toThrow();
        expect(received).toEqual(
          [exact, "/redirect", "/unauthorised", "/oversized"].map((path) => [
            path,
            "Bearer test-file-token",
          ]),
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
