import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import pino from "pino";
import { ircSchema } from "../src/config";
import { IrcClient } from "../src/irc/client";
import { clientPem } from "../src/irc/client-pem";
import { IrcShip, ircKey } from "../src/irc/ship";
import { checkCredentials } from "../src/setup";
import { Store } from "../src/store";

const openssl =
  spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  host: string,
  account?: string,
  crew: string[] = [],
  allowPlain = false,
) {
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
  const peers = new Map([["enterprisecaptain", { ...peer, file: pemFile }]]);
  for (const name of crew) {
    const cert = await generate(name);
    const file = join(dir, `${name}-client.pem`);
    await writeFile(file, cert.cert + cert.key, { mode: 0o600 });
    peers.set(name, { ...cert, file });
  }
  const caFile = join(dir, "ca.pem");
  await writeFile(caFile, local.cert);
  const presented = new Map<string, string | undefined>();
  const lines: string[] = [];
  const connections: { destroy(): void }[] = [];
  const server = createServer(
    {
      ...local,
      ca: [...peers.values()].map((p) => p.cert),
      requestCert: true,
      rejectUnauthorized: !allowPlain,
    },
    (socket) => {
      connections.push(socket);
      if (!socket.authorized && !allowPlain)
        throw new Error("fixture accepted an untrusted peer");
      let buffer = "";
      let nick = "enterprisecaptain";
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
          if (line.startsWith("NICK ")) {
            nick = line.slice(5);
            const cn = socket.getPeerCertificate().subject?.CN;
            presented.set(nick, Array.isArray(cn) ? cn[0] : cn);
          }
          if (line === "CAP LS 302")
            socket.write(":ergo CAP * LS :sasl=EXTERNAL,PLAIN account-tag\r\n");
          if (line.startsWith("CAP REQ "))
            socket.write(`:ergo CAP * ACK :${line.slice(8)}\r\n`);
          if (line === "AUTHENTICATE EXTERNAL" || line === "AUTHENTICATE PLAIN")
            socket.write("AUTHENTICATE +\r\n");
          if (
            line === "AUTHENTICATE +" ||
            (line.startsWith("AUTHENTICATE ") &&
              !["AUTHENTICATE EXTERNAL", "AUTHENTICATE PLAIN"].includes(line))
          ) {
            if (account || crew.length)
              socket.write(
                `:ergo 900 ${nick} * ${crew.length ? nick : account} :Logged in\r\n`,
              );
            socket.write(`:ergo 903 ${nick} :SASL successful\r\n`);
          }
          if (line === "CAP END")
            socket.write(
              `:ergo 001 ${nick} :Welcome\r\n:ergo 422 ${nick} :No MOTD\r\n`,
            );
          if (line.startsWith("JOIN "))
            socket.write(`:${nick}!u@local JOIN ${line.slice(5)}\r\n`);
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
  return {
    ca: local.cert,
    port: address.port,
    lines,
    pemFile,
    dir,
    peers,
    caFile,
    presented,
  };
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
  "IRC ship selects each account's EXTERNAL certificate, including added crew",
  async () => {
    const f = await fixture("localhost", "enterprisecaptain", [
      "enterprisechief",
      "enterpriseapollo",
    ]);
    const chief = f.peers.get("enterprisechief");
    const apollo = f.peers.get("enterpriseapollo");
    if (!chief || !apollo) throw new Error("missing synthetic peer");
    const backend = {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/fixture",
    };
    const member = (id: string, file: string) => ({
      id,
      account: `enterprise${id}`,
      clientPemFile: file,
      channels: ["#ship"],
      backend,
    });
    const config = ircSchema.parse({
      id: "enterprise",
      account: "enterprisecaptain",
      clientPemFile: f.pemFile,
      server: { host: "localhost", port: f.port, tls: true, caFile: f.caFile },
      channels: ["#ship"],
      backend,
      crew: [member("chief", chief.file)],
    });
    await checkCredentials(join(f.dir, "config.json"), [], {}, [config]);
    const store = new Store(join(f.dir, "ship.sqlite"));
    cleanup.push(() => store.close());
    const ship = await IrcShip.create(config, store, pino({ level: "silent" }));
    cleanup.push(() => ship.close());
    ship.start(() => false);
    await Promise.all(ship.registrations.map((r) => r.client.waitReady(2000)));
    expect(f.presented.get("enterprisecaptain")).toBe("enterprisecaptain");
    expect(f.presented.get("enterprisechief")).toBe("enterprisechief");
    const next = ircSchema.parse({
      ...config,
      crew: [...config.crew, member("apollo", apollo.file)],
    });
    const plan = await ship.prepareReload(next, {});
    expect(f.presented.has("enterpriseapollo")).toBe(false);
    plan.commit(() => true);
    await plan.added[0]?.client.waitReady(2000);
    expect(f.presented.get("enterpriseapollo")).toBe("enterpriseapollo");
    expect(f.lines).not.toContain("AUTHENTICATE PLAIN");
    const rotated = structuredClone(next);
    const first = rotated.crew[0];
    if (!first) throw new Error("missing chief");
    first.clientPemFile = apollo.file;
    await expect(ship.prepareReload(rotated, {})).rejects.toThrow(
      "restart required",
    );
    expect(ship.registrations[1]?.key).toBe(
      ircKey(
        "enterprise-chief",
        config.server,
        "enterprisechief",
        config.backend,
      ),
    );
    await plan.retire();
  },
);

test.skipIf(!openssl)(
  "IRC ship mixes a PLAIN captain and crew with EXTERNAL crew without cert fallback",
  async () => {
    const f = await fixture(
      "localhost",
      "enterprisecaptain",
      ["enterprisechief"],
      true,
    );
    const chief = f.peers.get("enterprisechief");
    if (!chief) throw new Error("missing synthetic peer");
    const backend = {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/fixture",
    };
    for (const externalCaptain of [false, true]) {
      f.presented.clear();
      const config = ircSchema.parse({
        id: "enterprise",
        account: "enterprisecaptain",
        ...(externalCaptain
          ? { clientPemFile: f.pemFile }
          : { passwordEnv: "CAPTAIN" }),
        server: {
          host: "localhost",
          port: f.port,
          tls: true,
          caFile: f.caFile,
        },
        channels: ["#ship"],
        backend,
        crew: [
          {
            id: "chief",
            account: "enterprisechief",
            clientPemFile: chief.file,
            channels: ["#ship"],
            backend,
          },
          {
            id: "bosun",
            account: "enterprisebosun",
            passwordEnv: "BOSUN",
            channels: ["#ship"],
            backend,
          },
        ],
      });
      const store = new Store(":memory:");
      const ship = await IrcShip.create(
        config,
        store,
        pino({ level: "silent" }),
        { env: { CAPTAIN: "synthetic", BOSUN: "synthetic" } },
      );
      try {
        ship.start(() => false);
        await Promise.all(
          ship.registrations.map((r) => r.client.waitReady(2000)),
        );
        expect(f.presented.get("enterprisecaptain")).toBe(
          externalCaptain ? "enterprisecaptain" : undefined,
        );
        expect(f.presented.get("enterprisechief")).toBe("enterprisechief");
        expect(f.presented.has("enterprisebosun")).toBe(true);
        expect(f.presented.get("enterprisebosun")).toBeUndefined();
      } finally {
        await ship.close();
        store.close();
      }
    }
  },
);

test.skipIf(!openssl)(
  "crew PEM validation rejects unsafe or mismatched added credentials before changing the roster",
  async () => {
    const f = await fixture("localhost", "enterprisecaptain", [
      "enterprisechief",
    ]);
    const chief = f.peers.get("enterprisechief");
    const captain = f.peers.get("enterprisecaptain");
    if (!chief || !captain) throw new Error("missing synthetic peers");
    const backend = {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/fixture",
    };
    const config = ircSchema.parse({
      id: "enterprise",
      account: "enterprisecaptain",
      clientPemFile: f.pemFile,
      server: { host: "localhost", port: f.port, tls: true, caFile: f.caFile },
      channels: ["#ship"],
      backend,
    });
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    const ship = await IrcShip.create(config, store, pino({ level: "silent" }));
    cleanup.push(() => ship.close());
    const roster = [...ship.registrations];
    const link = join(f.dir, "crew-link.pem");
    await symlink(chief.file, link);
    const mismatch = join(f.dir, "mismatch.pem");
    await writeFile(mismatch, chief.cert + captain.key, { mode: 0o600 });
    const publicFile = join(f.dir, "public.pem");
    await writeFile(publicFile, chief.cert + chief.key, { mode: 0o644 });
    for (const clientPemFile of [
      link,
      mismatch,
      publicFile,
      join(f.dir, "missing.pem"),
    ]) {
      const next = ircSchema.parse({
        ...config,
        crew: [
          {
            id: "chief",
            account: "enterprisechief",
            clientPemFile,
            channels: ["#ship"],
            backend,
          },
        ],
      });
      await expect(
        checkCredentials(join(f.dir, "config.json"), [], {}, [next]),
      ).rejects.toThrow("IRC client PEM must be a private");
      await expect(ship.prepareReload(next, {})).rejects.toThrow(
        "IRC client PEM must be a private",
      );
      expect([...ship.registrations]).toEqual(roster);
      await expect(
        IrcShip.create(next, store, pino({ level: "silent" })),
      ).rejects.toThrow("IRC client PEM must be a private");
    }
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
