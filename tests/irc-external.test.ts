import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import pino from "pino";
import { IrcClient } from "../src/irc/client";
import { clientPem } from "../src/irc/client-pem";

const openssl =
  spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(host: string, account?: string) {
  const dir = await mkdtemp(join(tmpdir(), "stargate-external-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  async function generate(name: string, dns?: string) {
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-pkeyopt",
        "ec_param_enc:named_curve",
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.pem`,
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${dns ?? name}`,
        ...(dns ? ["-addext", `subjectAltName=DNS:${dns}`] : []),
      ],
      { cwd: dir, stdio: "ignore" },
    );
    if (result.status !== 0) throw new Error("openssl test certificate failed");
    return {
      cert: await Bun.file(join(dir, `${name}.pem`)).text(),
      key: await Bun.file(join(dir, `${name}.key`)).text(),
    };
  }
  const [local, peer] = await Promise.all([
    generate("server", host),
    generate("enterprisecaptain"),
  ]);
  const pemFile = join(dir, "client.pem");
  await writeFile(pemFile, peer.cert + peer.key, { mode: 0o600 });
  const lines: string[] = [];
  const connections: { destroy(): void }[] = [];
  const server = createServer(
    { ...local, ca: peer.cert, requestCert: true, rejectUnauthorized: true },
    (socket) => {
      connections.push(socket);
      if (!socket.authorized)
        throw new Error("fixture accepted an untrusted peer");
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        for (
          let i = buffer.indexOf("\r\n");
          i >= 0;
          i = buffer.indexOf("\r\n")
        ) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          lines.push(line);
          const nick = "enterprisecaptain";
          if (line === "CAP LS 302")
            socket.write(":ergo CAP * LS :sasl=EXTERNAL,PLAIN account-tag\r\n");
          if (line.startsWith("CAP REQ "))
            socket.write(`:ergo CAP * ACK :${line.slice(8)}\r\n`);
          if (line === "AUTHENTICATE EXTERNAL")
            socket.write("AUTHENTICATE +\r\n");
          if (line === "AUTHENTICATE +") {
            if (account)
              socket.write(`:ergo 900 ${nick} * ${account} :Logged in\r\n`);
            socket.write(`:ergo 903 ${nick} :SASL successful\r\n`);
          }
          if (line === "CAP END")
            socket.write(
              `:ergo 001 ${nick} :Welcome\r\n:ergo 422 ${nick} :No MOTD\r\n`,
            );
        }
      });
      socket.on("error", () => {});
    },
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  cleanup.push(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return { ca: local.cert, port: address.port, lines, pemFile, dir };
}

async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const client = new IrcClient({
    host: "localhost",
    port: f.port,
    tls: true,
    ca: f.ca,
    clientCertificate: await clientPem(f.pemFile),
    account: "enterprisecaptain",
    nick: "enterprisecaptain",
    channels: [],
    log: pino({ level: "silent" }),
    timing: { refusedMs: 60_000 },
  });
  const controller = new AbortController();
  const running = client.run(controller.signal);
  cleanup.push(async () => {
    controller.abort();
    await running;
  });
  return client;
}

test.skipIf(!openssl)(
  "IRC EXTERNAL uses mutual TLS and checks the account",
  async () => {
    const f = await fixture("localhost", "enterprisecaptain");
    const client = await connect(f);
    await client.waitReady(2000);
    expect(f.lines.filter((x) => x.startsWith("AUTHENTICATE "))).toEqual([
      "AUTHENTICATE EXTERNAL",
      "AUTHENTICATE +",
    ]);
    const link = join(f.dir, "link.pem");
    await symlink(f.pemFile, link);
    await expect(clientPem(link)).rejects.toThrow("private");
    await chmod(f.pemFile, 0o644);
    await expect(clientPem(f.pemFile)).rejects.toThrow("private");
  },
);

test.skipIf(!openssl)(
  "IRC EXTERNAL fails closed on wrong or missing account and wrong TLS host",
  async () => {
    for (const [host, account, reachesSasl] of [
      ["localhost", "othercaptain", true],
      ["localhost", undefined, true],
      ["wrong.invalid", "enterprisecaptain", false],
    ] as const) {
      const f = await fixture(host, account);
      const client = await connect(f);
      await expect(client.waitReady(400)).rejects.toThrow("unavailable");
      expect(f.lines.includes("AUTHENTICATE EXTERNAL")).toBe(reachesSasl);
      expect(f.lines).not.toContain("AUTHENTICATE PLAIN");
      expect(f.lines).not.toContain("CAP END");
    }
  },
);
