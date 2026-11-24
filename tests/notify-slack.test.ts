import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { Schema } from "effect";
import pino from "pino";
import { resolveDestinations } from "../src/notifications/ingest/binding";
import { notifySchema } from "../src/notifications/ingest/config";
import {
  notificationOutcome,
  slackNotificationSink,
} from "../src/notifications/ingest/slack";
import { SlackConnection } from "../src/transports/slack/slack";
import { bot } from "./fixtures";
import { notificationConfig } from "./notify-runtime-fixture";

test("maximum Unicode and instruction-like payloads remain literal in one bounded Slack post", async () => {
  const calls: URLSearchParams[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push(new URLSearchParams(await request.text()));

      return Response.json({ ok: true, ts: "1.000" });
    },
  });

  const connection = new SlackConnection(
    "fixture-app",
    "fixture-bot",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
  );

  const inert = "<@U123> <!channel> *bold* /cron Cain\r\n\0";

  const payload = {
    title: "😀".repeat(200),
    body: inert + "😀".repeat(2800 - [...inert].length),
    url: `https://example.com/${"a".repeat(2028)}`,
  };

  try {
    expect(
      await connection.notification(
        "C123",
        payload,
        new AbortController().signal,
      ),
    ).toEqual({ state: "sent" });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.get("channel")).toBe("C123");

    for (const flag of ["mrkdwn", "unfurl_links", "unfurl_media"]) {
      expect(call?.get(flag)).toBe("false");
    }

    expect(call?.get("parse")).toBe("none");
    expect(call?.get("thread_ts")).toBeNull();
    expect(call?.get("attachments")).toBeNull();
    expect(call?.get("text")).toContain("&lt;@U123&gt; &lt;!channel&gt;");

    const blocks: {
      type: string;
      text: { type: string; text: string; emoji: boolean };
    }[] = JSON.parse(call?.get("blocks") ?? "null");

    expect(blocks.length).toBeLessThan(8);
    expect(blocks.map((block) => block.text.text).join("")).toBe(
      payload.title + payload.body + payload.url,
    );

    for (const block of blocks) {
      expect(block.type).toBe("section");
      expect(block.text.type).toBe("plain_text");
      expect(block.text.text.length).toBeLessThanOrEqual(2800);
      expect(block.text.emoji).toBe(false);
    }
  } finally {
    await server.stop(true);
  }
});

test("request-scoped cancellation aborts real HTTP without cancelling another destination or hidden retries", async () => {
  const started = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  let stalled = 0;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const data = new URLSearchParams(Buffer.concat(chunks).toString());

      if (data.get("channel") === "CBLOCKED") {
        stalled++;
        response.on("close", () => disconnected.resolve());
        started.resolve();
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, ts: "2.000" }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Missing HTTP fixture port");
  }

  const connection = new SlackConnection(
    "fixture-app",
    "fixture-bot",
    pino({ enabled: false }),
    { slackApiUrl: `http://127.0.0.1:${address.port}/` },
  );

  const controller = new AbortController();

  const sending = connection.notification(
    "CBLOCKED",
    { title: "Blocked" },
    controller.signal,
  );

  try {
    await started.promise;
    expect(
      await connection.notification(
        "COTHER",
        { title: "Independent" },
        new AbortController().signal,
      ),
    ).toEqual({ state: "sent" });
    controller.abort();
    expect(await sending).toEqual({ state: "unknown" });
    await disconnected.promise;
    expect(stalled).toBe(1);
    expect(
      await connection.notification(
        "CBLOCKED",
        { title: "Not dispatched" },
        controller.signal,
      ),
    ).toEqual({ state: "refused", retryable: true });
    expect(stalled).toBe(1);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("positive Slack refusal and Retry-After differ from ambiguous 5xx/network outcomes", async () => {
  let calls = 0;
  let mode = "rate";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;

      if (mode === "rate") {
        return new Response("rate", {
          status: 429,
          headers: { "Retry-After": "7" },
        });
      }

      if (mode === "refused") {
        return Response.json({ ok: false, error: "not_in_channel" });
      }

      return new Response("ambiguous", { status: 500 });
    },
  });

  const connection = new SlackConnection(
    "fixture-app",
    "fixture-bot",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
  );

  try {
    expect(
      await connection.notification(
        "C123",
        { title: "Rate" },
        new AbortController().signal,
      ),
    ).toEqual({ state: "refused", retryable: true, retryAfterMs: 7000 });
    mode = "refused";
    expect(
      await connection.notification(
        "C123",
        { title: "Refused" },
        new AbortController().signal,
      ),
    ).toEqual({ state: "refused", retryable: false });
    mode = "error";
    expect(
      await connection.notification(
        "C123",
        { title: "Unknown" },
        new AbortController().signal,
      ),
    ).toEqual({ state: "unknown" });
    expect(calls).toBe(3);
    expect(
      notificationOutcome(new Error("Do not echo provider error")),
    ).toEqual({ state: "unknown" });
  } finally {
    await server.stop(true);
  }
});

test("CURRENT binding check drops revoked rows instead of posting to a rebound destination", async () => {
  const initial = Schema.decodeUnknownSync(notifySchema)(
    notificationConfig(true),
  );

  const original = { bot: bot(), identity: { team: "T123", user: "UHELPER" } };
  const admitted = resolveDestinations(initial, [original]);
  const frozen = admitted["log"];

  if (!frozen) {
    throw new Error("Missing fixture binding");
  }

  let notify = initial;
  let registrations = [original];
  let sends = 0;

  const sink = slackNotificationSink({
    admitted,
    current: () => ({ notify, registrations }),
    connections: new Map([
      [
        "helper",
        {
          notification: async () => {
            sends++;

            return { state: "sent" as const };
          },
        },
      ],
    ]),
  });

  const destination = { ...frozen, sourceAudience: "internal" as const };
  expect(sink.allowed(destination)).toBe(true);

  for (const change of [
    "alias",
    "removed",
    "app",
    "workspace",
    "user",
    "access",
    "audience",
    "echo",
  ] as const) {
    notify = structuredClone(initial);
    registrations = structuredClone([original]);
    const current = registrations[0];

    if (!current || !notify.destinations["log"]) {
      throw new Error("Missing fixture binding");
    }

    switch (change) {
      case "alias":
        notify.destinations["log"].slack.channel = "COTHER";
        break;
      case "removed":
        notify = { ...notify, destinations: {} };
        break;
      case "app":
        current.bot.slack.appId = "AOTHER";
        break;
      case "workspace":
        current.identity.team = "TOTHER";
        break;
      case "user":
        current.identity.user = "UOTHER";
        break;
      case "access":
        current.bot.access.deniedChannels = ["C123"];
        break;
      case "audience":
        notify.destinations["log"].audience = "public";
        break;
      case "echo":
        registrations.push({
          bot: {
            ...bot("receiver"),
            access: { ...bot().access, peerCaptains: true, users: ["UHELPER"] },
          },
          identity: { team: "T123", user: "URECEIVER" },
        });
        break;
    }

    expect(sink.allowed(destination)).toBe(false);
    expect(
      await sink.send(
        destination,
        { title: change },
        new AbortController().signal,
      ),
    ).toEqual({ state: "refused", retryable: false });
  }

  expect(sends).toBe(0);
  registrations = structuredClone([original]);
  notify = structuredClone(initial);

  if (registrations[0]?.bot.backend.type === "opencode") {
    registrations[0].bot.backend.model = {
      providerID: "different",
      id: "different",
    };
  }

  expect(sink.allowed(destination)).toBe(true);
  expect(
    await sink.send(
      destination,
      { title: "Same physical principal" },
      new AbortController().signal,
    ),
  ).toEqual({ state: "sent" });
  expect(sends).toBe(1);
});

test("revoking one destination does not refuse an independent allowed channel", () => {
  const raw = notificationConfig(true);

  const notify = Schema.decodeUnknownSync(notifySchema)({
    ...raw,
    destinations: {
      ...raw.destinations,
      other: {
        slack: { bot: "helper", channel: "COTHER" },
        audience: "internal",
      },
    },
  });

  const sender = bot();
  sender.access.channels.push("COTHER");

  const registration = {
    bot: sender,
    identity: { team: "T123", user: "UHELPER" },
  };

  const admitted = resolveDestinations(notify, [registration]);
  const first = admitted["log"];
  const other = admitted["other"];

  if (!first || !other) {
    throw new Error("Missing fixture binding");
  }

  sender.access.deniedChannels = ["COTHER"];

  const sink = slackNotificationSink({
    admitted,
    current: () => ({ notify, registrations: [registration] }),
    connections: new Map(),
  });

  expect(sink.allowed({ ...first, sourceAudience: "internal" })).toBe(true);
  expect(sink.allowed({ ...other, sourceAudience: "internal" })).toBe(false);
});
