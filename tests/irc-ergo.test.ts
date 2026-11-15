import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import type { AgentBackend, PromptSourceContext } from "../src/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway";
import { IrcClient } from "../src/irc/client";
import {
  formatMessage,
  type IrcMessage,
  parseMessage,
} from "../src/irc/protocol";
import { IrcShip } from "../src/irc/ship";
import { Store } from "../src/store";
import { until } from "./irc-fixture";

/**
 * Local integration against a real Ergo server with a temporary config,
 * TLS from a throwaway CA and fresh accounts. Skipped when the Ergo binary
 * or openssl is absent (CI); set POGO_ERGO_BIN to use another binary.
 * Never touches the operator's server, config or accounts.
 */
const binary =
  process.env["POGO_ERGO_BIN"] ??
  join(homedir(), ".local/share/ergo/current/ergo");
const available =
  existsSync(binary) &&
  spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

const cleanup: (() => unknown)[] = [];
afterAll(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function freePort() {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function listening(port: number) {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

function openssl(directory: string, ...args: string[]) {
  const result = spawnSync("openssl", args, {
    cwd: directory,
    stdio: "ignore",
  });
  if (result.status !== 0) throw new Error("openssl failed");
}

/** A raw test client: plaintext, optional NickServ identity, tag caps. */
async function raw(port: number) {
  const lines: IrcMessage[] = [];
  let buffer = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(socket, data) {
        buffer += data.toString();
        let index = buffer.indexOf("\r\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const message = parseMessage(line);
          if (message?.command === "PING")
            socket.write(`PONG :${message.params[0] ?? ""}\r\n`);
          else if (message) lines.push(message);
          index = buffer.indexOf("\r\n");
        }
      },
    },
  });
  const send = (line: string) => socket.write(`${line}\r\n`);
  const wait = (match: (m: IrcMessage) => boolean, what: string) =>
    until(() => lines.some(match), 5000, what);
  return {
    lines,
    send,
    wait,
    async register(nick: string, password: string, caps = false) {
      if (caps) send("CAP REQ :message-tags server-time account-tag");
      send(`NICK ${nick}`);
      send(`USER ${nick} 0 * :test`);
      if (caps) send("CAP END");
      await wait((m) => m.command === "001", "welcome");
      send(`PRIVMSG NickServ :REGISTER ${password}`);
      await wait(
        (m) => m.command === "NOTICE" && /logged in/.test(m.params[1] ?? ""),
        "account",
      );
    },
    close() {
      send("QUIT :done");
      socket.end();
    },
  };
}

test.skipIf(!available)(
  "irc ergo: TLS + SASL captain, invited crew and a plain-text reply",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pogo-ergo-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    openssl(
      directory,
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "1",
      "-subj",
      "/CN=Pogo Test CA",
    );
    openssl(
      directory,
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
      "-subj",
      "/CN=127.0.0.1",
    );
    await writeFile(
      join(directory, "ext.cnf"),
      "subjectAltName=IP:127.0.0.1\n",
    );
    openssl(
      directory,
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "server.pem",
      "-days",
      "1",
      "-extfile",
      "ext.cnf",
    );
    const plain = await freePort();
    const secure = await freePort();
    const defaults = await Bun.file(
      join(dirname(realpathSync(binary)), "default.yaml"),
    ).text();
    const config = defaults
      .replace(/"127\.0\.0\.1:6667":.*\n/, `"127.0.0.1:${plain}":\n`)
      .replace(/ +"\[::1\]:6667":.*\n/, "")
      .replace(/ +":6697":\n/, `        "127.0.0.1:${secure}":\n`)
      .replace("cert: fullchain.pem", "cert: server.pem")
      .replace("key: privkey.pem", "key: server.key")
      .replace("motd: ergo.motd", 'motd: ""')
      .replace(
        "languages:\n    # whether to load languages\n    enabled: true",
        "languages:\n    # whether to load languages\n    enabled: false",
      );
    await writeFile(join(directory, "ircd.yaml"), config);
    const server = spawn(binary, ["run", "--conf", "ircd.yaml"], {
      cwd: directory,
      stdio: "ignore",
    });
    cleanup.push(() => {
      server.kill("SIGTERM");
    });
    const deadline = Date.now() + 10_000;
    while (!(await listening(secure)) || !(await listening(plain))) {
      if (Date.now() > deadline) throw new Error("Ergo did not start");
      await delay(50);
    }

    // Accounts and the invite-only ship channel, as the operator sets them up.
    const passwords = {
      POGO_IRC_GALACTICA: "captain-password-1",
      POGO_IRC_GALACTICA_CHIEF: "chief-password-1",
    };
    const founder = await raw(plain);
    await founder.register("galactica", passwords.POGO_IRC_GALACTICA);
    founder.send("JOIN #galactica");
    founder.send("PRIVMSG ChanServ :REGISTER #galactica");
    await founder.wait(
      (m) => m.command === "NOTICE" && /registered/.test(m.params[1] ?? ""),
      "channel registration",
    );
    founder.send("MODE #galactica +i");
    founder.send("MODE #galactica +I jack!*@*");
    await delay(200);
    founder.close();
    const chiefSetup = await raw(plain);
    await chiefSetup.register(
      "galactica-chief",
      passwords.POGO_IRC_GALACTICA_CHIEF,
    );
    chiefSetup.close();
    const jack = await raw(plain);
    await jack.register("jack", "jack-password-1", true);
    jack.send("JOIN #galactica");
    await jack.wait((m) => m.command === "JOIN", "jack joined");

    const store = new Store(join(directory, "pogo.sqlite"));
    cleanup.push(() => store.close());
    const ship = await IrcShip.create(
      ircSchema.parse({
        id: "galactica-irc",
        server: {
          host: "127.0.0.1",
          port: secure,
          tls: true,
          caFile: join(directory, "ca.pem"),
          network: "ErgoTest",
        },
        account: "galactica",
        passwordEnv: "POGO_IRC_GALACTICA",
        channels: ["#galactica"],
        // One worker isolates wire framing from overlapping delivery polls.
        concurrency: 1,
        // Exercise plain-line tags here; fake-wire tests cover BATCH tags.
        features: { multiline: false },
        crew: [
          {
            id: "chief",
            account: "galactica-chief",
            passwordEnv: "POGO_IRC_GALACTICA_CHIEF",
            channels: ["#galactica"],
            backend: {
              type: "opencode",
              url: "http://localhost:4096",
              directory: "/workspace",
            },
          },
        ],
        backend: {
          type: "opencode",
          url: "http://localhost:4096",
          directory: "/workspace",
          sessionID: "ses_captain",
        },
      }),
      store,
      pino({ level: "silent" }),
      { env: passwords, timing: { reclaimMs: 500 } },
    );
    const prompts: string[] = [];
    const contexts: (PromptSourceContext | undefined)[] = [];
    const backend: AgentBackend = {
      sessionID: "ses_captain",
      async createSession() {
        return "ses_captain";
      },
      async prompt(
        _session,
        text,
        _signal,
        _onText,
        _onInput,
        _files,
        context,
      ) {
        prompts.push(text);
        contexts.push(context);
        return `## Status\n\nAll **green**. ${"Details follow. ".repeat(40)}`;
      },
      async close() {},
    };
    const controller = new AbortController();
    const [captain, chief] = ship.registrations;
    if (!captain || !chief) throw new Error("missing registration");
    const worker = new Gateway(
      captain.settings,
      captain.identity,
      store,
      backend,
      captain.delivery,
      captain.log,
      undefined,
      undefined,
      captain.transport,
    ).work(controller.signal);
    ship.start(() => true);
    cleanup.push(async () => {
      controller.abort();
      await worker;
      await ship.close();
    });
    await until(
      () => captain.client.inChannel("#galactica"),
      10_000,
      "captain joined over TLS",
    );
    expect(captain.client.hasCap("labeled-response")).toBe(true);
    // Without the private CA the certificate is refused.
    const untrusted = new IrcClient({
      host: "127.0.0.1",
      port: secure,
      tls: true,
      account: "galactica",
      password: passwords.POGO_IRC_GALACTICA,
      nick: "galactica",
      channels: [],
      log: pino({ level: "silent" }),
      timing: { reconnectMinMs: 50, reconnectMaxMs: 100 },
    });
    const refused = new AbortController();
    const attempts = untrusted.run(refused.signal);
    await expect(untrusted.waitReady(1500)).rejects.toThrow("unavailable");
    refused.abort();
    await attempts;
    // The crew connection is refused (+i) until the captain invites it.
    await until(
      () => chief.client.inChannel("#galactica"),
      10_000,
      "crew joined",
    );

    jack.send("PRIVMSG #galactica :galactica: status?");
    await until(
      () =>
        jack.lines.filter(
          (m) => m.command === "PRIVMSG" && m.source?.startsWith("galactica!"),
        ).length >= 2,
      15_000,
      "captain reply",
    );
    expect(prompts).toEqual(["status?"]);
    const reply = jack.lines.filter(
      (m) => m.command === "PRIVMSG" && m.source?.startsWith("galactica!"),
    );
    expect(reply[0]?.params[1]).toBe("Status");
    expect(reply[0]?.tags.get("account")).toBe("galactica");
    expect(reply.every((message) => !message.tags.has("+draft/reply"))).toBe(
      true,
    );
    expect(reply[1]?.params[1]?.startsWith("All green. Details follow.")).toBe(
      true,
    );
    await until(
      () => store.queueCounts(captain.key).done === 1,
      15_000,
      "delivery confirmed",
    );
    // A real earlier message is the root; every relayed answer line stays
    // in that one-level thread, not in a thread under the new request.
    const root = reply[0]?.tags.get("msgid");
    if (!root) throw new Error("captain root has no server msgid");
    // The delivery ACK is on another socket. A round trip on Jack's socket
    // consumes all earlier lines before the second request's boundary.
    jack.send("PING :thread-boundary");
    await jack.wait(
      (message) =>
        message.command === "PONG" &&
        message.params.at(-1) === "thread-boundary",
      "main reply read boundary",
    );
    const offset = jack.lines.length;
    jack.send(
      formatMessage("PRIVMSG", ["#galactica", "galactica: threaded status?"], {
        "+draft/reply": root,
      }),
    );
    await until(
      () => store.queueCounts(captain.key).done === 2,
      15_000,
      "thread delivery confirmed",
    );
    const threaded = jack.lines
      .slice(offset)
      .filter(
        (message) =>
          message.command === "PRIVMSG" &&
          message.source?.startsWith("galactica!"),
      );
    expect(threaded.length).toBeGreaterThanOrEqual(2);
    expect(threaded.map((message) => message.tags.get("+draft/reply"))).toEqual(
      threaded.map(() => root),
    );
    expect(contexts[1]?.source.replyParent).toBe(root);
    const answerID = threaded[0]?.tags.get("msgid");
    if (!answerID) throw new Error("thread answer has no server msgid");
    expect(captain.client.anchor(answerID)).toBe(root);
    expect(captain.client.requestAnchor(answerID)).toBe(
      contexts[1]?.source.message,
    );
    // A direct message: WHOIS proves the nick holds jack's account first.
    jack.send("PRIVMSG galactica :private status?");
    await until(
      () =>
        jack.lines.some(
          (m) =>
            m.command === "PRIVMSG" &&
            m.params[0] === "jack" &&
            m.source?.startsWith("galactica!"),
        ),
      15_000,
      "direct reply",
    );
    expect(prompts).toEqual(["status?", "threaded status?", "private status?"]);
    jack.close();
  },
  60_000,
);
