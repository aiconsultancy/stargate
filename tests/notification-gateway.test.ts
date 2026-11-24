import { afterEach, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { botSchema } from "../src/config";
import { SlackGateway as Gateway } from "./slack-gateway-fixture";
import type { TransportDelivery } from "../src/gateway/ports";
import {
  NotificationStore,
  notificationInputSchema,
} from "../src/notifications/preferences/notification-store";
import {
  type NotificationReader,
  notificationKey,
} from "../src/notifications/preferences/notifications";
import { PeerDirectory } from "../src/gateway/peers";
import { handleSlackRequest } from "../src/transports/slack/slack";
import { openStore } from "../src/app/open-store";
import type { Transcriber } from "../src/chat/transcription/transcription";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

function fixture() {
  const config = bot();
  config.access.users = ["*"];
  config.access.channels = ["C123", "COTHER", "D123"];
  config.resumeSlackThreads = true;
  config.threadContext = true;
  config.access.textMentions = {
    channels: ["C123"],
    names: ["all captains", "helper"],
    muteBypassNames: ["all captains"],
  };
  config.access.peerCaptains = true;
  const preferences = new NotificationStore(":memory:");
  const store = openStore(":memory:");
  const key = notificationKey(config, identity);
  let now = Date.parse("2026-11-17T10:00:00Z");
  let operation = 0;
  const calls: string[] = [];
  const prompts: string[] = [];
  const outputs: string[] = [];

  const backend: AgentBackend = {
    supportsAttachments: true,
    async createSession() {
      calls.push("session");

      return "session";
    },
    async prompt(_session, text) {
      calls.push("prompt");
      prompts.push(text);

      return "Answer.";
    },
    async close() {},
  };

  const slack: TransportDelivery = {
    async post(_channel, _thread, text) {
      outputs.push(text);

      return "10.000";
    },
    async threadContext() {
      calls.push("history");

      return {
        messages: [{ author: "this_bot", text: "Prior answer." }],
        truncated: false,
      };
    },
    files: {
      async download() {
        calls.push("download");

        return [];
      },
      async reserveUpload() {
        throw new Error("unused");
      },
      async putUpload() {},
      async completeUpload() {},
      async sharedIn() {
        return true;
      },
    },
  };

  const transcriber: Transcriber = {
    label: "test",
    async transcribe() {
      calls.push("transcribe");

      return "all captains";
    },
  };

  const peerLookup = { run: async () => true };

  const peers = new PeerDirectory(async () => {
    await peerLookup.run();

    return {
      ok: true,
      user: {
        id: "UPEER",
        team_id: "T123",
        is_bot: true,
        name: "other-captain",
        profile: { bot_id: "BPEER" },
      },
    };
  }, identity.team);

  const reader: NotificationReader = (channel, thread) =>
    preferences.status(key, channel, thread, now);

  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
    transcriber,
    peers,
    undefined,
    reader,
  );

  cleanup.push(
    () => preferences.close(),
    () => store.close(),
    () => gateway.close(),
  );

  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];

    if (!job) {
      throw new Error("Missing job");
    }

    return job;
  };

  return {
    config,
    preferences,
    store,
    key,
    calls,
    prompts,
    outputs,
    backend,
    slack,
    gateway,
    next,
    peerLookup,
    clock: (value: number) => {
      now = value;
    },
    now: () => now,
    control: (input: unknown) =>
      preferences.operate(
        key,
        Schema.decodeUnknownSync(notificationInputSchema)(input),
        {
          id: `op-${++operation}`,
          caller: "captain",
          now,
        },
      ),
    run: async () => gateway.process(next(), new AbortController().signal),
  };
}

const target = {
  scope: "thread",
  channel: "C123",
  thread_ts: "1.000",
} as const;

const reply = (text = "ordinary", ts = "2.000") => ({
  ...event(text, ts),
  event: { ...event(text, ts).event, type: "message", thread_ts: "1.000" },
});

const peer = (text: string, ts = "2.000") => {
  const request = reply(text, ts);

  return {
    ...request,
    event: { ...request.event, user: "UPEER", bot_id: "BPEER" },
  };
};

test("muted ordinary and spoken-gated traffic stops before history, files, model or rows", async () => {
  const f = fixture();
  f.control({ op: "mute", ...target });
  f.config.transcription = {
    provider: {
      type: "azure-openai",
      endpoint: "https://speech.example.test",
      deployment: "test",
      apiVersion: "2024-06-01",
      auth: "managedIdentity",
    },
    timeoutMs: 1000,
    spokenMentions: { channels: ["C123"], names: ["all captains"] },
  };

  for (const text of [
    "ordinary",
    "helper",
    "@helper",
    "<@OTHER>",
    "<!here>",
    "<!channel>",
    "<!subteam^S123>",
    "[Notification wake: direct]",
  ]) {
    expect(await f.gateway.receive(reply(text))).toBe(false);
    expect(
      await f.gateway.receive({
        ...reply(text),
        event: { ...reply(text).event, files: [{ id: "F123" }] },
      }),
    ).toBe(false);
  }

  expect(await f.gateway.receive(peer("Calling all captains"))).toBe(false);
  expect(f.calls).toEqual([]);
  expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  expect(
    f.store.follows(JSON.stringify([f.gateway.key, "C123", "1.000"])),
  ).toBe(false);
});

test("direct and approved human broadcasts wake a muted reply once without unmuting", async () => {
  const f = fixture();
  f.control({ op: "mute", ...target });

  for (const [index, text] of [
    "<@UBOT> inspect",
    "> <@UBOT> quoted typed tag",
    "Calling ALL CAPTAINS, inspect",
  ].entries()) {
    expect(await f.gateway.receive(reply(text, `${index + 2}.000`))).toBe(true);
    await f.run();
    expect(f.prompts.at(-1)).toContain("[Notification wake:");
    expect(f.prompts.at(-1)).toContain('"thread":"1.000"');
    expect(f.prompts.at(-1)).toContain('"mode":"addressed-only"');
    expect(f.preferences.status(f.key, "C123", "1.000", f.now()).mode).toBe(
      "addressed-only",
    );
  }

  expect(f.prompts[0]).not.toContain("<@UBOT>");
  expect(f.prompts[2]).toContain('"wake":"broadcast"');
  expect(f.outputs).toEqual(["Answer.", "Answer.", "Answer."]);
  expect(await f.gateway.receive(reply("ordinary", "9.000"))).toBe(false);
});

test("unmuted alias routing, hard denies, other targets and DM behavior stay unchanged", async () => {
  const f = fixture();
  // Resume history could prove prior participation; disable it to test no-follow.
  f.config.resumeSlackThreads = false;
  expect(await f.gateway.receive(reply("Calling all captains"))).toBe(false);
  expect(f.gateway.accept(event("Calling all captains", "3.000"))).toBe(true);
  await f.run();
  expect(f.prompts[0]).not.toContain("[Notification wake:");
  f.control({ op: "mute", ...target });

  const unrelated = {
    ...reply("<@UBOT> other"),
    event: { ...reply("<@UBOT> other").event, channel: "COTHER" },
  };

  expect(f.gateway.accept(unrelated)).toBe(true);

  const dm = {
    ...event("hello", "4.000"),
    event: {
      ...event("hello", "4.000").event,
      channel: "D123",
      channel_type: "im",
    },
  };

  expect(f.gateway.accept(dm)).toBe(true);
  f.config.access.deniedUsers = ["U123"];
  expect(f.gateway.accept(reply("<@UBOT> denied"))).toBe(false);
  f.config.access.deniedUsers = [];
  f.config.access.deniedChannels = ["C123"];
  expect(f.gateway.accept(reply("Calling all captains"))).toBe(false);
});

test("verified peer direct tags wake but broadcast phrases and existing peer cap do not", async () => {
  const f = fixture();
  f.control({ op: "mute", ...target });
  expect(await f.gateway.receive(peer("Calling all captains"))).toBe(false);
  expect(await f.gateway.receive(peer("<@UBOT> advice"))).toBe(true);
  await f.run();
  expect(f.prompts[0]).toContain('"wake":"direct"');
  f.config.access.peerTurnsPerHour = 0;
  expect(await f.gateway.receive(peer("<@UBOT> capped", "3.000"))).toBe(false);
  f.config.access.peerCaptains = false;
  expect(await f.gateway.receive(peer("<@UBOT> unverified", "4.000"))).toBe(
    false,
  );
});

test("mute racing async resume or peer verification is checked again before enqueue", async () => {
  for (const source of ["resume", "peer"]) {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    if (source === "resume") {
      f.slack.threadContext = async () => {
        entered.resolve();
        await release.promise;

        return {
          messages: [{ author: "this_bot", text: "Prior" }],
          truncated: false,
        };
      };
    } else {
      f.peerLookup.run = async () => {
        entered.resolve();
        await release.promise;

        return true;
      };
    }

    const admitted = f.gateway.receive(
      source === "resume" ? reply() : peer("ordinary"),
    );

    await entered.promise;
    f.control({ op: "mute", ...target });
    release.resolve();
    expect(await admitted).toBe(false);
    expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)).toEqual(
      [],
    );
    expect(f.prompts).toEqual([]);
  }
});

test("queued chat persists wake, suppresses ordinary terminally, and exempts legacy and cron", async () => {
  const f = fixture();
  f.config.resumeSlackThreads = false;
  expect(f.gateway.accept(event())).toBe(true);
  await f.run();
  const original = f.store.jobByEvent(f.gateway.key, "C123:1.000");
  const conversation = original?.conversation ?? "";
  const session = f.store.session(conversation);
  expect(f.gateway.accept(reply())).toBe(true);
  expect(f.gateway.accept(reply("<@UBOT> queued tag", "3.000"))).toBe(true);
  expect(f.gateway.accept(reply("Calling all captains", "4.000"))).toBe(true);
  f.control({ op: "mute", ...target });
  const ordinary = f.next();
  await f.run();
  expect(f.store.jobByEvent(f.gateway.key, ordinary.eventId)).toMatchObject({
    status: "failed",
    failure: "muted",
  });
  expect(f.prompts).toHaveLength(1);
  await f.run();
  await f.run();
  expect(f.prompts).toHaveLength(3);
  expect(f.prompts[1]).toContain('"wake":"direct"');
  expect(f.prompts[2]).toContain('"wake":"broadcast"');
  expect(f.store.session(conversation)).toBe(session);
  expect(f.store.jobByEvent(f.gateway.key, "C123:1.000")).toEqual(original);
  expect(() =>
    f.store.appendTranscript({
      botKey: f.gateway.key,
      conversation,
      from: undefined,
      cursor: "next",
      replies: [],
      requeue: [ordinary.eventId],
    }),
  ).toThrow();

  const legacy = {
    eventId: "C123:5.000",
    botKey: f.gateway.key,
    conversation,
    channel: "C123",
    thread: "1.000",
    user: "U123",
    text: "legacy",
  };

  expect(f.store.enqueue(legacy)).toBe(true);
  await f.run();
  expect(f.prompts.at(-1)).toBe("legacy");
  expect(
    f.gateway.enqueueScheduled({
      runId: "run",
      channel: "C123",
      thread: "1.000",
      user: "U123",
      prompt: "scheduled",
      name: "test",
      deferDelivery: true,
    }),
  ).toBeDefined();
  await f.run();
  expect(f.prompts.at(-1)).toBe("scheduled");
  f.control({ op: "unmute", ...target });
  expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  expect(f.store.jobByEvent(f.gateway.key, ordinary.eventId)?.failure).toBe(
    "muted",
  );
});

test("expiry and clear affect only future existing routing, with stateless redelivery allowed", async () => {
  const f = fixture();
  const until = f.now() + 1000;
  f.control({
    op: "mute",
    ...target,
    mute_until: new Date(until).toISOString(),
  });
  expect(f.gateway.accept(reply(), undefined, true)).toBe(false);
  f.clock(until);
  expect(f.gateway.accept(reply(), undefined, true)).toBe(true);
  await f.run();
  f.control({ op: "mute", scope: "channel", channel: "C123" });
  expect(f.gateway.accept(event("<@UBOT> wake", "3.000"))).toBe(true);
  f.control({ op: "clear_all" });
  expect(
    f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10),
  ).toHaveLength(1);
  await f.run();
});

test("preference faults hold chat without suppressing DM, queued history, outputs or controls", async () => {
  const f = fixture();
  let fault = false;

  const gateway = new Gateway(
    f.config,
    identity,
    f.store,
    f.backend,
    f.slack,
    pino({ enabled: false }),
    undefined,
    undefined,
    undefined,
    (channel, thread) => {
      if (fault) {
        throw new Error("private failure");
      }

      return f.preferences.status(f.key, channel, thread, f.now());
    },
  );

  cleanup.push(() => gateway.close());
  expect(gateway.accept(event())).toBe(true);
  const pending = f.next();
  fault = true;
  expect(() => gateway.accept(event("<@UBOT> held", "3.000"))).toThrow(
    "Notification preferences unavailable",
  );
  let acknowledgements = 0;
  await handleSlackRequest(
    {
      type: "events_api",
      body: event("<@UBOT> retry", "3.001"),
      ack: async () => {
        acknowledgements++;
      },
    },
    (body) => gateway.receive(body),
    pino({ enabled: false }),
  );
  expect(acknowledgements).toBe(0);
  await gateway.process(pending, new AbortController().signal);
  expect(f.store.jobByEvent(gateway.key, pending.eventId)?.status).toBe(
    "queued",
  );
  expect(
    gateway.accept({
      ...event("hello", "4.000"),
      event: {
        ...event("hello", "4.000").event,
        channel: "D123",
        channel_type: "im",
      },
    }),
  ).toBe(true);
  fault = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.backend.prompt = async () => {
    entered.resolve();
    await release.promise;

    return "Mute acknowledged.";
  };

  const work = gateway.process(pending, new AbortController().signal);
  await entered.promise;
  f.control({ op: "mute", ...target });
  fault = true;
  release.resolve();
  await work;
  expect(f.outputs).toEqual(["Mute acknowledged."]);
});

test("queued wake markers report dispatch-time mute state, not stale intake expiry", async () => {
  const f = fixture();
  const first = new Date(f.now() + 1000).toISOString();
  const second = new Date(f.now() + 2000).toISOString();
  f.control({ op: "mute", ...target, mute_until: first });
  expect(f.gateway.accept(reply("<@UBOT> first"))).toBe(true);
  f.control({ op: "unmute", ...target });
  await f.run();
  expect(f.prompts[0]).not.toContain("[Notification wake:");
  f.control({ op: "mute", ...target, mute_until: first });
  expect(f.gateway.accept(reply("<@UBOT> second", "3.000"))).toBe(true);
  f.control({ op: "mute", ...target, mute_until: second });
  await f.run();
  expect(f.prompts[1]).toContain(second);
  expect(f.prompts[1]).not.toContain(first);
  expect(f.gateway.accept(reply("<@UBOT> expired", "4.000"))).toBe(true);
  f.clock(Date.parse(second));
  await f.run();
  expect(f.prompts[2]).not.toContain("[Notification wake:");
});

test("a held preference fault backs off chat but permits pinned cron/native jobs past it", async () => {
  const f = fixture();
  let fault = false;

  const backend: AgentBackend = {
    ...f.backend,
    sessionID: "captain",
    async createSession() {
      return "captain";
    },
  };

  const gateway = new Gateway(
    f.config,
    identity,
    f.store,
    backend,
    f.slack,
    pino({ enabled: false }),
    undefined,
    undefined,
    undefined,
    (channel, thread) => {
      if (fault) {
        throw new Error("private error");
      }

      return f.preferences.status(f.key, channel, thread, f.now());
    },
  );

  cleanup.push(() => gateway.close());
  expect(gateway.accept(event())).toBe(true);
  const held = f.next();
  fault = true;
  await gateway.process(held, new AbortController().signal);
  expect(
    gateway.enqueueScheduled({
      runId: "exempt",
      channel: "C123",
      thread: "1.000",
      user: "U123",
      prompt: "scheduled",
      name: "exempt",
      deferDelivery: true,
    }),
  ).toBeDefined();

  const native = {
    eventId: "native:completion",
    botKey: gateway.key,
    conversation: held.conversation,
    channel: "C123",
    thread: "1.000",
    user: "U123",
    text: "native completion",
  };

  expect(f.store.enqueue(native)).toBe(true);
  const now = Date.now();
  const scheduled = f.store.ready(gateway.key, now, 10, true);
  expect(scheduled.map((job) => job.text)).toEqual(["scheduled"]);
  await gateway.process(scheduled[0] ?? held, new AbortController().signal);
  const completion = f.store.ready(gateway.key, now, 10, true);
  expect(completion.map((job) => job.text)).toEqual(["native completion"]);
  await gateway.process(completion[0] ?? held, new AbortController().signal);
  expect(f.prompts).toEqual(["scheduled", "native completion"]);
  expect(f.store.jobByEvent(gateway.key, held.eventId)?.status).toBe("queued");
  // At backoff equality, held chat has its normal FIFO priority again.
  const retry = f.store.ready(gateway.key, now + 5000, 10, true);
  expect(retry.map((job) => job.id)).toEqual([held.id]);
});

test("released chat holds wait for a bypassed same-thread reply without deadlocking delivery", () => {
  const f = fixture();
  expect(f.gateway.accept(event())).toBe(true);
  const held = f.next();
  expect(f.store.holdNotification(held.id, 100)).toBe(true);
  expect(
    f.store.enqueue({
      eventId: "native:later",
      botKey: f.gateway.key,
      conversation: held.conversation,
      channel: "C123",
      thread: "1.000",
      user: "U123",
      text: "native",
    }),
  ).toBe(true);
  const native = f.store.ready(f.gateway.key, 0, 10, true)[0];

  if (!native) {
    throw new Error("Expected native bypass");
  }

  expect(native.text).toBe("native");
  f.store.running(native.id);
  expect(f.store.ready(f.gateway.key, 100, 10, true)).toEqual([]);
  f.store.respond(native.id, ["Pending native reply."]);
  f.store.retry(native.id, 1000);
  expect(f.store.ready(f.gateway.key, 100, 10, true)).toEqual([]);
  expect(
    f.store.ready(f.gateway.key, 1000, 10, true).map((job) => job.id),
  ).toEqual([native.id]);
  expect(f.store.finish(native.id)).toBe(true);
  expect(
    f.store.ready(f.gateway.key, 1000, 10, true).map((job) => job.id),
  ).toEqual([held.id]);
});

test("text mute bypass configuration must be an explicit subset on Slack text rules only", () => {
  const config = bot();
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(botSchema)({
        ...config,
        access: {
          ...config.access,
          textMentions: {
            channels: ["C123"],
            names: ["helper"],
            muteBypassNames: ["all captains"],
          },
        },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(botSchema)({
        ...config,
        access: {
          ...config.access,
          textMentions: {
            channels: ["C123"],
            names: ["helper"],
            muteBypassNames: [],
          },
        },
      }),
    ),
  ).toBe(true);
  const changed = bot();

  if (changed.backend.type === "opencode") {
    changed.backend.directory = "/different";
  }

  expect(notificationKey(changed, identity)).toBe(
    notificationKey(config, identity),
  );
  expect(notificationKey(config, { ...identity, team: "TOTHER" })).not.toBe(
    notificationKey(config, identity),
  );
});
