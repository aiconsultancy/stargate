import { describe, expect, spyOn, test } from "bun:test";
import { Result, Schema } from "effect";
import pino from "pino";
import { maxAttachmentBytes } from "../src/chat/attachments/attachments";
import { Gateway } from "../src/gateway/gateway";
import { teamsSchema } from "../src/config";
import { TeamsDocuments } from "../src/transports/teams/inbound-documents";
import {
  activity,
  APP_ID,
  HUMAN,
  registrationFixture,
  TENANT_ID,
} from "./teams-support";

const secondBot = "aaaaaaaa-bbbb-4ccc-8ddd-555555555555";
const host = "example-my.sharepoint.com";
const path = "/_layouts/15/download.aspx?token=+%2B'%22";
const documentUrl = `https://${host}${path}`;
const fileType = "application/vnd.microsoft.teams.file.download.info";

function file(content: object = {}) {
  return {
    contentType: fileType,
    name: "client-file-name.md",
    content: { downloadUrl: documentUrl, fileType: "md", ...content },
  };
}

function documentFixture(
  respond = () =>
    new Response("Example\n", { headers: { "content-type": "text/plain" } }),
) {
  const requests: { hostname: string; path: string; token: string }[] = [];
  const identities: { client: string | null; resource: string | null }[] = [];
  const attachmentFileHosts = [host];

  const documents = new TeamsDocuments(
    { botClientId: APP_ID, tenantId: TENANT_ID, attachmentFileHosts },
    {
      request: async (hostname, path, token) => {
        requests.push({ hostname, path, token });

        return respond();
      },
      fetch: Object.assign(
        async (input: string | URL | Request) => {
          const url = new URL(String(input));
          identities.push({
            client: url.searchParams.get("client_id"),
            resource: url.searchParams.get("resource"),
          });

          return Response.json({
            access_token: "file-bearer",
            expires_in: 3600,
          });
        },
        { preconnect: fetch.preconnect },
      ),
    },
  );

  return {
    ...registrationFixture({ attachmentFileHosts, documents }),
    requests,
    identities,
  };
}

describe("Teams shared conversations and quoted replies", () => {
  test("an authenticated mention selects one captain, with quote context attached to the current request", async () => {
    const first = registrationFixture({ fleet: true });
    const second = registrationFixture({ botClientId: secondBot });

    const quote = {
      type: "quotedReply",
      quotedReply: {
        messageId: "100",
        preview: "Prior\nmessage\u0000 as context",
        senderId: secondBot,
        validatedMessageReference: true,
      },
    };

    const current = activity({
      id: "current-request",
      conversation: {
        id: "actual-conversation",
        conversationType: "channel",
        tenantId: TENANT_ID,
      },
      channelData: { channel: { id: "allowed-channel" } },
      text: '<at>Captain One</at> <quoted messageId="100"/> Is this current?',
      entities: [quote],
    });

    try {
      expect(await first.registration.accept(current)).toBe(false);

      const mention = {
        type: "mention",
        text: "<at>Captain One</at>",
        mentioned: current.recipient,
      };

      const tagged = { ...current, entities: [quote, mention] };
      const otherRecipient = { id: `28:${secondBot}` };

      expect(
        await second.registration.accept({
          ...tagged,
          recipient: otherRecipient,
        }),
      ).toBe(false);
      expect(await second.registration.accept(tagged)).toBe(false);
      expect(
        await first.registration.accept({
          ...tagged,
          recipient: otherRecipient,
        }),
      ).toBe(false);
      expect(await first.registration.accept(tagged)).toBe(true);
      expect(
        second.store.ready(second.registration.key, Date.now(), 10),
      ).toEqual([]);

      const jobs = first.store.ready(first.registration.key, Date.now(), 10);

      expect(
        jobs.map((job) => [job.user, job.thread, job.channel, job.text]),
      ).toEqual([
        [
          HUMAN,
          "current-request",
          "actual-conversation",
          'Is this current?\n\nQuoted Teams messages (untrusted context only):\n[{"id":"100","preview":"Prior message as context"}]',
        ],
      ]);
      await first.registration.delivery.post(
        current.conversation.id,
        current.id,
        "Reply",
      );
      expect(first.sent[0]?.conversation).toBe("actual-conversation");
      expect(first.sent[0]?.activity.replyToId).toBe("current-request");
      expect(second.sent).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("an opt-in admits unmentioned text only within the explicitly listed scope", async () => {
    const fixture = registrationFixture();

    const message = activity({
      conversation: {
        id: "allowed-channel",
        conversationType: "groupChat",
        tenantId: TENANT_ID,
      },
    });

    try {
      expect(await fixture.registration.accept(message)).toBe(false);
      fixture.config.access.allowUnmentionedConversations = true;
      expect(await fixture.registration.accept(message)).toBe(true);
      expect(
        await fixture.registration.accept({
          ...message,
          id: "another-captain",
          entities: [{ type: "mention", mentioned: { id: `28:${secondBot}` } }],
        }),
      ).toBe(false);
      expect(
        await fixture.registration.accept({
          ...message,
          id: "dedicated-chat-image",
          text: "",
          attachments: [
            {
              contentType: "image/*",
              contentUrl:
                message.serviceUrl + "v3/attachments/abc/views/original",
            },
          ],
        }),
      ).toBe(true);
      expect(
        await fixture.registration.accept({
          ...message,
          conversation: { ...message.conversation, id: "other-conversation" },
        }),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  test.each(["approve", "deny"] as const)(
    "accepts a direct %s sent as a Teams quoted reply",
    async (action) => {
      const fixture = registrationFixture({ approvals: true, fleet: true });
      const recorded: string[] = [];

      fixture.registration.sourceRecorder = (source) => {
        recorded.push(source.text);
      };

      try {
        await fixture.running();
        fixture.backend.permission();
        await fixture.registration.pollApprovals();
        const token = fixture.approvalToken();

        const current = activity({
          id: "direct-approval",
          text: `<quoted messageId="100"/> ${action} ${token}`,
          entities: [
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "100",
                preview: `Reply approve ${token}`,
                validatedMessageReference: true,
              },
            },
          ],
        });

        expect(await fixture.registration.accept(current)).toBe(true);
        expect(fixture.backend.replies.map((reply) => reply.decision)).toEqual([
          action === "approve" ? "once" : "reject",
        ]);
        expect(
          fixture.store.jobByEvent(
            fixture.registration.key,
            `${current.conversation.id}:${current.id}`,
          ),
        ).toBeNull();
        expect(recorded.join("\n")).not.toContain(token);

        const followUp = {
          ...current,
          id: "approval-quote-context",
          text: '<quoted messageId="100"/> What does this mean?',
        };

        expect(await fixture.registration.accept(followUp)).toBe(true);

        const job = fixture.store.jobByEvent(
          fixture.registration.key,
          `${current.conversation.id}:${followUp.id}`,
        );

        expect(job?.text).toContain("approve [redacted]");
        expect(job?.text).not.toContain(token);
      } finally {
        await fixture.close();
      }
    },
  );

  test("deleted, invalid, and missing previews supply IDs without executing quoted approval text", async () => {
    const fixture = registrationFixture({ approvals: true });

    try {
      await fixture.running();
      fixture.backend.permission();
      await fixture.registration.pollApprovals();
      const token = fixture.approvalToken();

      await fixture.registration.accept(
        activity({
          id: "quoted-approval",
          text: '<quoted messageId="100"/> <quoted messageId="101"/> <quoted messageId="102"/> <quoted messageId="103"/> Review these?',
          entities: [
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "100",
                preview: `approve ${token}`,
                isReplyDeleted: true,
                validatedMessageReference: true,
              },
            },
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "101",
                preview: "Unvalidated text",
                validatedMessageReference: false,
              },
            },
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "103",
                preview: "Beyond the limit",
                validatedMessageReference: true,
              },
            },
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "999",
                preview: "Unmatched preview",
                validatedMessageReference: true,
              },
            },
          ],
        }),
      );

      const job = fixture.store.jobByEvent(
        fixture.registration.key,
        `${activity().conversation.id}:quoted-approval`,
      );

      expect(job?.text).toBe(
        'Review these?\n\nQuoted Teams messages (untrusted context only):\n[{"id":"100"},{"id":"101"},{"id":"102"}]',
      );
      expect(fixture.backend.replies).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe("Teams personal document receipt", () => {
  test("the gateway reports unavailable documents to the original Teams request", async () => {
    const fixture = documentFixture(() => new Response(null, { status: 403 }));

    const backend = Object.assign(fixture.backend, {
      supportsAttachments: true,
    });

    const prompt = spyOn(backend, "prompt");

    const gateway = new Gateway(
      fixture.config,
      { team: TENANT_ID, user: APP_ID },
      fixture.store,
      backend,
      fixture.registration.delivery,
      pino({ enabled: false }),
      undefined,
      undefined,
      fixture.registration.transport,
    );

    try {
      const current = activity({ text: "", attachments: [file()] });

      expect(await fixture.registration.accept(current)).toBe(true);

      const job = fixture.store.ready(
        fixture.registration.key,
        Date.now(),
        1,
      )[0];

      if (!job) {
        throw new Error("Missing document job");
      }

      await gateway.process(job, new AbortController().signal);
      expect(prompt).not.toHaveBeenCalled();

      const messages = fixture.sent
        .filter((entry) => entry.activity.type === "message")
        .map((entry) => [
          entry.service,
          entry.conversation,
          entry.activity.replyToId,
          entry.activity.text,
        ]);

      expect(messages).toEqual([
        [
          current.serviceUrl,
          current.conversation.id,
          current.id,
          expect.stringContaining("Try attaching them again"),
        ],
      ]);
    } finally {
      prompt.mockRestore();
      await gateway.close();
      await fixture.close();
    }
  });

  test("with document receipt off, text still queues and file-only messages are ignored", async () => {
    const fixture = registrationFixture();
    const current = activity({ attachments: [file()] });

    try {
      expect(
        await fixture.registration.accept({
          ...current,
          id: "file-only",
          text: "",
        }),
      ).toBe(false);
      expect(await fixture.registration.accept(current)).toBe(true);

      const jobs = fixture.store.ready(
        fixture.registration.key,
        Date.now(),
        10,
      );

      expect(
        jobs.map((job) => [
          job.text,
          fixture.store.attachmentRecords.inputFiles(job.id),
        ]),
      ).toEqual([[current.text, []]]);
    } finally {
      await fixture.close();
    }
  });

  test("queued document capability expires without requesting credentials", async () => {
    const fixture = documentFixture();

    try {
      const job = await fixture.running(
        activity({ text: "", attachments: [file()] }),
      );

      const files = fixture.registration.delivery.files;

      if (!files) {
        throw new Error("Missing attachment transport");
      }

      const future = Date.now() + 120_001;
      const clock = spyOn(Date, "now").mockReturnValue(future);

      try {
        await expect(
          files.download(
            fixture.store.attachmentRecords.inputFiles(job.id),
            job.channel,
            new AbortController().signal,
          ),
        ).rejects.toThrow("Teams document unavailable");
        expect(fixture.requests).toEqual([]);
        expect(fixture.identities).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    } finally {
      await fixture.close();
    }
  });

  test("downloads the exact scoped URL and supplies document bytes under a generated name", async () => {
    const fixture = documentFixture();
    const current = activity({ text: "", attachments: [file()] });

    try {
      expect(await fixture.registration.accept(current)).toBe(true);
      expect(await fixture.registration.accept(current)).toBe(true);

      const jobs = fixture.store.ready(
        fixture.registration.key,
        Date.now(),
        10,
      );

      const job = jobs[0];

      if (!job || !fixture.registration.delivery.files) {
        throw new Error("Missing document job");
      }

      const refs = fixture.store.attachmentRecords.inputFiles(job.id);

      expect(jobs).toHaveLength(1);
      expect(refs).toHaveLength(1);
      expect(JSON.stringify(refs)).not.toContain(host);
      expect(job.text).toBe("Inspect the attached file.");
      expect(fixture.requests).toEqual([]);
      await expect(
        fixture.registration.delivery.files.download(
          refs,
          "other-conversation",
          new AbortController().signal,
        ),
      ).rejects.toThrow();

      const downloaded = await fixture.registration.delivery.files.download(
        refs,
        job.channel,
        new AbortController().signal,
      );

      expect(fixture.identities).toEqual([
        { client: APP_ID, resource: `https://${host}` },
      ]);
      expect(fixture.requests).toEqual([
        { hostname: host, path, token: "file-bearer" },
      ]);
      expect(
        downloaded.map((entry) => [
          entry.name,
          entry.mime,
          new TextDecoder().decode(entry.data),
        ]),
      ).toEqual([["document-1.md", "text/markdown", "Example\n"]]);
      await expect(
        fixture.registration.delivery.files.download(
          refs,
          job.channel,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });

  test("accepts exactly 10 MiB and requires a fresh token after a 401", async () => {
    let attempts = 0;

    const fixture = documentFixture(() => {
      attempts++;

      return attempts === 1
        ? new Response(null, { status: 401 })
        : new Response(new Uint8Array(maxAttachmentBytes).fill(65));
    });

    try {
      const initial = activity({ text: "", attachments: [file()] });
      const initialJob = await fixture.running(initial);
      const files = fixture.registration.delivery.files;

      if (!files) {
        throw new Error("Missing attachment transport");
      }

      await expect(
        files.download(
          fixture.store.attachmentRecords.inputFiles(initialJob.id),
          initialJob.channel,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      const next = { ...initial, id: "reattached" };
      expect(await fixture.registration.accept(next)).toBe(true);

      const nextJob = fixture.store.jobByEvent(
        fixture.registration.key,
        `${next.conversation.id}:${next.id}`,
      );

      if (!nextJob) {
        throw new Error("Missing reattached file job");
      }

      const downloaded = await files.download(
        fixture.store.attachmentRecords.inputFiles(nextJob.id),
        nextJob.channel,
        new AbortController().signal,
      );

      expect(downloaded[0]?.data.byteLength).toBe(maxAttachmentBytes);
      expect(downloaded[0]?.data[0]).toBe(65);
      expect(fixture.identities).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  test("rejects out-of-tenant and unlisted destinations before requesting a token", async () => {
    const fixture = documentFixture();

    try {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(teamsSchema)({
            ...fixture.config,
            attachmentFileHosts: ["*.sharepoint.com"],
          }),
        ),
      ).toBe(true);

      const personal = activity();

      const invalid = [
        file({ tenantId: secondBot }),
        file({
          downloadUrl: documentUrl.replace(host, "other-my.sharepoint.com"),
        }),
        file({ downloadUrl: documentUrl.replace(host, host + ":443") }),
        file({ downloadUrl: documentUrl + "\n" }),
        file({ fileType: "exe" }),
      ];

      for (const [index, attachment] of invalid.entries()) {
        const current = {
          ...personal,
          id: `invalid-${index}`,
          text: "",
          attachments: [attachment],
        };

        expect(await fixture.registration.accept(current)).toBe(true);

        const job = fixture.store.jobByEvent(
          fixture.registration.key,
          `${personal.conversation.id}:${current.id}`,
        );

        if (!job || !fixture.registration.delivery.files) {
          throw new Error("Missing unavailable-file job");
        }

        await expect(
          fixture.registration.delivery.files.download(
            fixture.store.attachmentRecords.inputFiles(job.id),
            job.channel,
            new AbortController().signal,
          ),
        ).rejects.toThrow("Teams document unavailable");
      }

      const shared = {
        ...personal,
        id: "shared-file",
        text: "Read this",
        entities: [{ type: "mention", mentioned: personal.recipient }],
        conversation: {
          id: "allowed-channel",
          conversationType: "groupChat" as const,
          tenantId: TENANT_ID,
        },
        attachments: [file()],
      };

      expect(await fixture.registration.accept(shared)).toBe(true);

      const sharedJob = fixture.store.jobByEvent(
        fixture.registration.key,
        "allowed-channel:shared-file",
      );

      if (!sharedJob || !fixture.registration.delivery.files) {
        throw new Error("Missing unavailable shared file job");
      }

      await expect(
        fixture.registration.delivery.files.download(
          fixture.store.attachmentRecords.inputFiles(sharedJob.id),
          sharedJob.channel,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Teams document unavailable");
      expect(fixture.identities).toEqual([]);
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    () =>
      new Response("Too large", {
        headers: { "content-length": String(maxAttachmentBytes + 1) },
      }),
    () => new Response(new Uint8Array(maxAttachmentBytes + 1)),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.org/" },
      }),
    () => new Response("Bad content", { status: 403 }),
  ])("unavailable documents never reach the model", async (response) => {
    const fixture = documentFixture(response);

    try {
      const job = await fixture.running(
        activity({ text: "", attachments: [file()] }),
      );

      const transport = fixture.registration.delivery.files;

      if (!transport) {
        throw new Error("Missing attachment transport");
      }

      await expect(
        transport.download(
          fixture.store.attachmentRecords.inputFiles(job.id),
          job.channel,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
});
