import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway";
import { IrcShip } from "../src/irc/ship";
import { nativeQuestionSchema, type QuestionAnswer } from "../src/questions";
import { Store } from "../src/store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(multiline = false, questions = true) {
  const server = new FakeIrcServer({
    accounts: { captain: "fixture", other: "fixture" },
  });
  if (multiline)
    server.caps.push("draft/multiline=max-bytes=4096,max-lines=100");
  server.start();
  cleanup.push(() => server.stop());
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-question-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  cleanup.push(() => store.close());
  const config = (account: string) =>
    ircSchema.parse({
      id: account,
      server: { host: "127.0.0.1", port: server.port, tls: false },
      account,
      passwordEnv: "IRC_FIXTURE",
      channels: ["#ship"],
      features: { questions },
      access: {
        allowedAccounts: ["jac", "other-human", "captain", "other"],
        channelRequests: "nick-mention",
        humanWakeChannels: [{ channel: "#ship", replies: "all" }],
        peerCaptains: [account === "captain" ? "other" : "captain"],
      },
      fleetPolicy: {
        role: "captain",
        humanAccounts: ["jac", "other-human"],
        agentAccounts: ["captain", "other"],
        assignedCheckout: "/project",
        capabilities: ["read_code"],
      },
      backend: {
        type: "opencode",
        url: "http://127.0.0.1:4096",
        directory: "/project",
        sessionID: `ses_${account}`,
      },
    });
  const gate = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const replies: (QuestionAnswer | null)[] = [];
  let pending = false;
  let complete = false;
  const q = nativeQuestionSchema.parse({
    id: "frm_question",
    sessionID: "ses_captain",
    inputID: "msg_original",
    toolMessageID: "msg_assistant",
    toolCallID: "call_question",
    fingerprint: "a".repeat(64),
    title: "Next step",
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Next",
        description: "Wait or continue?",
        options: [
          { value: "wait", label: "Wait" },
          { value: "continue", label: "Continue" },
        ],
      },
    ],
  });
  const log = pino({ level: "silent" });
  const controllers: AbortController[] = [];
  const workers: Promise<void>[] = [];
  const ships: IrcShip[] = [];
  const gateways: Gateway[] = [];
  const configs: ReturnType<typeof config>[] = [];
  for (const account of ["captain", "other"]) {
    const cfg = config(account);
    configs.push(cfg);
    const ship = await IrcShip.create(cfg, store, log, {
      env: { IRC_FIXTURE: "fixture" },
      timing: { intervalMs: 1, burst: 100 },
      readyMs: 2000,
    });
    const primary = ship.registrations[0];
    if (!primary) throw new Error("No registration");
    const backend: AgentBackend = {
      sessionID: `ses_${account}`,
      async createSession() {
        return `ses_${account}`;
      },
      async close() {},
      async prompt(_session, _text, signal, _onText, onInput) {
        prompts.push(account);
        if (account !== "captain") return "[[stargate:silent]]";
        onInput?.("msg_original");
        pending = true;
        await Promise.race([
          gate.promise,
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("stopped")),
              { once: true },
            ),
          ),
        ]);
        return "Clarification received.";
      },
      async pendingQuestions() {
        return account === "captain" && pending ? [q] : [];
      },
      async questionBelongsToInput(s, id, input, hash) {
        return (
          pending &&
          s === q.sessionID &&
          id === q.id &&
          input === q.inputID &&
          hash === q.fingerprint
        );
      },
      async replyQuestion(_question, answer) {
        replies.push(answer);
        pending = false;
        complete = true;
        gate.resolve();
      },
      async questionInputSettled() {
        return complete;
      },
      ...(account === "captain"
        ? {
            async transcript(_session: string, after: string | undefined) {
              if (after === undefined)
                return { cursor: "msg_baseline", entries: [] };
              if (!complete)
                return {
                  cursor: "msg_original",
                  entries: [],
                  input: "msg_original",
                  pending: true as const,
                };
              return {
                cursor: "msg_answer",
                entries: [
                  {
                    id: "msg_answer",
                    text: "Clarification received.",
                    created: 100,
                    input: "msg_original",
                  },
                ],
                input: "msg_original",
              };
            },
          }
        : {}),
    };
    const gateway = new Gateway(
      primary.settings,
      primary.identity,
      store,
      backend,
      primary.delivery,
      log,
      undefined,
      undefined,
      primary.transport,
    );
    gateways.push(gateway);
    primary.answerQuestion = (input, control) =>
      gateway.answerQuestion(input, control);
    const controller = new AbortController();
    controllers.push(controller);
    workers.push(gateway.work(controller.signal));
    ships.push(ship);
    ship.start(() => true);
  }
  cleanup.push(async () => {
    controllers.forEach((c) => {
      c.abort();
    });
    await Promise.all(workers);
    await Promise.all(ships.map((s) => s.close()));
  });
  await until(
    () => ships.every((s) => s.registrations[0]?.client.inChannel("#ship")),
    3000,
    "question ships joined",
  );
  let sequence = 0;
  const send = (
    text: string,
    id: string,
    user = "jac",
    root?: string,
    extra: Record<string, string> = {},
  ) => {
    const tags = {
      account: user,
      msgid: id,
      ...(root ? { "+draft/reply": root } : {}),
      ...extra,
    };
    const line = `@${Object.entries(tags)
      .map(([k, v]) => `${k}=${v}`)
      .join(";")} :jac!u@fixture PRIVMSG #ship :${text}`;
    const marker = `question-control-${++sequence}`;
    for (const account of ["captain", "other"]) {
      server.sendTo(account, line);
      server.sendTo(account, `PING :${marker}`);
    }
    return marker;
  };
  return {
    server,
    store,
    prompts,
    replies,
    send,
    ships,
    gateways,
    dropHumanPolicy() {
      for (const cfg of configs) {
        delete cfg.fleetPolicy;
        delete cfg.access.humanWakeChannels;
        delete cfg.access.allowedAccounts;
      }
    },
    received: (marker: string) =>
      until(
        () =>
          ships.every((ship) => {
            const account = ship.registrations[0]?.account;
            return (
              account !== undefined &&
              lineOf(server.received(account), "PONG").some(
                (line) => line.params[0] === marker,
              )
            );
          }),
        2000,
        "all ships processed reserved control",
      ),
    get pending() {
      return pending;
    },
  };
}

for (const multiline of [false, true]) {
  test(`real IRC question posts in original thread and resumes once (${multiline ? "multiline" : "plain"})`, async () => {
    const f = await fixture(multiline);
    f.send("captain: investigate", "m1");
    await until(
      () =>
        f.store.questionOffers(f.ships[0]?.registrations[0]?.key ?? "")[0]
          ?.notified === 1,
      5000,
      "native question offered",
    );
    const primary = f.ships[0]?.registrations[0];
    if (!primary) throw new Error("No primary");
    const offer = f.store.questionOffers(primary.key)[0];
    if (!offer) throw new Error("No offer");
    const wire = [
      ...lineOf(f.server.received("captain"), "PRIVMSG"),
      ...lineOf(f.server.received("captain"), "BATCH"),
    ];
    const body = wire.find(
      (m) =>
        m.command === "PRIVMSG" &&
        m.params[1]?.includes("OpenCode needs clarification"),
    );
    if (!body) throw new Error("No question body");
    const batch = body.tags.get("batch");
    const envelope = batch
      ? wire.find((m) => m.command === "BATCH" && m.params[0] === `+${batch}`)
      : body;
    expect(envelope?.command).toBe(multiline ? "BATCH" : "PRIVMSG");
    expect(envelope?.tags.get("+draft/reply")).toBe("m1");
    const initialPrompts = f.prompts.length;
    f.send(`captain: answer ${offer.token} 1`, "spoof", "other-human", "m1");
    f.send(
      `captain: answer ${offer.token} 1`,
      "wrong-thread",
      "jac",
      "foreign",
    );
    const rejectedAt = f.send(
      `captain: answer ${offer.token} 1`,
      "bot-tag",
      "jac",
      "m1",
      {
        bot: "1",
      },
    );
    await f.received(rejectedAt);
    expect(f.replies).toEqual([]);
    expect(f.prompts.length).toBe(initialPrompts);
    f.send(`captain: answer ${offer.token} 1`, "answer", "jac", "m1");
    await until(
      () =>
        f.replies.length === 1 &&
        f.server
          .received("captain")
          .some((s) => s.includes("Clarification received.")),
      5000,
      "native continued and original reply delivered",
    );
    const duplicateAt = f.send(
      `captain: answer ${offer.token} 2`,
      "duplicate",
      "jac",
      "m1",
    );
    await f.received(duplicateAt);
    expect(f.replies).toEqual([{ q0: "wait" }]);
    expect(f.prompts.length).toBe(initialPrompts);
    const final = lineOf(f.server.received("captain"), "PRIVMSG").find(
      (m) =>
        m.command === "PRIVMSG" && m.params[1] === "Clarification received.",
    );
    if (!final) throw new Error("No final continuation");
    const finalBatch = final.tags.get("batch");
    const finalEnvelope = finalBatch
      ? lineOf(f.server.received("captain"), "BATCH").find(
          (m) => m.command === "BATCH" && m.params[0] === `+${finalBatch}`,
        )
      : final;
    expect(finalEnvelope?.tags.get("+draft/reply")).toBe("m1");
  }, 15_000);
}

test("native questions stay disabled by default while targeted controls never wake other ships", async () => {
  expect(
    ircSchema.parse({
      id: "fixture",
      server: { host: "localhost", port: 6697, tls: true },
      account: "fixture",
      passwordEnv: "FIXTURE",
      channels: ["#ship"],
      backend: {
        type: "opencode",
        url: "http://localhost:4096",
        directory: "/project",
      },
    }).features.questions,
  ).toBe(false);
  const f = await fixture(false, false);
  const at = f.send(`captain: answer ${"a".repeat(32)} 1`, "disabled-control");
  await f.received(at);
  expect(f.prompts).toEqual([]);
  expect(f.replies).toEqual([]);
});

test("enabling questions requires explicit human policy, while default-off non-fleet configs stay valid", () => {
  const raw = {
    id: "fixture",
    server: { host: "localhost", port: 6697, tls: true },
    account: "fixture",
    passwordEnv: "FIXTURE",
    channels: ["#ship"],
    access: {},
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/project",
    },
  };
  expect(ircSchema.safeParse(raw).success).toBe(true);
  const enabled = ircSchema.safeParse({
    ...raw,
    features: { questions: true },
  });
  expect(enabled.success).toBe(false);
  if (enabled.success) throw new Error("Missing human policy was accepted");
  expect(
    enabled.error.issues.some((issue) =>
      issue.message.includes("explicit humanAccounts"),
    ),
  ).toBe(true);
});

test("parser-bypassed open access never makes an unknown authenticated untagged bot a question owner", async () => {
  const f = await fixture();
  f.dropHumanPolicy();
  f.send("captain: investigate", "bot-request", "service-bot");
  await until(
    () => f.pending,
    3000,
    "ordinary explicitly open IRC request admitted",
  );
  for (const gateway of f.gateways)
    await gateway.pollQuestions(AbortSignal.timeout(3000));
  const key = f.ships[0]?.registrations[0]?.key;
  if (!key) throw new Error("No registration");
  expect(f.store.questionOffers(key)).toEqual([]);
  const at = f.send(
    `captain: answer ${"a".repeat(32)} 1`,
    "bot-answer",
    "service-bot",
    "bot-request",
  );
  await f.received(at);
  expect(f.replies).toEqual([]);
  expect(
    f.server
      .received("captain")
      .some((line) => line.includes("OpenCode needs clarification")),
  ).toBe(false);
});

test("removing explicit human authority blocks untagged bot and original-human replies to an existing offer", async () => {
  const f = await fixture();
  f.send("captain: investigate", "m1");
  const key = f.ships[0]?.registrations[0]?.key;
  if (!key) throw new Error("No registration");
  await until(
    () => f.store.questionOffers(key)[0]?.notified === 1,
    5000,
    "owned question published",
  );
  const offer = f.store.questionOffers(key)[0];
  if (!offer) throw new Error("No offer");
  f.dropHumanPolicy();
  f.send(`captain: answer ${offer.token} 1`, "bot-reply", "service-bot", "m1");
  const at = f.send(
    `captain: cancel-question ${offer.token}`,
    "old-human-reply",
    "jac",
    "m1",
  );
  await f.received(at);
  expect(f.replies).toEqual([]);
  expect(f.store.questionByToken(key, offer.token)?.state).toBe("offered");
}, 10_000);
