import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import pino from "pino";
import { ircSchema } from "../src/config";
import { fleetRequest } from "../src/coordination/fleet/client";
import {
  FleetControl,
  type FleetControlOptions,
} from "../src/coordination/fleet/control";
import { installFleetTools } from "../src/fleet/plugin";
import {
  type FleetOrigin,
  type FleetRequest,
  type FleetReviewBinding,
  type FleetReviewEvidence,
  type FleetReviewNative,
  fleetControlSchema,
  requestSchema,
  reviewAgentSchema,
  reviewAssignmentSchema,
  reviewContextSchema,
  reviewProofSchema,
} from "../src/coordination/fleet/protocol";
import { reviewContextPrompt } from "../src/coordination/fleet/review-prompts";
import { IrcShip } from "../src/transports/irc/ship";
import { openStore } from "../src/app/open-store";
import { FakeIrcServer, until } from "./irc-fixture";

const close: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const f of close.splice(0).reverse()) await f();
});

const signal = () => new AbortController().signal;

const diff =
  "diff --git a/index.ts b/index.ts\nindex 1111111..2222222 100644\n--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-old\n+new\n";

const target = {
  repository: "example/project",
  pullRequest: 7,
  headSHA: "a".repeat(40),
  baseSHA: "b".repeat(40),
  mergeBaseSHA: "c".repeat(40),
};

const lockCommand: NonNullable<
  NonNullable<FleetControlOptions["ownership"]>["lockCommand"]
> = (path) => ({
  command: "python3",
  args: [
    "-u",
    "-c",
    "import fcntl,sys;f=open(sys.argv[1]);fcntl.flock(f,fcntl.LOCK_EX);print('R',flush=True);sys.stdin.read()",
    path,
  ],
});

class Native implements FleetReviewNative {
  starts: FleetReviewBinding[] = [];
  reads: FleetReviewBinding[] = [];
  answers = new Map<string, FleetReviewEvidence>();
  failAdmission = false;
  async startReview(binding: FleetReviewBinding) {
    this.starts.push(binding);

    if (this.failAdmission) throw new Error("uncertain transport");
  }
  async readReview(binding: FleetReviewBinding) {
    this.reads.push(binding);

    return this.answers.get(binding.id);
  }
  finish(
    binding: FleetReviewBinding,
    options: {
      model?: string;
      agent?: string;
      verdict?: string;
      head?: string;
      digest?: string;
    } = {},
  ) {
    const {
      id: _id,
      authorShip: _author,
      coordinatorShip: _coordinator,
      coordinatorSessionID: _session,
      dispatchID: _dispatch,
      ...context
    } = binding.context;

    const resultText = JSON.stringify({
      ...context,
      headSHA: options.head ?? context.headSHA,
      contextDigest: options.digest ?? context.contextDigest,
      verdict: options.verdict ?? "approve",
      summary: "Reviewed the exact supplied code changes",
      findings: [],
    });

    this.answers.set(binding.id, {
      resultText,
      makers: [
        {
          messageID: `native_${binding.inputID}`,
          agent: options.agent ?? binding.reviewer.agent,
          provider: "unit",
          model:
            options.model ?? binding.reviewer.models[0]?.model ?? "missing",
        },
      ],
    });
  }
}

function raw(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath, method, path }, (res) => {
      let text = "";
      res.on("data", (b: Buffer) => {
        text += b.toString();
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }),
      );
    });

    r.on("error", reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const reviewers = [
  {
    agent: "gpt",
    kind: "crew" as const,
    family: "codex",
    directory: "/project/gpt",
    models: [{ provider: "unit", model: "gpt" }],
    permissions: [],
  },
  {
    agent: "claude",
    kind: "crew" as const,
    family: "claude",
    directory: "/project/claude",
    models: [{ provider: "unit", model: "claude" }],
    permissions: [],
  },
  {
    agent: "captain-peer",
    kind: "captain" as const,
    family: "codex",
    directory: "/project/root",
    models: [{ provider: "unit", model: "gpt" }],
    permissions: [],
  },
];

async function world(
  enabled = true,
  coordinatorAccount = "peer",
  reviewConfig: NonNullable<FleetControlOptions["config"]["reviews"]> = {
    repositories: [target.repository],
    reviewers,
  },
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-review-")),
  );

  await chmod(directory, 0o700);
  close.push(() => rm(directory, { recursive: true, force: true }));
  const native = new Native();

  let current: FleetOrigin = {
    botKey: "peer-bot",
    eventId: "peer-event-1",
    sessionID: "ses_peer",
    inputID: "peer-input-1",
  };

  const sent: string[] = [];
  let serial = 0;
  const controls: FleetControl[] = [];

  const options = (ship: string): FleetControlOptions => ({
    config: {
      socketPath: join(directory, ship + ".sock"),
      statePath: join(directory, "ledger.sqlite"),
      results: true,
      targets: [
        {
          id: "peer",
          account: coordinatorAccount,
          channel: "#peer",
          sessionID: "ses_peer",
        },
      ],
      ...(enabled ? { reviews: reviewConfig } : {}),
    },
    sessionID: `ses_${ship}`,
    account: ship,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    allowDispatch: true,
    nativeReviews: native,
    authorize: async (caller) => {
      if (caller.messageID !== "msg_live_assistant")
        throw new Error("not live");

      return ship === "peer"
        ? current
        : {
            botKey: "author-bot",
            eventId: "author-event",
            sessionID: "ses_author",
            inputID: "author-input",
          };
    },
    origin: () => ({
      botKey: "author-bot",
      eventId: "author-event",
      sessionID: "ses_author",
      inputID: "author-input",
    }),
    send: async (_target, text) => {
      sent.push(text);
    },
    ownership: { lockCommand },
  });

  const author = await FleetControl.open(options("author"));
  controls.push(author);
  let peer = await FleetControl.open(options("peer"));
  controls.push(peer);
  const stranger = await FleetControl.open(options("stranger"));
  controls.push(stranger);
  close.push(async () => {
    for (const c of controls.reverse()) await c.close();
  });
  author.recordSource({
    reference: "human-source",
    transport: "teams",
    account: "human",
    authority: "human",
    text: "Arrange independent reviews",
    channel: "conversation",
    messageID: "message",
    receivedAt: new Date().toISOString(),
    origin: { botKey: "author-bot", eventId: "author-event" },
  });

  const call = (
    ship: string,
    operation: FleetRequest["operation"],
    input: unknown,
  ) =>
    fleetRequest(
      join(directory, ship + ".sock"),
      Schema.decodeUnknownSync(requestSchema)({
        operation,
        input,
        caller: {
          sessionID: `ses_${ship}`,
          agent: "captain-peer",
          messageID: "msg_live_assistant",
          id: `call-${++serial}`,
        },
      }),
      signal(),
    );

  async function begin(overrides: Record<string, unknown> = {}, admit = true) {
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ dispatchID: Schema.String, review: reviewContextSchema }),
    )(
      await call("author", "dispatch", {
        target: "peer",
        sourceReference: "human-source",
        text: "Coordinate independent reviews",
        review: { ...target, context: diff, ...overrides },
      }),
    );

    current = {
      ...current,
      eventId: `peer-event-${serial}`,
      inputID: `peer-input-${serial}`,
    };
    const packet = sent.at(-1);

    if (!packet) throw new Error("No dispatch");
    expect(packet).not.toContain("--- a/index.ts");

    if (admit)
      expect(
        peer.assignment(
          {
            sender: "author",
            channel: "#peer",
            text: packet,
            botKey: current.botKey,
            eventId: current.eventId,
          },
          (s) => s.toLowerCase(),
        ),
      ).toBe(result.dispatchID);
    const prompt = peer.reviewAssignmentPrompt(result.dispatchID);
    expect(prompt).toContain(diff);
    expect(prompt).toContain(result.review.contextDigest);

    return result.review;
  }

  async function start(reviewID: string, agent = "gpt") {
    return Schema.decodeUnknownSync(
      Schema.Struct({
        id: Schema.String,
        state: Schema.String,
        sessionID: Schema.String,
        inputID: Schema.String,
      }),
    )(
      await call("peer", "review", {
        op: "start",
        reviewID,
        reviewerAgent: agent,
      }),
    );
  }

  async function proofs(ship = "author", head = target.headSHA) {
    const r = await raw(
      join(directory, ship + ".sock"),
      "GET",
      `/reviews?repository=${target.repository}&pullRequest=7&headSHA=${head}`,
    );

    expect(r.status).toBe(200);

    return Schema.decodeUnknownSync(
      Schema.Struct({
        proofs: Schema.mutable(Schema.Array(reviewProofSchema)),
      }),
    )(r.body).proofs;
  }

  return {
    directory,
    native,
    author,
    stranger,
    call,
    begin,
    start,
    proofs,
    get packet() {
      return sent.at(-1) ?? "";
    },
    get peer() {
      return peer;
    },
    get current() {
      return current;
    },
    set current(value: FleetOrigin) {
      current = value;
    },
    async reopen() {
      await peer.close();
      peer = await FleetControl.open(options("peer"));
      controls.push(peer);
    },
  };
}

test("two attested native-family proofs share an independent reviewer ship and preserve exact immutable context", async () => {
  const w = await world();
  const context = await w.begin();

  const a = await w.start(context.id),
    b = await w.start(context.id, "claude");

  expect(a.id).not.toBe(b.id);
  expect(a.sessionID).not.toBe(b.sessionID);
  expect(a.inputID).not.toBe(b.inputID);

  for (const binding of w.native.starts) w.native.finish(binding);
  await w.peer.pollReviews(signal());
  const proofs = await w.proofs();
  expect(proofs).toHaveLength(2);
  expect(new Set(proofs.map((p) => p.family))).toEqual(
    new Set(["codex", "claude"]),
  );

  for (const proof of proofs) {
    expect(proof).toMatchObject({
      ...target,
      authorShip: "author",
      coordinatorShip: "peer",
      reviewerShip: "peer",
      outcome: "completed",
      verdict: "approve",
      authority: "agent",
      humanApproval: false,
    });
    expect(proof.contextDigest).toBe(
      createHash("sha256").update(diff).digest("hex"),
    );
    expect(proof.resultDigest).toBe(
      createHash("sha256").update(proof.resultText).digest("hex"),
    );
  }

  expect(await w.proofs("stranger")).toEqual([]);
  expect(await w.proofs("author", "d".repeat(40))).toEqual([]);

  const found = await raw(
    join(w.directory, "peer.sock"),
    "GET",
    "/reviews/" + a.id,
  );

  expect(found.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(Schema.Struct({ proof: reviewProofSchema }))(
      found.body,
    ).proof.id,
  ).toBe(a.id);
  expect(
    (await raw(join(w.directory, "stranger.sock"), "GET", "/reviews/" + a.id))
      .status,
  ).toBe(404);
});

test("native crew review opens the protected directory for the assigned repository", async () => {
  const repository = "example/another";

  const reviewConfig = {
    repositories: [target.repository, repository],
    reviewers,
    crewDirectories: {
      [target.repository]: { gpt: "/project/gpt", claude: "/project/claude" },
      [repository]: { gpt: "/another/gpt", claude: "/another/claude" },
    },
  };

  const w = await world(true, "peer", reviewConfig);
  const context = await w.begin({ repository });
  await w.start(context.id);
  expect(w.native.starts[0]?.reviewer.directory).toBe("/another/gpt");
  expect(w.native.starts[0]?.context.repository).toBe(repository);
  const captain = await w.start(context.id, "captain-peer");
  expect(captain.sessionID).toBe("ses_peer");
  expect(w.native.starts).toHaveLength(1);
  await expect(w.begin({ repository: "example/third" })).rejects.toThrow(
    "not permitted",
  );
});

test("review configuration requires exactly the configured repositories and crew reviewers", () => {
  const crew = { gpt: "/project/gpt", claude: "/project/claude" };

  const config = {
    socketPath: "/tmp/x",
    statePath: "/tmp/state",
    targets: [
      { id: "peer", account: "peer", channel: "#peer", sessionID: "peer" },
    ],
    results: true,
    reviews: {
      repositories: [target.repository],
      reviewers,
      crewDirectories: { [target.repository]: crew },
    },
  };

  expect(
    Result.isSuccess(Schema.decodeUnknownResult(fleetControlSchema)(config)),
  ).toBe(true);
  expect(
    Schema.decodeUnknownSync(fleetControlSchema)({
      ...config,
      reviews: {
        ...config.reviews,
        crewDirectories: { "EXAMPLE/PROJECT": crew },
      },
    }).reviews?.crewDirectories,
  ).toEqual({ [target.repository]: crew });

  for (const crewDirectories of [
    {},
    { [target.repository]: { gpt: crew.gpt } },
    {
      [target.repository]: { ...crew, "captain-peer": "/foreign" },
    },
    { ...config.reviews.crewDirectories, "example/extra": crew },
  ]) {
    expect(() =>
      Schema.decodeUnknownSync(fleetControlSchema)({
        ...config,
        reviews: { ...config.reviews, crewDirectories },
      }),
    ).toThrow(
      "Review directories must bind each permitted repository to every configured crew reviewer",
    );
  }

  expect(() =>
    Schema.decodeUnknownSync(fleetControlSchema)({
      ...config,
      reviews: {
        ...config.reviews,
        crewDirectories: {
          ...config.reviews.crewDirectories,
          "invalid repository": crew,
        },
      },
    }),
  ).toThrow();
});

test("review evidence stays off by default and does not admit completion claims", async () => {
  const w = await world(false);
  await expect(
    w.call("author", "dispatch", {
      target: "peer",
      sourceReference: "human-source",
      text: "review",
      review: { ...target, context: diff },
    }),
  ).rejects.toThrow("disabled");
  expect(
    (
      await raw(
        join(w.directory, "peer.sock"),
        "GET",
        "/reviews?repository=example/project&pullRequest=7&headSHA=" +
          target.headSHA,
      )
    ).status,
  ).toBe(404);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(requestSchema)({
        operation: "completeReview",
        caller: {},
        input: { verdict: "approve" },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(fleetControlSchema)({
        socketPath: "/tmp/x",
        statePath: "/tmp/state",
        targets: [
          { id: "peer", account: "peer", channel: "#peer", sessionID: "peer" },
        ],
        reviews: { repositories: [target.repository], reviewers },
      }),
    ),
  ).toBe(false);
});

test("missing, binary, malformed, oversized and disallowed review context fails before any native admission", async () => {
  const w = await world();

  for (const context of [
    "",
    diff.replace("+new\n", ""),
    diff + "\nGIT binary patch\n",
    diff + "\u0000",
    diff + "\ud800",
    "diff --git " + "x".repeat(256_000),
  ])
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(reviewAssignmentSchema)({
          ...target,
          context,
        }),
      ),
    ).toBe(false);
  await expect(w.begin({ repository: "other/project" })).rejects.toThrow(
    "not permitted",
  );
  expect(w.native.starts).toEqual([]);
});

test("wrong family, native agent, head, digest or verdict never becomes approving proof", async () => {
  for (const change of [
    { model: "claude" },
    { agent: "captain-peer" },
    { head: "d".repeat(40) },
    { digest: "0".repeat(64) },
    { verdict: "APPROVED" },
  ]) {
    const w = await world();
    const c = await w.begin();
    await w.start(c.id);
    const binding = w.native.starts[0];

    if (!binding) throw new Error("No native review");
    w.native.finish(binding, change);
    await w.peer.pollReviews(signal());
    expect(await w.proofs()).toEqual([]);
  }
});

test("duplicate start and gateway restart recover the same proof without resubmitting work", async () => {
  const w = await world();
  const c = await w.begin();
  const first = await w.start(c.id);
  expect((await w.start(c.id)).id).toBe(first.id);
  expect(w.native.starts).toHaveLength(1);
  const binding = w.native.starts[0];

  if (!binding) throw new Error("No native binding");
  await w.reopen();
  expect((await w.start(c.id)).id).toBe(first.id);
  expect(w.native.starts).toHaveLength(1);
  w.native.finish(binding);
  await w.peer.pollReviews(signal());
  await w.peer.pollReviews(signal());
  expect(await w.proofs()).toHaveLength(1);
});

test("an uncertain admission is never replayed and cannot borrow another native result", async () => {
  const w = await world();
  w.native.failAdmission = true;
  const c = await w.begin();
  const first = await w.start(c.id);
  expect(first.state).toBe("uncertain");
  await w.reopen();
  await w.start(c.id);
  await w.peer.pollReviews(signal());
  expect(w.native.starts).toHaveLength(1);
  expect(await w.proofs()).toEqual([]);
});

test("captain substitution binds only the original review input, never an intervening conversation", async () => {
  const w = await world();
  const c = await w.begin();
  const original = w.current;
  w.current = {
    ...original,
    eventId: "another-event",
    inputID: "another-input",
  };
  await expect(w.start(c.id, "captain-peer")).rejects.toThrow("exact admitted");
  w.current = original;
  const a = await w.start(c.id, "captain-peer");
  expect(a.sessionID).toBe("ses_peer");
  expect(a.inputID).toBe(original.inputID);
  expect(w.native.starts).toEqual([]);
  await w.peer.pollReviews(signal());
  const binding = w.native.reads.at(-1);

  if (!binding) throw new Error("No read");
  w.native.finish(binding);
  await w.peer.pollReviews(signal());
  expect((await w.proofs())[0]?.kind).toBe("captain");
});

test("proof reads are strict and cannot write arbitrary proof/verdict/family claims", async () => {
  const w = await world();
  const c = await w.begin();

  for (const path of [
    "/reviews?repository=example/project&pullRequest=7&headSHA=" +
      target.headSHA +
      "&headSHA=" +
      target.headSHA,
    "/reviews?repository=example/project&pullRequest=7",
    "/reviews?repository=*&pullRequest=7&headSHA=" + target.headSHA,
  ])
    expect(
      (await raw(join(w.directory, "peer.sock"), "GET", path)).status,
    ).toBe(400);

  for (const pullRequest of ["07", "0", "-1", "1e2", "9007199254740992"]) {
    const response = await raw(
      join(w.directory, "peer.sock"),
      "GET",
      `/reviews?repository=example/project&pullRequest=${pullRequest}&headSHA=${target.headSHA}`,
    );

    expect(response).toEqual({
      status: 400,
      body: { error: "Fleet operation unavailable; raw details withheld." },
    });
  }

  const bad = {
    operation: "review",
    caller: {
      sessionID: "ses_peer",
      agent: "captain-peer",
      messageID: "msg_live_assistant",
      id: "forged",
    },
    input: {
      op: "start",
      reviewID: c.id,
      reviewerAgent: "gpt",
      family: "codex",
      verdict: "approve",
      sessionID: "old-session",
      inputID: "old-input",
    },
  };

  expect(
    (await raw(join(w.directory, "peer.sock"), "POST", "/fleet", bad)).status,
  ).toBe(400);
  expect(w.native.starts).toEqual([]);
});

test("review context framing refuses digest substitution or ambiguous end markers", () => {
  const context = Schema.decodeUnknownSync(reviewContextSchema)({
    ...target,
    id: "id",
    authorShip: "author",
    coordinatorShip: "peer",
    coordinatorSessionID: "ses_peer",
    dispatchID: "dispatch",
    contextDigest: createHash("sha256").update(diff).digest("hex"),
  });

  expect(() => reviewContextPrompt(context, diff + "changed")).toThrow(
    "changed",
  );
  const text = diff + "END_REVIEW_id";
  expect(() =>
    reviewContextPrompt(
      {
        ...context,
        contextDigest: createHash("sha256").update(text).digest("hex"),
      },
      text,
    ),
  ).toThrow("ambiguous");
});

test("same-ship coordination is refused before review work is sent", async () => {
  const w = await world(true, "AUTHOR");
  await expect(w.begin()).rejects.toThrow("another ship");
  expect(w.packet).toBe("");
  expect(w.native.starts).toEqual([]);
});

test("authenticated IRC intake injects exact private context before retaining the coordinator job", async () => {
  const w = await world();

  const server = new FakeIrcServer({
    accounts: { peer: "fixture-password" },
  }).start();

  close.push(() => server.stop());
  server.caps.push("draft/multiline=max-bytes=4096,max-lines=100");
  const store = openStore(join(w.directory, "irc.sqlite"));
  close.push(() => store.close());

  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "peer",
    account: "peer",
    passwordEnv: "IRC_PASSWORD",
    server: { host: "127.0.0.1", port: server.port, tls: false },
    channels: ["#peer"],
    backend: {
      type: "opencode",
      url: "http://127.0.0.1:1",
      directory: "/project/root",
      sessionID: "ses_peer",
      agent: "captain-peer",
    },
    access: {
      allowedAccounts: ["author"],
      peerCaptains: ["author"],
      channelRequests: "nick-mention",
      allCallWords: [],
    },
    fleetPolicy: {
      role: "captain",
      humanAccounts: ["human"],
      agentAccounts: ["author"],
      assignedCheckout: "/project/root",
      capabilities: ["dispatch"],
    },
    fleetControl: {
      socketPath: join(w.directory, "peer.sock"),
      statePath: join(w.directory, "ledger.sqlite"),
      results: true,
      targets: [
        {
          id: "author",
          account: "author",
          channel: "#author",
          sessionID: "ses_author",
        },
      ],
      reviews: { repositories: [target.repository], reviewers },
    },
    features: { catchUp: false },
  });

  const ship = await IrcShip.create(config, store, pino({ enabled: false }), {
    env: { IRC_PASSWORD: "fixture-password" },
    timing: { intervalMs: 1, burst: 100 },
    readyMs: 2000,
  });

  close.push(() => ship.close());
  ship.assignmentRecorder = (input, fold) => w.peer.assignment(input, fold);
  ship.assignmentPrompt = (id) => w.peer.reviewAssignmentPrompt(id);
  ship.start(() => true);
  const registration = ship.registrations[0];

  if (!registration) throw new Error("No IRC registration");
  await until(() => registration.client.inChannel("#peer"), 3000, "join");
  const c = await w.begin({}, false);

  const lines = w.packet.split("\n").flatMap((line) => {
    if (!line) return [{ text: "" }];
    const chunks: { text: string; concat?: boolean }[] = [];

    for (let offset = 0; offset < line.length; offset += 300)
      chunks.push({
        text: line.slice(offset, offset + 300),
        ...(offset ? { concat: true } : {}),
      });

    return chunks;
  });

  server.sayLines({ nick: "author", account: "author" }, "#peer", lines);
  await until(
    () =>
      store.ready(registration.key, Number.MAX_SAFE_INTEGER, 1).length === 1,
    3000,
    "review intake",
  );
  const job = store.ready(registration.key, Number.MAX_SAFE_INTEGER, 1)[0];

  if (!job) throw new Error("No retained review");
  expect(job.text.endsWith(reviewContextPrompt(c, diff))).toBe(true);
  expect(job.fleet).toEqual({ kind: "assignment", dispatchID: c.id });
  w.current = {
    botKey: job.botKey,
    eventId: job.eventId,
    sessionID: "ses_peer",
    inputID: "actual-native-ingress",
  };
  const started = await w.start(c.id, "captain-peer");
  expect(started.inputID).toBe("actual-native-ingress");
});

test("opt-in native review tool preserves permission source and immutable assignment resource", async () => {
  const w = await world();
  const c = await w.begin();
  const tools: Info[] = [];
  const permission: unknown[] = [];

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

  const dispose = await installFleetTools({
    options: { socketPath: join(w.directory, "peer.sock"), reviews: true },
    tool: {
      async transform(callback) {
        callback(editor);

        return { async dispose() {} };
      },
    },
    permission: {
      async assert(value) {
        permission.push(value);
      },
    },
  });

  try {
    const review = tools.find((t) => t.name === "fleet_review");

    if (!review) throw new Error("Review tool not enabled");

    const ctx: ToolContext = {
      sessionID: Session.ID.make("ses_peer"),
      agent: Agent.ID.make("captain-peer"),
      messageID: SessionMessage.ID.make("msg_live_assistant"),
      id: Tool.CallID.make("call_review_native"),
      signal: signal(),
      async progress() {},
    };

    const output = await review.execute(
      { op: "start", reviewID: c.id, reviewerAgent: "gpt" },
      ctx,
    );

    expect(JSON.parse(String(output?.content))).toMatchObject({
      reviewID: c.id,
      state: "admitted",
      humanApproval: false,
    });
    expect(permission).toEqual([
      {
        sessionID: "ses_peer",
        agent: "captain-peer",
        source: {
          type: "tool",
          messageID: "msg_live_assistant",
          id: "call_review_native",
        },
        action: "fleet_review",
        resources: [c.id],
        save: [c.id],
      },
    ]);
  } finally {
    await dispose();
  }
});

test("review workers cannot opt into mutating, wildcard or interactive permissions", () => {
  const base = {
    agent: "worker",
    kind: "crew",
    family: "codex",
    directory: "/project/worker",
    models: [{ provider: "unit", model: "gpt" }],
  };

  for (const action of ["edit", "bash", "*", "stargate_crew"])
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(reviewAgentSchema)({
          ...base,
          permissions: [{ action, resource: "*", effect: "allow" }],
        }),
      ),
    ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(reviewAgentSchema)({
        ...base,
        permissions: [{ action: "read", resource: "*", effect: "ask" }],
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(reviewAgentSchema)({
        ...base,
        permissions: [
          { action: "read", resource: "/project/worker/**", effect: "allow" },
        ],
      }),
    ),
  ).toBe(true);
});

test("read-only recovery can recognise a late exact native completion after uncertain admission without requeue", async () => {
  const w = await world();
  w.native.failAdmission = true;
  const c = await w.begin();
  const started = await w.start(c.id);
  expect(started.state).toBe("uncertain");
  const binding = w.native.starts[0];

  if (!binding) throw new Error("No binding");
  await w.reopen();
  w.native.finish(binding);
  await w.peer.pollReviews(signal());
  expect(await w.proofs()).toHaveLength(1);
  expect(w.native.starts).toHaveLength(1);
  expect((await w.start(c.id)).id).toBe(started.id);
});

test("an author or an unadmitted relay cannot start another ship's review", async () => {
  const w = await world();
  const context = await w.begin({}, false);
  await expect(w.start(context.id)).rejects.toThrow("exact admitted");
  await expect(
    w.call("author", "review", {
      op: "start",
      reviewID: context.id,
      reviewerAgent: "gpt",
    }),
  ).rejects.toThrow("independent coordinator");
  expect(w.native.starts).toEqual([]);
});

test("a completed native captain input cannot be rebound to a different structured PR review", async () => {
  const w = await world();
  const firstContext = await w.begin();
  const original = w.current;
  const first = await w.start(firstContext.id, "captain-peer");
  await w.peer.pollReviews(signal());
  const binding = w.native.reads.find((b) => b.id === first.id);

  if (!binding) throw new Error("Missing first binding");
  w.native.finish(binding);
  await w.peer.pollReviews(signal());
  const second = await w.begin({ headSHA: "d".repeat(40) });
  w.current = { ...w.current, inputID: original.inputID };
  await expect(w.start(second.id, "captain-peer")).rejects.toThrow();
  const proofs = await w.proofs();
  expect(proofs).toHaveLength(1);
  expect(proofs[0]?.headSHA).toBe(target.headSHA);
  expect(await w.proofs("author", "d".repeat(40))).toEqual([]);
});

// Allow 101 real database and socket-lock admissions to finish on a busy host.
test("bounded review recovery rotates past 100 stuck uncertain inputs and preserves its cursor across restart", async () => {
  const w = await world();
  w.native.failAdmission = true;

  for (let i = 0; i < 101; i++) {
    const context = await w.begin();
    expect((await w.start(context.id)).state).toBe("uncertain");
  }

  expect(w.native.starts).toHaveLength(101);
  const last = w.native.starts[100];

  if (!last) throw new Error("Missing late native input");
  await w.peer.pollReviews(signal());
  expect(w.native.reads).toHaveLength(100);
  expect(w.native.reads.some((binding) => binding.id === last.id)).toBe(false);
  expect(await w.proofs()).toEqual([]);
  w.native.finish(last);
  await w.reopen();
  w.native.reads.length = 0;
  await w.peer.pollReviews(signal());
  expect(w.native.reads).toHaveLength(100);
  expect(w.native.reads[0]?.id).toBe(last.id);
  const proofs = await w.proofs();
  expect(proofs).toHaveLength(1);
  expect(proofs[0]?.id).toBe(last.id);
  expect(w.native.starts).toHaveLength(101);
  w.native.reads.length = 0;
  await w.peer.pollReviews(signal());
  expect(w.native.reads).toHaveLength(100);
  expect(w.native.reads.some((binding) => binding.id === last.id)).toBe(false);
  expect(w.native.starts).toHaveLength(101);
}, 15_000);
