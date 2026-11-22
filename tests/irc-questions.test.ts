import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { effectiveIrcConfig, ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { IrcShip } from "../src/irc/ship";
import {
  nativeQuestionSchema,
  type QuestionAnswer,
} from "../src/questions/questions";
import { settingsIssues } from "../src/config/settings-schema";
import { Store } from "../src/gateway/store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
const controlObservationTimeoutMs = 10_000;
const questionIntegrationTimeoutMs = 45_000;
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  multiline = false,
  questions?: boolean,
  options: { wake?: boolean; nick?: string; crew?: boolean } = {},
) {
  const server = new FakeIrcServer({
    accounts: { captain: "fixture", other: "fixture", worker: "fixture" },
    isupport: ["CASEMAPPING=rfc1459"],
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
    Schema.decodeUnknownSync(ircSchema)({
      id: account,
      server: { host: "127.0.0.1", port: server.port, tls: false },
      account,
      ...(account === "captain" && options.nick ? { nick: options.nick } : {}),
      passwordEnv: "IRC_FIXTURE",
      channels: ["#ship"],
      ...(questions === undefined ? {} : { features: { questions } }),
      access: {
        allowedAccounts: ["jac", "other-human", "captain", "other"],
        channelRequests: "nick-mention",
        ...(options.wake === false
          ? {}
          : { humanWakeChannels: [{ channel: "#ship", replies: "all" }] }),
        peerCaptains: [account === "captain" ? "other" : "captain"],
      },
      fleetPolicy: {
        role: "captain",
        humanAccounts: ["jac", "other-human"],
        agentAccounts: ["captain", "other"],
        assignedCheckout: "/project",
        capabilities: ["read_code"],
      },
      ...(account === "captain" && options.crew
        ? {
            crew: [
              {
                id: "worker",
                account: "worker",
                passwordEnv: "IRC_WORKER_FIXTURE",
                channels: ["#ship"],
                backend: {
                  type: "opencode",
                  url: "http://127.0.0.1:4096",
                  directory: "/project",
                },
              },
            ],
          }
        : {}),
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
  const q = Schema.decodeUnknownSync(nativeQuestionSchema)({
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
  const backends: AgentBackend[] = [];
  for (const account of ["captain", "other"]) {
    const cfg = config(account);
    configs.push(cfg);
    const ship = await IrcShip.create(cfg, store, log, {
      env: { IRC_FIXTURE: "fixture", IRC_WORKER_FIXTURE: "fixture" },
      timing: { intervalMs: 1, burst: 100 },
      readyMs: 2000,
    });
    const primary =
      options.crew && account === "captain"
        ? ship.registrations.find((r) => r.role === "crew")
        : ship.registrations[0];
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
      async questionState() {
        return pending ? "pending" : "resolved";
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
    backends.push(backend);
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
    () =>
      ships.every((s) =>
        s.registrations.every((r) => r.client.inChannel("#ship")),
      ),
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
    for (const account of [
      "captain",
      "other",
      ...(options.crew ? ["worker"] : []),
    ]) {
      server.sendTo(account, line);
      server.sendTo(account, `PING :${marker}`);
    }
    return marker;
  };
  return {
    server,
    path,
    store,
    prompts,
    replies,
    send,
    ships,
    gateways,
    async restartTransport() {
      const old = ships[0];
      const cfg = configs[0];
      const backend = backends[0];
      if (!old || !cfg || !backend) throw new Error("Missing transport");
      await old.close();
      const fresh = await IrcShip.create(cfg, store, log, {
        env: { IRC_FIXTURE: "fixture", IRC_WORKER_FIXTURE: "fixture" },
        timing: { intervalMs: 1, burst: 100 },
        readyMs: 2000,
      });
      const registration = options.crew
        ? fresh.registrations.find((r) => r.role === "crew")
        : fresh.registrations[0];
      if (!registration) throw new Error("Missing renewed registration");
      const renewedGateway = new Gateway(
        registration.settings,
        registration.identity,
        store,
        backend,
        registration.delivery,
        log,
        undefined,
        undefined,
        registration.transport,
      );
      registration.answerQuestion = (input, control) =>
        renewedGateway.answerQuestion(input, control);
      ships[0] = fresh;
      fresh.start(() => true);
      await until(
        () => registration.client.inChannel("#ship"),
        3000,
        "fresh transport joined",
      );
    },
    async dropHumanPolicy() {
      for (const [index, cfg] of configs.entries()) {
        delete cfg.fleetPolicy;
        delete cfg.access.humanWakeChannels;
        delete cfg.access.allowedAccounts;
        const ship = ships[index];
        const gateway = gateways[index];
        if (!ship || !gateway) throw new Error("Missing policy fixture");
        // Deliberately bypass parser validation, then install the candidate
        // through the runtime's real reload path. Parsed objects are not live
        // policy: fleet defaults now use an immutable runtime view.
        const reload = await ship.prepareReload(cfg, {
          IRC_FIXTURE: "fixture",
          IRC_WORKER_FIXTURE: "fixture",
        });
        reload.commit(() => true);
        const registration =
          options.crew && index === 0
            ? ship.registrations.find((item) => item.role === "crew")
            : ship.registrations[0];
        if (!registration) throw new Error("Missing policy registration");
        gateway.reconfigure(
          registration.settings,
          undefined,
          registration.transport,
        );
        await reload.retire();
      }
    },
    received: (marker: string, timeoutMs = 2000) =>
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
        timeoutMs,
        "all ships processed reserved control",
      ),
    get pending() {
      return pending;
    },
  };
}

for (const multiline of [false, true]) {
  test(
    `real IRC question posts in original thread and resumes once (${multiline ? "multiline" : "plain"})`,
    async () => {
      const f = await fixture(multiline);
      f.send("captain: investigate", "m1");
      await until(
        () =>
          f.store.questions.questionOffers(
            f.ships[0]?.registrations[0]?.key ?? "",
          )[0]?.notified === 1,
        5000,
        "native question offered",
      );
      const primary = f.ships[0]?.registrations[0];
      if (!primary) throw new Error("No primary");
      const offer = f.store.questions.questionOffers(primary.key)[0];
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
      await f.received(rejectedAt, controlObservationTimeoutMs);
      expect(f.replies).toEqual([]);
      expect(f.prompts.length).toBe(initialPrompts);
      f.send(`@captain: answer ${offer.token} 1`, "answer", "jac", "m1");
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
      await f.received(duplicateAt, controlObservationTimeoutMs);
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
    },
    questionIntegrationTimeoutMs,
  );
}

test("an explicit opt-out leaves native question controls quiet", async () => {
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
  const config = Schema.decodeUnknownSync(ircSchema)(raw);
  expect(effectiveIrcConfig(config).features).toMatchObject({
    questions: false,
    crewQuestionHandoff: false,
    fleetTyping: true,
    liveProgress: true,
  });
  const policy = {
    role: "captain",
    humanAccounts: ["jac"],
    assignedCheckout: "/project",
    capabilities: ["read_code"],
  };
  for (const [backend, questions] of [
    [raw.backend, true],
    [
      { type: "pi-durable", model: "openai/local", directory: "/project" },
      false,
    ],
  ] as const) {
    const registration = Schema.decodeUnknownSync(ircSchema)({
      ...raw,
      backend,
      fleetPolicy: policy,
    });
    expect(effectiveIrcConfig(registration).features).toMatchObject({
      questions,
      crewQuestionHandoff: false,
    });
  }
  expect(() =>
    Schema.decodeUnknownSync(ircSchema)({
      ...raw,
      features: { crewQuestionHandoff: true },
    }),
  ).toThrow("Crew question handoff requires a pinned OpenCode registration");
  const enabled = Schema.decodeUnknownResult(ircSchema)({
    ...raw,
    features: { questions: true },
  });
  expect(Result.isSuccess(enabled)).toBe(false);
  if (Result.isSuccess(enabled))
    throw new Error("Missing human policy was accepted");
  expect(
    settingsIssues(enabled.failure.issue).issues.some((issue) =>
      issue.message.includes("explicit humanAccounts"),
    ),
  ).toBe(true);
});

test("parser-bypassed open access never makes an unknown authenticated untagged bot a question owner", async () => {
  const f = await fixture();
  await f.dropHumanPolicy();
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
  expect(f.store.questions.questionOffers(key)).toEqual([]);
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
    () => f.store.questions.questionOffers(key)[0]?.notified === 1,
    5000,
    "owned question published",
  );
  const offer = f.store.questions.questionOffers(key)[0];
  if (!offer) throw new Error("No offer");
  await f.dropHumanPolicy();
  f.send(`captain: answer ${offer.token} 1`, "bot-reply", "service-bot", "m1");
  const at = f.send(
    `captain: cancel-question ${offer.token}`,
    "old-human-reply",
    "jac",
    "m1",
  );
  await f.received(at);
  expect(f.replies).toEqual([]);
  expect(f.store.questions.questionByToken(key, offer.token)?.state).toBe(
    "offered",
  );
}, 10_000);

test("ordinary answer requests remain prompts when questions are disabled", async () => {
  const f = await fixture(false, false);
  const at = f.send(
    "other: answer Bob's question about the deploy",
    "ordinary-answer",
  );
  await f.received(at);
  await until(
    () => f.prompts.includes("other"),
    3000,
    "ordinary answer prompt admitted",
  );
  expect(f.replies).toEqual([]);
});

for (const target of ["captain", "CAP{TAIN}"]) {
  test(`question controls accept actual account/current RFC1459 nick (${target}) without borrowing authority`, async () => {
    const f = await fixture(false, true, { wake: false, nick: "Cap[tain]" });
    f.send("Cap[tain]: investigate", "m1");
    const key = f.ships[0]?.registrations[0]?.key;
    if (!key) throw new Error("No registration");
    await until(
      () => f.store.questions.questionOffers(key)[0]?.notified === 1,
      5000,
      "question offered to current nick",
    );
    const offer = f.store.questions.questionOffers(key)[0];
    if (!offer) throw new Error("No offer");
    expect(
      f.server
        .received("captain")
        .some((line) => line.includes(`captain: answer ${offer.token}`)),
    ).toBe(true);
    f.send(
      `${target}: answer ${offer.token.toUpperCase()} 1`,
      "wrong-human",
      "other-human",
      "m1",
    );
    const at = f.send(
      `${target}: answer ${offer.token.toUpperCase()} 1`,
      "valid",
      "jac",
      "m1",
    );
    await f.received(at);
    await until(() => f.replies.length === 1, 3000, "alias control answered");
    expect(f.replies).toEqual([{ q0: "wait" }]);
  }, 10_000);
}

test("question replies resolve durable own-publication anchors after transport restart without humanWake", async () => {
  const f = await fixture(false, true, { wake: false });
  f.send("captain: investigate", "m1");
  const key = f.ships[0]?.registrations[0]?.key;
  if (!key) throw new Error("No registration");
  await until(
    () => f.store.questions.questionOffers(key)[0]?.notified === 1,
    5000,
    "question published",
  );
  const offer = f.store.questions.questionOffers(key)[0];
  if (!offer) throw new Error("No offer");
  const received = lineOf(f.server.received("captain"), "PRIVMSG").find((m) =>
    m.params[1]?.includes("OpenCode needs clarification"),
  );
  if (!received) throw new Error("No question line");
  // The actual server echo ID is correlated by the client, then durably stored.
  const database = new Database(f.path, { readonly: true });
  const questionID = database
    .query<{ msgid: string }, [string]>(
      "SELECT msgid FROM irc_thread_messages WHERE botKey=? AND root='m1' ORDER BY rowid LIMIT 1",
    )
    .get(key)?.msgid;
  database.close();
  if (!questionID) throw new Error("No question echo ID");
  await until(
    () => f.store.ircThreadRoot(key, "#ship", questionID) === "m1",
    2000,
    "question anchor persisted",
  );
  await f.restartTransport();
  expect(
    f.ships[0]?.registrations[0]?.client.anchor(questionID),
  ).toBeUndefined();
  const at = f.send(
    `captain: answer ${offer.token} 1`,
    "after-restart",
    "jac",
    questionID,
  );
  await f.received(at);
  await until(
    () => f.replies.length === 1,
    3000,
    "restarted thread control accepted",
  );
  expect(f.replies).toEqual([{ q0: "wait" }]);
}, 12_000);

test("unmistakably malformed token controls never reach models, even with questions off", async () => {
  const f = await fixture(false, false);
  for (const token of [
    "a".repeat(31),
    "B".repeat(33),
    `${"abcd".repeat(6)}…`,
  ]) {
    const at = f.send(
      `captain: answer ${token} {"q0":"wait"}`,
      `malformed-${token.length}`,
    );
    await f.received(at);
  }
  expect(f.prompts).toEqual([]);
  expect(f.replies).toEqual([]);
});

test("crew question publication anchors survive a new IRC connection", async () => {
  const f = await fixture(false, true, { wake: false, crew: true });
  f.send("worker: investigate", "m1");
  const worker = f.ships[0]?.registrations.find((r) => r.role === "crew");
  if (!worker) throw new Error("No crew");
  await until(
    () => f.store.questions.questionOffers(worker.key)[0]?.notified === 1,
    5000,
    "crew question offered",
  );
  const offer = f.store.questions.questionOffers(worker.key)[0];
  if (!offer) throw new Error("No offer");
  const db = new Database(f.path, { readonly: true });
  const questionID = db
    .query<{ msgid: string }, [string]>(
      "SELECT msgid FROM irc_thread_messages WHERE botKey=? AND root='m1' ORDER BY rowid LIMIT 1",
    )
    .get(worker.key)?.msgid;
  db.close();
  expect(questionID).toBeDefined();
  if (!questionID) throw new Error("No durable crew echo anchor");
  await f.restartTransport();
  const fresh = f.ships[0]?.registrations.find((r) => r.role === "crew");
  expect(fresh?.client.anchor(questionID)).toBeUndefined();
  const at = f.send(
    `worker: answer ${offer.token} 1`,
    "crew-answer",
    "jac",
    questionID,
  );
  await f.received(at);
  await until(
    () => f.replies.length === 1,
    3000,
    "crew answer uses durable root",
  );
  expect(f.replies).toEqual([{ q0: "wait" }]);
}, 12_000);

test("short hex-like prose remains ordinary while punctuated full tokens stay reserved", async () => {
  // Only the addressed recipient runs. Broad human wake would also start
  // captain, making the count of three a transient snapshot of four prompts.
  const f = await fixture(false, false, { wake: false });
  for (const [index, word] of ["2025...", "decade…", "faded…"].entries())
    f.send(`other: answer ${word}`, `prose-${index}`);
  await until(
    () => f.prompts.length === 3,
    4000,
    "ordinary short prose admitted",
  );
  const count = f.prompts.length;
  for (const [index, punctuation] of [",", ".", ":"].entries()) {
    const at = f.send(
      `other: answer ${"a".repeat(32)}${punctuation} 1`,
      `punctuated-${index}`,
    );
    await f.received(at);
  }
  expect(f.prompts).toHaveLength(count);
  const db = new Database(f.path, { readonly: true });
  try {
    // PONG proves ingress finished; also catch a leaked control still queued.
    expect(db.query("SELECT COUNT(*) AS total FROM jobs").get()).toEqual({
      total: 3,
    });
  } finally {
    db.close();
  }
  expect(f.replies).toEqual([]);
});
