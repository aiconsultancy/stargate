import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { dirname, join } from "node:path";
import { Result, Schema } from "effect";
import { teamsSchema } from "../src/config";
import type { OutgoingActivity as Outgoing } from "../src/transports/teams/connector";
import {
  TeamsPresence,
  type TeamsWaiting,
} from "../src/transports/teams/presence";
import {
  allowedActivity,
  TeamsRegistration,
} from "../src/transports/teams/registration";
import type { TurnProgress as Progress } from "../src/shared/turn-progress";
import { saveWaitingDelay } from "../src/config/waiting-overrides";
import { waitingPhrase } from "../src/shared/waiting";
import {
  activity,
  HUMAN,
  OTHER_HUMAN,
  registrationFixture,
  SERVICE_URL,
  TENANT_ID,
} from "./teams-support";

describe("Teams intake and source ownership", () => {
  test("admits the exact tenant/user and explicitly allowed channel", async () => {
    const f = registrationFixture();

    try {
      expect(await f.registration.accept(activity())).toBe(true);
      expect(
        await f.registration.accept(
          activity({
            id: "channel-message",
            conversation: {
              id: "channel-conversation",
              conversationType: "channel",
              tenantId: TENANT_ID,
            },
            channelData: {
              tenant: { id: TENANT_ID },
              channel: { id: "allowed-channel" },
            },
          }),
        ),
      ).toBe(true);
      expect(f.store.ready(f.registration.key, Date.now(), 10)).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  test("fails closed on conflicting/missing tenant, stranger, bot and conversation scope", async () => {
    const f = registrationFixture();

    try {
      const wrongTenant = "00000000-0000-4000-8000-000000000000";

      const rejected = [
        activity({
          conversation: { id: "dm", conversationType: "personal" },
          channelData: {},
        }),
        activity({ channelData: { tenant: { id: wrongTenant } } }),
        activity({
          conversation: {
            id: "dm",
            conversationType: "personal",
            tenantId: wrongTenant,
          },
        }),
        activity({ from: { id: "29:stranger", aadObjectId: wrongTenant } }),
        activity({ from: { id: "29:unknown" } }),
        activity({ from: { id: "29:bot", aadObjectId: HUMAN, role: "bot" } }),
        activity({ from: { id: activity().recipient.id, aadObjectId: HUMAN } }),
        activity({
          conversation: {
            id: "not-allowed",
            conversationType: "channel",
            tenantId: TENANT_ID,
          },
        }),
        activity({
          conversation: {
            id: "not-allowed",
            conversationType: "groupChat",
            tenantId: TENANT_ID,
          },
        }),
        activity({ serviceUrl: "https://attacker.example/" }),
      ];

      for (const message of rejected)
        expect(await f.registration.accept(message)).toBe(false);
      expect(f.store.ready(f.registration.key, Date.now(), 10)).toEqual([]);
      f.config.access.deniedUsers.push(HUMAN);
      expect(allowedActivity(f.config, activity())).toBe(false);
      f.config.access.deniedUsers.length = 0;
      f.config.access.deniedChannels.push("allowed-channel");
      expect(
        allowedActivity(
          f.config,
          activity({
            conversation: {
              id: "channel-conversation",
              conversationType: "channel",
              tenantId: TENANT_ID,
            },
            channelData: { channel: { id: "allowed-channel" } },
          }),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("deduplicates accepted activities durably before acknowledging retries", async () => {
    const f = registrationFixture();

    try {
      await f.registration.accept(activity());
      await f.registration.accept(activity());
      await f.reopen();
      await f.registration.accept(activity());
      const jobs = f.store.ready(f.registration.key, Date.now(), 100);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.text).toBe("Inspect the repository");
      expect(jobs[0]?.user).toBe(HUMAN);
    } finally {
      await f.close();
    }
  });

  test("reply and model source retain the originating Teams conversation and activity", async () => {
    const f = registrationFixture({ fleet: true });

    try {
      const first = await f.running();

      const secondMessage = activity({
        id: "request-two",
        conversation: {
          id: "second-conversation",
          conversationType: "personal",
          tenantId: TENANT_ID,
        },
        serviceUrl: "https://europe.botframework.com/",
      });

      const second = await f.running(secondMessage, "input-two");
      expect(f.registration.transport.source?.(first)).toEqual({
        transport: "teams",
        channel: activity().conversation.id,
        thread: "message-1",
        message: "message-1",
        user: HUMAN,
        authority: "human",
      });
      await f.reopen();
      await f.registration.delivery.post(
        first.channel,
        first.thread,
        "First reply",
      );
      await f.registration.delivery.post(
        second.channel,
        second.thread,
        "Second reply",
      );
      expect(f.sent).toEqual([
        {
          service: SERVICE_URL,
          conversation: first.channel,
          activity: {
            type: "message",
            text: "First reply",
            replyToId: first.thread,
          },
        },
        {
          service: secondMessage.serviceUrl,
          conversation: second.channel,
          activity: {
            type: "message",
            text: "Second reply",
            replyToId: second.thread,
          },
        },
      ]);
    } finally {
      await f.close();
    }
  });

  test("allowlist changes are rechecked before replies, including channel IDs differing from conversation IDs", async () => {
    const f = registrationFixture();

    try {
      const channel = activity({
        conversation: {
          id: "thread-conversation",
          conversationType: "channel",
          tenantId: TENANT_ID,
        },
        channelData: { channel: { id: "allowed-channel" } },
      });

      await f.registration.accept(channel);
      await f.reopen();
      f.config.access.channels.length = 0;
      expect(
        f.registration.transport.allowed(HUMAN, channel.conversation.id),
      ).toBe(false);
      await expect(
        f.registration.delivery.post(
          channel.conversation.id,
          channel.id,
          "Must not send",
        ),
      ).rejects.toThrow();
      expect(f.sent).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

describe("Opt-in Teams native permission decisions", () => {
  function approvalRow(f: ReturnType<typeof registrationFixture>) {
    const db = new Database(join(dirname(f.config.socketPath), "teams.sqlite"));

    try {
      return db
        .query<{ token: string; notified: number; used: number }, []>(
          "SELECT token,notified,used FROM approvals",
        )
        .get();
    } finally {
      db.close();
    }
  }

  test("failed approval notification retries the same one-use token", async () => {
    const f = registrationFixture({ approvals: true });

    const notification = spyOn(f.sent, "push").mockImplementationOnce(() => {
      throw new Error("notification unavailable");
    });

    try {
      await f.running();
      f.backend.permission();
      await expect(f.registration.pollApprovals()).rejects.toThrow(
        "notification unavailable",
      );
      const persisted = approvalRow(f);

      if (!persisted) throw new Error("Missing persisted notification offer");
      expect(persisted).toMatchObject({ notified: 0, used: 0 });
      notification.mockRestore();
      await f.registration.pollApprovals();
      expect(f.approvalToken()).toBe(persisted.token);
      expect(approvalRow(f)).toMatchObject({ notified: 1, used: 0 });
      await f.registration.pollApprovals();
      expect(f.sent).toHaveLength(1);
      await f.registration.accept(
        activity({
          id: "retry-notice-decision",
          text: `approve ${f.approvalToken()}`,
        }),
      );
      expect(f.backend.replies).toHaveLength(1);
    } finally {
      notification.mockRestore();
      await f.close();
    }
  });

  test("restart after persisted offer but before notification recovers without rotating it", async () => {
    const f = registrationFixture({ approvals: true });

    const notification = spyOn(f.sent, "push").mockImplementationOnce(() => {
      throw new Error("simulated stop before publish");
    });

    try {
      await f.running();
      f.backend.permission();
      await expect(f.registration.pollApprovals()).rejects.toThrow(
        "simulated stop before publish",
      );
      const persisted = approvalRow(f);

      if (!persisted) throw new Error("Missing persisted notification offer");
      expect(f.sent).toEqual([]);
      notification.mockRestore();
      await f.reopen();
      await f.registration.pollApprovals();
      expect(f.approvalToken()).toBe(persisted.token);
      expect(approvalRow(f)).toMatchObject({ notified: 1, used: 0 });
    } finally {
      notification.mockRestore();
      await f.close();
    }
  });

  test("unused expired offers refresh only for the same pending input and invalidate the old token", async () => {
    const f = registrationFixture({ approvals: true });
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);

    try {
      await f.running();
      f.backend.permission();
      await f.registration.pollApprovals();
      const old = f.approvalToken();
      clock.mockReturnValue(now + f.config.approvalTTLms + 1);
      await f.registration.pollApprovals();
      const refreshed = approvalRow(f)?.token;
      expect(refreshed).toBeDefined();
      expect(refreshed).not.toBe(old);
      expect(f.sent).toHaveLength(2);
      await f.registration.accept(
        activity({ id: "expired-old", text: `approve ${old}` }),
      );
      expect(f.backend.replies).toEqual([]);
      await f.registration.accept(
        activity({ id: "renewed-current", text: `approve ${refreshed}` }),
      );
      expect(f.backend.replies).toHaveLength(1);
    } finally {
      clock.mockRestore();
      await f.close();
    }
  });

  for (const changed of [
    "input",
    "session",
    "arguments",
    "completed",
    "access",
  ] as const) {
    test(`a failed notification cannot be retried after changed ${changed}`, async () => {
      const f = registrationFixture({ approvals: true });

      const notification = spyOn(f.sent, "push").mockImplementationOnce(() => {
        throw new Error("notification unavailable");
      });

      try {
        const job = await f.running();
        const request = f.backend.permission();
        await expect(f.registration.pollApprovals()).rejects.toThrow(
          "notification unavailable",
        );
        notification.mockRestore();

        if (changed === "input")
          f.backend.bindings.set(request.id, "native-irc-input");

        if (changed === "session") f.backend.sessionID = "replacement-session";

        if (changed === "arguments")
          f.backend.pending = [{ ...request, resources: ["different scope"] }];

        if (changed === "completed") f.store.respond(job.id, ["completed"]);

        if (changed === "access") f.config.access.deniedUsers.push(HUMAN);
        await f.registration.pollApprovals();
        expect(f.sent).toEqual([]);
        expect(f.backend.replies).toEqual([]);
        expect(approvalRow(f)).toMatchObject({ notified: 0, used: 0 });
      } finally {
        notification.mockRestore();
        await f.close();
      }
    });
  }

  test("notification rechecks the native request after persisting its offer", async () => {
    const f = registrationFixture({ approvals: true });

    try {
      await f.running();
      const request = f.backend.permission();

      const pending = spyOn(f.backend, "pendingPermissions")
        .mockResolvedValueOnce([request])
        .mockResolvedValueOnce([]);

      try {
        await f.registration.pollApprovals();
        expect(f.sent).toEqual([]);
        expect(approvalRow(f)).toMatchObject({ notified: 0, used: 0 });
      } finally {
        pending.mockRestore();
      }
    } finally {
      await f.close();
    }
  });

  test("consumed tokens never renew after expiry or an uncertain permission API outcome", async () => {
    const f = registrationFixture({ approvals: true });
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);

    try {
      await f.running();
      f.backend.permission();
      await f.registration.pollApprovals();
      const token = f.approvalToken();
      f.backend.failReply = true;
      await expect(
        f.registration.accept(
          activity({ id: "uncertain-consumed", text: `approve ${token}` }),
        ),
      ).rejects.toThrow("Uncertain provider outcome");
      expect(approvalRow(f)).toMatchObject({ token, used: 1 });
      clock.mockReturnValue(now + f.config.approvalTTLms + 1);
      f.backend.failReply = false;
      await f.reopen();
      await f.registration.pollApprovals();
      expect(approvalRow(f)).toMatchObject({ token, used: 1 });
      expect(f.sent).toHaveLength(1);
      await f.registration.accept(
        activity({ id: "consumed-replay", text: `approve ${token}` }),
      );
      expect(f.backend.replies).toHaveLength(1);
    } finally {
      clock.mockRestore();
      await f.close();
    }
  });

  test("legacy approval stores gain notification state while preserving consumed tombstones", async () => {
    const f = registrationFixture({ approvals: true });
    const path = join(dirname(f.config.socketPath), "legacy-approvals.sqlite");
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE approvals(token TEXT PRIMARY KEY,request TEXT NOT NULL UNIQUE,session TEXT NOT NULL,conversation TEXT NOT NULL,user TEXT NOT NULL,input TEXT NOT NULL,expires INTEGER NOT NULL,fingerprint TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0); INSERT INTO approvals VALUES('legacy-token','permission-legacy','session-1','conversation','human','input',1,'fingerprint',1)",
    );
    legacy.close();

    const registration = new TeamsRegistration(
      f.config,
      path,
      f.store,
      f.backend,
      () => {},
    );

    try {
      const db = new Database(path);

      try {
        expect(
          db
            .query<{ notified: number; used: number }, []>(
              "SELECT notified,used FROM approvals",
            )
            .get(),
        ).toEqual({ notified: 0, used: 1 });
      } finally {
        db.close();
      }
    } finally {
      await registration.close();
      await f.close();
    }
  });

  test("configuration requires explicit permitted approvers and OpenCode", async () => {
    const f = registrationFixture();

    try {
      expect(f.config.approvalUsers).toEqual([]);
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(teamsSchema)({
            ...f.config,
            access: { users: [] },
          }),
        ),
      ).toBe(false);
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(teamsSchema)({
            ...f.config,
            approvalUsers: ["00000000-0000-4000-8000-000000000000"],
          }),
        ),
      ).toBe(false);
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(teamsSchema)({
            ...f.config,
            approvalUsers: [HUMAN],
            backend: { type: "module", module: "/srv/backend.ts" },
          }),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  test("queued or channel requests cannot acquire a personal approval offer", async () => {
    const f = registrationFixture({ approvals: true });

    try {
      await f.registration.accept(activity());
      f.backend.permission();
      await f.registration.pollApprovals();
      expect(f.sent).toEqual([]);
      await f.running(
        activity({
          id: "channel-input",
          conversation: {
            id: "channel-conversation",
            conversationType: "channel",
            tenantId: TENANT_ID,
          },
          channelData: { channel: { id: "allowed-channel" } },
        }),
      );
      await f.registration.pollApprovals();
      expect(f.sent).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test("revoking an approver before the decision fails closed", async () => {
    const f = registrationFixture({ approvals: true });

    try {
      await f.running();
      f.backend.permission();
      await f.registration.pollApprovals();
      const text = `approve ${f.approvalToken()}`;
      f.config.approvalUsers.length = 0;
      await f.registration.accept(activity({ id: "revoked", text }));
      expect(f.backend.replies).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test("permissions remain disabled by default and approval text never becomes a model prompt", async () => {
    const f = registrationFixture();

    try {
      await f.running();
      f.backend.permission();
      await f.registration.pollApprovals();
      expect(f.sent).toEqual([]);
      await f.registration.accept(
        activity({
          id: "control",
          text: "approve 12345678901234567890123456789012",
        }),
      );
      await f.registration.accept(
        activity({
          id: "malformed-control",
          text: "deny anything quoted in history",
        }),
      );
      expect(f.store.ready(f.registration.key, Date.now(), 100)).toEqual([]);
      expect(f.backend.replies).toEqual([]);
    } finally {
      await f.close();
    }
  });

  for (const decision of ["approve", "deny"] as const) {
    test(`${decision} is bound to the pending native input and usable once across reopen`, async () => {
      const f = registrationFixture({ approvals: true });

      try {
        await f.running();
        f.backend.permission();
        await f.registration.pollApprovals();
        await f.registration.pollApprovals();
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0]?.activity.text).not.toContain(
          "private tool arguments",
        );
        const token = f.approvalToken();
        await f.reopen();

        const command = activity({
          id: "decision-1",
          text: `${decision} ${token}`,
        });

        await f.registration.accept(command);
        await f.registration.accept({ ...command, id: "decision-replay" });
        expect(f.backend.replies).toEqual([
          {
            session: "session-1",
            request: "permission-1",
            decision: decision === "approve" ? "once" : "reject",
          },
        ]);
        expect(f.store.ready(f.registration.key, Date.now(), 10)).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }

  test("another admitted human, conversation, or channel cannot use the original human's token", async () => {
    const f = registrationFixture({ approvals: true });

    try {
      await f.running();
      f.backend.permission();
      await f.registration.pollApprovals();
      const text = `approve ${f.approvalToken()}`;
      await f.registration.accept(
        activity({
          id: "wrong-human",
          from: { id: "29:other", aadObjectId: OTHER_HUMAN },
          text,
        }),
      );
      await f.registration.accept(
        activity({
          id: "wrong-conversation",
          conversation: {
            id: "other-dm",
            conversationType: "personal",
            tenantId: TENANT_ID,
          },
          text,
        }),
      );
      await f.registration.accept(
        activity({
          id: "wrong-scope",
          conversation: {
            id: "channel-conversation",
            conversationType: "channel",
            tenantId: TENANT_ID,
          },
          channelData: { channel: { id: "allowed-channel" } },
          text,
        }),
      );
      expect(f.backend.replies).toEqual([]);
      await f.registration.accept(activity({ id: "correct-human", text }));
      expect(f.backend.replies).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  test("TTL expiry fails closed without consuming a native permission", async () => {
    const f = registrationFixture({ approvals: true });
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);

    try {
      await f.running();
      f.backend.permission();
      await f.registration.pollApprovals();
      const text = `approve ${f.approvalToken()}`;
      clock.mockReturnValue(now + f.config.approvalTTLms);
      await f.registration.accept(activity({ id: "expired", text }));
      expect(f.backend.replies).toEqual([]);
    } finally {
      clock.mockRestore();
      await f.close();
    }
  });

  for (const changed of [
    "request",
    "session",
    "input",
    "arguments",
    "completed",
  ] as const) {
    test(`a changed ${changed} cannot reuse a pending decision`, async () => {
      const f = registrationFixture({ approvals: true });

      try {
        const job = await f.running();
        f.backend.permission();
        await f.registration.pollApprovals();
        const text = `approve ${f.approvalToken()}`;

        if (changed === "request") f.backend.pending = [];

        if (changed === "session") f.backend.sessionID = "replacement-session";

        if (changed === "input")
          f.backend.bindings.set("permission-1", "irc-input");

        if (changed === "arguments")
          f.backend.pending = [
            { ...f.backend.permission(), resources: ["different tool scope"] },
          ];

        if (changed === "completed")
          f.store.respond(job.id, ["already completed"]);
        await f.reopen();
        await f.registration.accept(
          activity({ id: `changed-${changed}`, text }),
        );
        expect(f.backend.replies).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }

  test("an IRC permission on the shared pin cannot borrow an older Teams human", async () => {
    const f = registrationFixture({ approvals: true });

    try {
      await f.running();
      f.backend.permission("native-irc-input");
      f.store.enqueue({
        eventId: "irc-event",
        botKey: "irc-registration",
        conversation: "same-pin",
        channel: "#captain",
        thread: "irc-event",
        user: "captain-agent",
        text: "Read repository",
      });
      const irc = f.store.ready("irc-registration", Date.now(), 10)[0];

      if (!irc) throw new Error("Missing IRC fixture");
      f.store.running(irc.id);
      f.store.saveInput(
        "irc-registration",
        irc.id,
        "native-irc-input",
        f.backend.sessionID,
      );
      await f.registration.pollApprovals();
      expect(f.sent).toEqual([]);
      expect(f.backend.replies).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test("uncertain permission API outcomes consume the token before retry", async () => {
    const f = registrationFixture({ approvals: true });

    try {
      await f.running();
      f.backend.permission();
      await f.registration.pollApprovals();
      const text = `approve ${f.approvalToken()}`;
      f.backend.failReply = true;
      await expect(
        f.registration.accept(activity({ id: "uncertain", text })),
      ).rejects.toThrow("Uncertain provider outcome");
      f.backend.failReply = false;
      await f.reopen();
      await f.registration.accept(activity({ id: "uncertain-retry", text }));
      expect(f.backend.replies).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

test("live Teams presence anchors an informative stage and closes it with the original reply", async () => {
  const f = registrationFixture({ presence: true });

  try {
    const job = await f.running();
    expect(f.registration.transport.turnStatus?.(job)).toBe("notice");
    const abort = new AbortController();

    const working = f.registration.delivery.working?.(
      job.channel,
      job.thread,
      abort.signal,
      () => true,
      "notice",
      () => ({ stage: "reasoning", observedAt: Date.now() }),
    );

    await Bun.sleep(10);
    abort.abort();
    await working;
    expect(f.sent.map((x) => x.activity)).toEqual([
      {
        type: "typing",
        text: "Thinking",
        replyToId: job.thread,
        entities: [
          { type: "streamInfo", streamType: "informative", streamSequence: 1 },
        ],
      },
      { type: "typing", replyToId: job.thread },
    ]);
    await f.registration.delivery.post(
      job.channel,
      job.thread,
      "Fleet follow-up",
      undefined,
      { job: job.id + 1, part: 0 },
    );
    expect(f.sent.at(-1)?.activity.entities).toBeUndefined();
    await f.registration.delivery.post(
      job.channel,
      job.thread,
      "Final",
      undefined,
      { job: job.id, part: 0 },
    );
    expect(f.sent.at(-1)?.activity).toEqual({
      type: "message",
      text: "Final",
      replyToId: job.thread,
      entities: [
        { type: "streamInfo", streamType: "final", streamId: "reply-1" },
      ],
    });
    expect(
      f.registration.transport.turnStatus?.({
        ...job,
        received: Date.now() - 150_000,
      }),
    ).toBe("quiet");
  } finally {
    await f.close();
  }
});

test("a Teams connector that declines informative updates still gets typing and the ordinary reply", async () => {
  const f = registrationFixture({ presence: true });

  try {
    const job = await f.running();

    const connector = {
      sendToConversation: async (
        _service: string,
        _channel: string,
        activity: import("../src/transports/teams/connector").OutgoingActivity,
      ) => {
        if (activity.entities) throw new Error("Informative streams disabled");

        return { id: activity.type };
      },
    };

    const spy = spyOn(connector, "sendToConversation");

    const presence = new (
      await import("../src/transports/teams/presence")
    ).TeamsPresence(5);

    const abort = new AbortController();

    const send = (
      activity: import("../src/transports/teams/connector").OutgoingActivity,
    ) => connector.sendToConversation(SERVICE_URL, job.channel, activity);

    const work = presence.working(
      job.channel,
      job.thread,
      abort.signal,
      () => true,
      () => undefined,
      send,
    );

    await Bun.sleep(14);
    abort.abort();
    await work;
    expect(spy.mock.calls.filter((args) => args[2].entities)).toHaveLength(1);
    expect(
      spy.mock.calls.filter(
        (args) => args[2].type === "typing" && !args[2].entities,
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await presence.final(
        job.channel,
        job.thread,
        { type: "message", text: "Done" },
        AbortSignal.timeout(1000),
        send,
      ),
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

describe("Teams waiting phrases", () => {
  const waiting = (settings: Partial<TeamsWaiting> = {}): TeamsWaiting => ({
    delayMs: 0,
    intervalMs: 20,
    name: "Adama",
    ...settings,
  });

  const informative = (sent: Outgoing[]) =>
    sent.flatMap((activity) =>
      activity.entities && activity.text !== undefined ? [activity.text] : [],
    );

  async function run(
    progress: () => Progress | undefined,
    settings: TeamsWaiting | undefined,
    ms: number,
  ) {
    const sent: Outgoing[] = [];
    const abort = new AbortController();

    const work = new TeamsPresence(5).working(
      "conversation",
      "anchor",
      abort.signal,
      () => true,
      progress,
      async (activity) => {
        sent.push(activity);

        return { id: "stream-1" };
      },
      settings,
    );

    await Bun.sleep(ms);
    abort.abort();
    await work;

    return sent;
  }

  test("generic stages show the bot's rotating phrase on the waiting interval", async () => {
    for (const progress of [
      (): Progress => ({ stage: "reasoning", observedAt: Date.now() }),
      (): Progress => ({ stage: "model", observedAt: Date.now() }),
      () => undefined,
    ]) {
      const texts = informative(await run(progress, waiting(), 120));
      expect(texts[0]).toBe(waitingPhrase("Adama", 0));
      expect(texts[1]).toBe(waitingPhrase("Adama", 1));
      // One update per interval at most, and none while the phrase is unchanged.
      expect(texts.length).toBeLessThanOrEqual(7);
      expect(texts).toEqual(texts.map((_, i) => waitingPhrase("Adama", i)));
    }
  });

  test("specific stage labels are unchanged", async () => {
    const labels: [Progress, string][] = [
      [{ stage: "tool", observedAt: 0 }, "Using a tool"],
      [{ stage: "reply", observedAt: 0 }, "Writing a reply"],
      [{ stage: "queued", observedAt: 0 }, "Queued"],
      [{ stage: "submitting", observedAt: 0 }, "Waiting for confirmation"],
      [{ stage: "retry", observedAt: 0 }, "Waiting to retry"],
      [{ stage: "waiting", observedAt: 0 }, "Waiting for an answer"],
      [
        { stage: "reasoning", observedAt: 0, disconnected: true },
        "Connection interrupted",
      ],
    ];

    for (const [progress, label] of labels)
      expect(informative(await run(() => progress, waiting(), 40))).toEqual([
        label,
      ]);
  });

  test("a specific stage pauses the phrase, which resumes afterwards", async () => {
    let progress: Progress = { stage: "reasoning", observedAt: 0 };
    const sent: Outgoing[] = [];
    const abort = new AbortController();

    const work = new TeamsPresence(5).working(
      "conversation",
      "anchor",
      abort.signal,
      () => true,
      () => progress,
      async (activity) => {
        sent.push(activity);

        return { id: "stream-1" };
      },
      waiting({ intervalMs: 60_000 }),
    );

    await Bun.sleep(40);
    progress = { stage: "tool", observedAt: 0 };
    await Bun.sleep(40);
    progress = { stage: "reasoning", observedAt: 0 };
    await Bun.sleep(40);
    abort.abort();
    await work;
    expect(informative(sent)).toEqual([
      waitingPhrase("Adama", 0),
      "Using a tool",
      waitingPhrase("Adama", 0),
    ]);
  });

  test("the waiting delay keeps the generic label, and off disables phrases", async () => {
    const reasoning = (): Progress => ({ stage: "reasoning", observedAt: 0 });
    expect(
      informative(await run(reasoning, waiting({ delayMs: null }), 40)),
    ).toEqual(["Thinking"]);
    expect(informative(await run(() => undefined, undefined, 40))).toEqual([
      "Working",
    ]);

    const delayed = informative(
      await run(reasoning, waiting({ delayMs: 30, intervalMs: 60_000 }), 120),
    );

    expect(delayed).toEqual(["Thinking", waitingPhrase("Adama", 0)]);
  });

  test("the phrase name is cleaned and bounded, and a blank name keeps the label", async () => {
    const texts = informative(
      await run(
        () => undefined,
        waiting({ name: `Ad\nama${"x".repeat(200)}` }),
        10,
      ),
    );

    expect(texts).toEqual([waitingPhrase(`Ad ama${"x".repeat(94)}`, 0)]);
    expect(
      informative(await run(() => undefined, waiting({ name: " \n " }), 10)),
    ).toEqual(["Working"]);
  });

  test("rotation stops when the turn ends", async () => {
    const sent = await run(() => undefined, waiting(), 30);
    const count = sent.length;
    expect(count).toBeGreaterThan(0);
    await Bun.sleep(50);
    expect(sent).toHaveLength(count);
  });

  test("registration uses the display name and the captain's waiting override", async () => {
    const f = registrationFixture({
      presence: true,
      agent: "captain",
      displayName: "Adama",
    });

    try {
      const backend = f.config.backend;

      if (backend.type !== "opencode") throw new Error("OpenCode fixture");
      // The configured 5 second delay would keep "Thinking" for this turn.
      await saveWaitingDelay(
        backend.directory,
        "captain",
        0,
        AbortSignal.timeout(1000),
      );
      const job = await f.running();
      const abort = new AbortController();

      const working = f.registration.delivery.working?.(
        job.channel,
        job.thread,
        abort.signal,
        () => true,
        "notice",
        () => ({ stage: "reasoning", observedAt: Date.now() }),
      );

      await Bun.sleep(40);
      abort.abort();
      await working;
      expect(
        f.sent.flatMap(({ activity }) =>
          activity.entities ? [activity.text] : [],
        ),
      ).toEqual([waitingPhrase("Adama", 0)]);
    } finally {
      await f.close();
    }
  });
});
