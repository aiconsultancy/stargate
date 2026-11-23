import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "@opencode/plugin/host";
import type {
  Info,
  ToolContext,
  ToolEditor,
} from "@opencode/plugin/promise/tool";
import { Agent } from "@opencode/schema/agent";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Tool } from "@opencode/schema/tool";
import { Result, Schema } from "effect";
import { fleetRequest } from "../src/coordination/fleet/client";
import {
  FleetControl,
  type FleetControlOptions,
} from "../src/coordination/fleet/control";
import { FleetLedger } from "../src/coordination/fleet/ledger";
import { installFleetTools } from "../src/fleet/plugin";
import {
  type FleetCaller,
  FleetError,
  type FleetSource,
  fleetControlSchema,
} from "../src/coordination/fleet/protocol";
import { sendFleetAssignment } from "../src/coordination/fleet/fleet-irc";
import {
  authenticateActivityRequest,
  BotFrameworkKeyStore,
} from "../src/transports/teams/botframework-auth";
import {
  APP_ID,
  activity,
  botFrameworkKeys,
  HUMAN,
  makeSigningKey,
  mockFetch,
  registrationFixture,
  signToken,
  TENANT_ID,
} from "./teams-support";

const signal = () => new AbortController().signal;

const source: FleetSource = {
  reference: "teams:conversation:human-original",
  transport: "teams",
  account: "human-object-id",
  authority: "human",
  text: "Please implement the described issue. Do not deploy it.",
  channel: "conversation",
  messageID: "human-original",
  receivedAt: "2026-11-15T12:00:00.000Z",
};

const target = {
  id: "captain",
  account: "captain-account",
  channel: "#captain",
  sessionID: "ses_target",
};

const caller = (sessionID = "ses_owner", id = "tool-call"): FleetCaller => ({
  sessionID,
  agent: "native-agent",
  messageID: "msg_native_assistant",
  id,
});

const lockCommand: NonNullable<
  NonNullable<FleetControlOptions["ownership"]>["lockCommand"]
> = (path) => ({
  command: "python3",
  args: [
    "-u",
    "-c",
    "import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX); print('R',flush=True); sys.stdin.read()",
    path,
  ],
});

async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-fleet-")),
  );

  await chmod(directory, 0o700);
  const statePath = join(directory, "evidence.sqlite");
  const controls: FleetControl[] = [];
  const sent: string[] = [];

  async function open(
    sessionID = "ses_owner",
    overrides: Partial<FleetControlOptions> = {},
  ) {
    const socketPath = join(directory, `${sessionID}.sock`);

    const control = await FleetControl.open({
      config: { socketPath, statePath, targets: [target] },
      sessionID,
      account: sessionID === "ses_owner" ? "coordinator" : "captain-account",
      allowDispatch: true,
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      async authorize(value) {
        if (value.messageID !== "msg_native_assistant")
          throw new FleetError("Unverified native input ancestry.");
      },
      async send(_target, text) {
        sent.push(text);
      },
      ownership: { lockCommand },
      ...overrides,
    });

    controls.push(control);

    return { control, socketPath };
  }

  return {
    directory,
    statePath,
    sent,
    open,
    async close() {
      await Promise.all(controls.map((control) => control.close()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("control is opt-in, requires pins/targets and rejects arbitrary destinations", () => {
  expect(
    Result.isSuccess(Schema.decodeUnknownResult(fleetControlSchema)(undefined)),
  ).toBe(false);

  const valid = {
    socketPath: "/run/gateway/control.sock",
    statePath: "/var/lib/gateway/evidence.sqlite",
    targets: [target],
  };

  expect(
    Result.isSuccess(Schema.decodeUnknownResult(fleetControlSchema)(valid)),
  ).toBe(true);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(fleetControlSchema)({
        ...valid,
        targets: [{ ...target, sessionID: undefined }],
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(fleetControlSchema)({
        ...valid,
        targets: [target, target],
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(fleetControlSchema)({
        ...valid,
        socketPath: "relative.sock",
      }),
    ),
  ).toBe(false);
});

test("authenticated evidence is immutable and inaccessible until explicit target delegation", async () => {
  const setup = await fixture();

  try {
    const owner = await setup.open();
    const receiver = await setup.open("ses_target");
    const stranger = await setup.open("ses_stranger");
    owner.control.recordSource(source);
    expect(
      owner.control.recordSource({
        ...source,
        receivedAt: "2026-11-15T13:00:00.000Z",
      }).receivedAt,
    ).toBe(source.receivedAt);
    expect(() =>
      owner.control.recordSource({ ...source, text: "forged replacement" }),
    ).toThrow("different authenticated evidence");
    await expect(
      fleetRequest(
        receiver.socketPath,
        {
          operation: "verify",
          caller: caller("ses_target"),
          input: { reference: source.reference },
        },
        signal(),
      ),
    ).rejects.toThrow("unavailable");

    const sent = await fleetRequest(
      owner.socketPath,
      {
        operation: "dispatch",
        caller: caller(),
        input: {
          target: "captain",
          text: "Implement the issue within the recorded scope.",
          sourceReference: source.reference,
        },
      },
      signal(),
    );

    expect(sent).toMatchObject({
      state: "sent",
      humanApproval: false,
      senderAccount: "coordinator",
    });
    expect(setup.sent).toHaveLength(1);
    expect(setup.sent[0]).toContain("from=coordinator");
    expect(setup.sent[0]).toContain(source.reference);
    expect(setup.sent[0]).toContain("not human approval");

    const evidence = await fleetRequest(
      receiver.socketPath,
      {
        operation: "verify",
        caller: caller("ses_target"),
        input: { reference: source.reference },
      },
      signal(),
    );

    expect(evidence).toMatchObject({
      ...source,
      ownerSessionID: "ses_owner",
      humanApproval: false,
    });
    await expect(
      fleetRequest(
        stranger.socketPath,
        {
          operation: "verify",
          caller: caller("ses_stranger"),
          input: { reference: source.reference },
        },
        signal(),
      ),
    ).rejects.toThrow("unavailable");
  } finally {
    await setup.close();
  }
});

test("same request ID never sends twice and conflicting work cannot reuse it", async () => {
  const setup = await fixture();

  try {
    const owner = await setup.open();
    owner.control.recordSource(source);

    const request = {
      operation: "dispatch" as const,
      caller: caller(),
      input: {
        target: "captain",
        text: "Read the issue",
        sourceReference: source.reference,
        requestID: "durable-id",
      },
    };

    const first = await fleetRequest(owner.socketPath, request, signal());
    expect(await fleetRequest(owner.socketPath, request, signal())).toEqual(
      first,
    );
    await expect(
      fleetRequest(
        owner.socketPath,
        { ...request, input: { ...request.input, text: "Different work" } },
        signal(),
      ),
    ).rejects.toThrow("different work");
    expect(setup.sent).toHaveLength(1);
  } finally {
    await setup.close();
  }
});

test("direct socket requests cannot bypass a trusted gateway permission denial", async () => {
  const setup = await fixture();

  try {
    const owner = await setup.open("ses_owner", {
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "fleet_dispatch", resource: "captain", effect: "deny" },
      ],
    });

    owner.control.recordSource(source);
    await expect(
      fleetRequest(
        owner.socketPath,
        {
          operation: "dispatch",
          caller: { ...caller(), id: "fabricated-call" },
          input: {
            target: "captain",
            text: "Bypass native permission",
            sourceReference: source.reference,
            requestID: "fresh-id",
          },
        },
        signal(),
      ),
    ).rejects.toThrow("Trusted gateway policy refuses");
    expect(setup.sent).toEqual([]);

    const verified = await fleetRequest(
      owner.socketPath,
      {
        operation: "verify",
        caller: caller(),
        input: { reference: source.reference },
      },
      signal(),
    );

    expect(verified).toMatchObject({ reference: source.reference });
  } finally {
    await setup.close();
  }
});

test("direct socket dispatch cannot bypass a disabled gateway capability", async () => {
  const setup = await fixture();

  try {
    const owner = await setup.open("ses_owner", { allowDispatch: false });
    owner.control.recordSource(source);
    await expect(
      fleetRequest(
        owner.socketPath,
        {
          operation: "dispatch",
          caller: caller(),
          input: {
            target: "captain",
            text: "Work",
            sourceReference: source.reference,
          },
        },
        signal(),
      ),
    ).rejects.toThrow("disabled by this gateway's capability policy");
    expect(
      await fleetRequest(
        owner.socketPath,
        {
          operation: "verify",
          caller: caller(),
          input: { reference: source.reference },
        },
        signal(),
      ),
    ).toMatchObject({ text: source.text });
    expect(
      await fleetRequest(
        owner.socketPath,
        { operation: "status", caller: caller(), input: {} },
        signal(),
      ),
    ).toMatchObject({ account: "coordinator" });
    expect(setup.sent).toHaveLength(0);
  } finally {
    await setup.close();
  }
});

test("unknown delivery survives a gateway restart and is never blindly resent", async () => {
  const setup = await fixture();
  let calls = 0;

  try {
    const options = {
      async send() {
        calls++;
        throw new Error("raw provider payload containing a secret");
      },
    };

    const owner = await setup.open("ses_owner", options);
    owner.control.recordSource(source);

    const request = {
      operation: "dispatch" as const,
      caller: caller(),
      input: {
        target: "captain",
        text: "Read the issue",
        sourceReference: source.reference,
        requestID: "uncertain-id",
      },
    };

    expect(
      await fleetRequest(owner.socketPath, request, signal()),
    ).toMatchObject({ state: "unknown" });
    await owner.control.close();
    const restarted = await setup.open("ses_owner", options);
    expect(
      await fleetRequest(restarted.socketPath, request, signal()),
    ).toMatchObject({ state: "unknown" });
    expect(
      await fleetRequest(
        restarted.socketPath,
        {
          operation: "status",
          caller: caller(),
          input: { requestID: "uncertain-id" },
        },
        signal(),
      ),
    ).toMatchObject({ state: "unknown" });
    expect(calls).toBe(1);
  } finally {
    await setup.close();
  }
});

test("foreign native pins, missing ancestry, missing evidence and unconfigured targets fail closed", async () => {
  const setup = await fixture();

  try {
    const owner = await setup.open();
    owner.control.recordSource(source);
    await expect(
      fleetRequest(
        owner.socketPath,
        { operation: "status", caller: caller("ses_foreign"), input: {} },
        signal(),
      ),
    ).rejects.toThrow("native session pin");
    await expect(
      fleetRequest(
        owner.socketPath,
        {
          operation: "status",
          caller: { ...caller(), messageID: "model-claimed-input" },
          input: {},
        },
        signal(),
      ),
    ).rejects.toThrow("Unverified native input ancestry");
    await expect(
      fleetRequest(
        owner.socketPath,
        {
          operation: "dispatch",
          caller: caller(),
          input: {
            target: "arbitrary",
            text: "Work",
            sourceReference: source.reference,
          },
        },
        signal(),
      ),
    ).rejects.toThrow("not configured");
    await expect(
      fleetRequest(
        owner.socketPath,
        {
          operation: "dispatch",
          caller: caller(),
          input: { target: "captain", text: "Work", sourceReference: "forged" },
        },
        signal(),
      ),
    ).rejects.toThrow("unavailable");
    owner.control.recordSource({
      ...source,
      reference: "context",
      authority: "context",
    });
    await expect(
      fleetRequest(
        owner.socketPath,
        {
          operation: "dispatch",
          caller: caller(),
          input: {
            target: "captain",
            text: "Work",
            sourceReference: "context",
          },
        },
        signal(),
      ),
    ).rejects.toThrow("Context-only");
    expect(setup.sent).toHaveLength(0);
  } finally {
    await setup.close();
  }
});

test("private ledger rejects symlinks and world-accessible existing files", async () => {
  const setup = await fixture();

  try {
    const file = join(setup.directory, "unsafe.sqlite");
    await writeFile(file, "", { mode: 0o644 });
    expect(() => new FleetLedger(file)).toThrow("private regular file");
    const link = join(setup.directory, "link.sqlite");
    await symlink(file, link);
    expect(() => new FleetLedger(link)).toThrow();
    const ledger = new FleetLedger(setup.statePath);
    expect((await stat(setup.statePath)).mode & 0o777).toBe(0o660);
    expect((await stat(`${setup.statePath}-wal`)).mode & 0o777).toBe(0o660);
    expect((await stat(`${setup.statePath}-shm`)).mode & 0o777).toBe(0o660);
    ledger.close();
  } finally {
    await setup.close();
  }
});

test("the real V2 loader resolves the local fleet package and Effect adapter", async () => {
  const entry = Host.resolve({
    directory: join(import.meta.dir, "../src/fleet"),
  }).server;

  expect(entry?.endsWith("/src/fleet/plugin.ts")).toBe(true);

  if (!entry) throw new Error("Missing fleet plugin entrypoint");
  expect(await Host.load(entry)).toMatchObject({
    default: { id: "stargate.fleet", effect: expect.any(Function) },
  });
});

test("OpenCode tools assert native permission and bind native caller, never model fields", async () => {
  const setup = await fixture();
  const tools: Info[] = [];
  let denied = false;
  let disposed = false;
  const permissions: unknown[] = [];

  try {
    const owner = await setup.open();
    owner.control.recordSource(source);

    const editor: ToolEditor = {
      list: () => [],
      get: () => undefined,
      namespace() {},
      add(tool) {
        tools.push(tool);
      },
      update() {},
      remove() {},
    };

    const cleanup = await installFleetTools({
      options: { socketPath: owner.socketPath },
      tool: {
        async transform(callback) {
          callback(editor);

          return {
            async dispose() {
              disposed = true;
            },
          };
        },
      },
      permission: {
        async assert(input) {
          permissions.push(input);

          if (denied) throw new Error("native permission denied");
        },
      },
    });

    const context: ToolContext = {
      sessionID: Session.ID.make("ses_owner"),
      agent: Agent.ID.make("actual-native-agent"),
      messageID: SessionMessage.ID.make("msg_native_assistant"),
      id: Tool.CallID.make("call_native"),
      signal: signal(),
      async progress() {},
    };

    expect(tools.map((tool) => tool.name)).toEqual([
      "fleet_verify_instruction",
      "fleet_dispatch",
      "fleet_answer_offer",
      "fleet_status",
    ]);

    const verify = tools.find(
      (tool) => tool.name === "fleet_verify_instruction",
    );

    expect(verify).toBeDefined();

    const output = await verify?.execute(
      { reference: source.reference },
      context,
    );

    expect(JSON.parse(String(output?.content))).toMatchObject({
      account: source.account,
      text: source.text,
      humanApproval: false,
    });
    expect(permissions).toEqual([
      {
        sessionID: "ses_owner",
        agent: "actual-native-agent",
        source: {
          type: "tool",
          messageID: "msg_native_assistant",
          id: "call_native",
        },
        action: "fleet_verify_instruction",
        resources: [source.reference],
        save: [source.reference],
      },
    ]);
    denied = true;
    await expect(
      verify?.execute({ reference: source.reference }, context),
    ).rejects.toThrow("native permission denied");
    expect(setup.sent).toHaveLength(0);
    await cleanup();
    expect(disposed).toBe(true);
  } finally {
    await setup.close();
  }
});

test("authenticated Teams instruction dispatches as Vance, captain verifies original, receipt reply retains Teams origin", async () => {
  const setup = await fixture();
  const teams = registrationFixture({ fleet: true });

  try {
    const original = activity({
      id: "original-teams-instruction",
      text: "<at>Vance</at> Implement the agreed issue.\nKeep the deployment for a human.",
      timestamp: "2026-11-15T12:00:00.000Z",
    });

    const originByNativeAssistant = new Map([
      ["msg_vance_reply", "native-human-input"],
    ]);

    let batches = 0;

    const irc: Parameters<typeof sendFleetAssignment>[0] = {
      async waitReady() {},
      budget: () => 350,
      multiline: { maxBytes: 4096, maxLines: 100 },
      async privmsg(_channel, text) {
        setup.sent.push(text);
      },
      async sendBatch(_channel, lines) {
        batches++;
        setup.sent.push(
          lines
            .map((line, index) =>
              index && !line.concat ? `\n${line.text}` : line.text,
            )
            .join(""),
        );
      },
    };

    const owner = await setup.open("ses_owner", {
      account: "vance",
      send: (destination, text, requestSignal) =>
        sendFleetAssignment(
          irc,
          destination.channel,
          text,
          () => true,
          requestSignal,
        ),
      async authorize(value) {
        if (
          !teams.store
            .permissionCandidates(teams.registration.key)
            .some(
              (job) =>
                job.input === originByNativeAssistant.get(value.messageID),
            )
        )
          throw new FleetError("No retained native input for this tool call");
      },
    });

    const captain = await setup.open("ses_target");
    teams.registration.sourceRecorder = (value) => {
      owner.control.recordSource(value);
    };

    const key = await makeSigningKey();

    const keys = new BotFrameworkKeyStore({
      fetch: mockFetch(botFrameworkKeys([key.jwk])).fetch,
    });

    // The real JWT/serviceUrl/channel checks run before trusted registration intake.
    await authenticateActivityRequest(
      `Bearer ${await signToken(key)}`,
      original,
      { keyStore: keys, appId: APP_ID },
    );
    const job = await teams.running(original);

    const originalReference =
      teams.registration.transport.source?.(job)?.reference;

    if (!originalReference)
      throw new Error("Authenticated source reference missing");
    const tools: Info[] = [];
    const permissions: unknown[] = [];

    const cleanup = await installFleetTools({
      options: { socketPath: owner.socketPath },
      permission: {
        async assert(value) {
          permissions.push(value);
        },
      },
      tool: {
        async transform(callback) {
          callback({
            list: () => [],
            get: () => undefined,
            namespace() {},
            add(tool) {
              tools.push(tool);
            },
            update() {},
            remove() {},
          });

          return { async dispose() {} };
        },
      },
    });

    const dispatch = tools.find((tool) => tool.name === "fleet_dispatch");

    if (!dispatch) throw new Error("Missing dispatch tool");

    const context: ToolContext = {
      sessionID: Session.ID.make("ses_owner"),
      agent: Agent.ID.make("vance"),
      messageID: SessionMessage.ID.make("msg_vance_reply"),
      id: Tool.CallID.make("call_vance_dispatch"),
      signal: signal(),
      async progress() {},
    };

    const result = await dispatch.execute(
      {
        target: "captain",
        text: "Implement the agreed issue.\nDo not deploy it.",
        sourceReference: originalReference,
      },
      context,
    );

    expect(JSON.parse(String(result.content))).toMatchObject({
      state: "sent",
      senderAccount: "vance",
      humanApproval: false,
    });
    expect(setup.sent[0]).toContain(
      `from=vance source=${originalReference} authority=human; not human approval`,
    );
    expect(batches).toBe(1);
    expect(permissions).toMatchObject([
      {
        sessionID: "ses_owner",
        agent: "vance",
        source: { messageID: "msg_vance_reply", id: "call_vance_dispatch" },
      },
    ]);

    const verified = await fleetRequest(
      captain.socketPath,
      {
        operation: "verify",
        caller: caller("ses_target"),
        input: { reference: originalReference },
      },
      signal(),
    );

    expect(verified).toMatchObject({
      transport: "teams",
      account: HUMAN,
      text: original.text,
      channel: original.conversation.id,
      messageID: original.id,
      authority: "human",
      humanApproval: false,
    });
    // A later request on the same pinned root must not steal the original reply.
    await teams.registration.accept(
      activity({
        id: "later-message",
        conversation: {
          id: "other-chat",
          conversationType: "personal",
          tenantId: TENANT_ID,
        },
        text: "Another question",
      }),
    );
    await teams.registration.delivery.post(
      job.channel,
      job.thread,
      "Captain has the verified instruction; work is assigned.",
    );
    expect(teams.sent.at(-1)).toMatchObject({
      conversation: original.conversation.id,
      activity: {
        replyToId: original.id,
        text: "Captain has the verified instruction; work is assigned.",
      },
    });
    await cleanup();
  } finally {
    await teams.close();
    await setup.close();
  }
});
