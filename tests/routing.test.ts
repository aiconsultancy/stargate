import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { backendSchema, configSchema, secret } from "../src/config";
import { botKey, chunks, routeEvent } from "../src/gateway/routing";
import { bot, event, identity } from "./fixtures";

describe("routing", () => {
  test("explicit user wildcard allows humans without widening other boundaries", () => {
    const config = bot();
    config.access.users = ["*"];
    const request = { ...event(), event: { ...event().event, user: "U999" } };
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(configSchema)({ bots: [config] }),
      ),
    ).toBe(true);
    expect(routeEvent(request, config, identity)?.user).toBe("U999");
    expect(
      routeEvent({ ...request, team_id: "T999" }, config, identity),
    ).toBeUndefined();
    expect(
      routeEvent(
        { ...request, event: { ...request.event, channel: "C999" } },
        config,
        identity,
      ),
    ).toBeUndefined();
    expect(
      routeEvent(
        { ...request, event: { ...request.event, bot_id: "B123" } },
        config,
        identity,
      ),
    ).toBeUndefined();
  });

  test("channel wildcard permits new channels and DMs without widening identity", () => {
    const config = bot();
    config.access.users = ["*"];
    config.access.channels = ["*"];
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(configSchema)({ bots: [config] }),
      ),
    ).toBe(true);
    const request = {
      ...event(),
      event: { ...event().event, user: "U999", channel: "C999" },
    };
    expect(routeEvent(request, config, identity)?.channel).toBe("C999");
    expect(
      routeEvent(
        {
          ...request,
          event: { ...request.event, channel: "D999", channel_type: "im" },
        },
        config,
        identity,
      )?.channel,
    ).toBe("D999");
    expect(
      routeEvent({ ...request, team_id: "T999" }, config, identity),
    ).toBeUndefined();
    expect(
      routeEvent({ ...request, api_app_id: "A999" }, config, identity),
    ).toBeUndefined();
    expect(
      routeEvent(
        { ...request, event: { ...request.event, bot_id: "B999" } },
        config,
        identity,
      ),
    ).toBeUndefined();
  });

  test("user and channel denies beat exact and wildcard allows", () => {
    for (const wildcard of [false, true]) {
      for (const dimension of ["users", "channels"] as const) {
        const config = bot();
        if (wildcard) {
          config.access.users = ["*"];
          config.access.channels = ["*"];
        }
        if (dimension === "users") config.access.deniedUsers = ["U123"];
        else config.access.deniedChannels = ["C123"];
        expect(routeEvent(event(), config, identity)).toBeUndefined();
      }
    }
    for (const field of ["deniedUsers", "deniedChannels"] as const) {
      const config = bot();
      config.access[field] = ["*"];
      expect(routeEvent(event(), config, identity)).toBeUndefined();
    }
  });

  test("denies do not block unrelated IDs and malformed rules are rejected", () => {
    const config = bot();
    config.access.users = ["*"];
    config.access.channels = ["*"];
    config.access.deniedUsers = ["U999"];
    config.access.deniedChannels = ["C999"];
    expect(routeEvent(event(), config, identity)?.text).toBe("hello");
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(configSchema)({ bots: [config] }),
      ),
    ).toBe(true);
    for (const access of [
      { ...config.access, channels: ["C*"] },
      { ...config.access, deniedUsers: ["C123"] },
      { ...config.access, deniedChannels: ["U123"] },
    ]) {
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(configSchema)({
            bots: [{ ...config, access }],
          }),
        ),
      ).toBe(false);
    }
  });

  test("isolates bots, teams, threads, and backend settings", () => {
    const first = routeEvent(event(), bot(), identity);
    expect(first?.text).toBe("hello");
    expect(first?.conversation).not.toBe(
      routeEvent(event(), bot("other"), identity)?.conversation,
    );
    expect(botKey(bot(), identity)).not.toBe(
      botKey(bot(), { ...identity, team: "T456" }),
    );
    expect(first?.conversation).not.toBe(
      routeEvent(event("<@UBOT> other", "2.000"), bot(), identity)
        ?.conversation,
    );
    const changed = bot();
    if (changed.backend.type === "opencode")
      changed.backend.directory = "/different";
    expect(botKey(changed, identity)).not.toBe(botKey(bot(), identity));
  });

  test("deduplicates mention and message events by message timestamp", () => {
    const message = event();
    const mention = routeEvent(message, bot(), identity);
    message.event.type = "message";
    message.event_id = "EvDifferent";
    expect(routeEvent(message, bot(), identity)?.eventId).toBe(
      mention?.eventId,
    );
  });

  test("rejects wrong identity, denied people/channels, bots and edits", () => {
    const cases = [
      { ...event(), api_app_id: "A999" },
      { ...event(), team_id: "T999" },
      { ...event(), event: { ...event().event, user: "U999" } },
      { ...event(), event: { ...event().event, channel: "C999" } },
      { ...event(), event: { ...event().event, user: "UBOT" } },
      { ...event(), event: { ...event().event, bot_id: "B123" } },
      { ...event(), event: { ...event().event, subtype: "message_changed" } },
      { ...event(), event: { ...event().event, hidden: true } },
      event("<@UBOT> "),
      {},
    ];
    for (const value of cases)
      expect(routeEvent(value, bot(), identity)).toBeUndefined();
  });

  test("thread replies require subscription; mention-only overrides it", () => {
    const reply = {
      ...event(),
      event: {
        ...event("continue", "2.000").event,
        type: "message",
        thread_ts: "1.000",
      },
    };
    const result = routeEvent(reply, bot(), identity);
    expect(result?.startsConversation).toBe(false);
    expect(result?.conversation).toBe(
      routeEvent(event(), bot(), identity)?.conversation,
    );
    const config = bot();
    config.access.mentionOnly = true;
    expect(routeEvent(reply, config, identity)).toBeUndefined();
  });

  test("allowed DMs can start conversations without mentions", () => {
    const dm = {
      ...event(),
      event: { ...event("hello").event, channel: "D123", channel_type: "im" },
    };
    expect(routeEvent(dm, bot(), identity)?.startsConversation).toBe(true);
  });

  test("chunks preserve Unicode and bound response size", () => {
    const text = "🦘".repeat(3000);
    const result = chunks(text);
    expect(result.join("")).toBe(text);
    expect(Array.from(result[0] ?? "")).toHaveLength(2800);
    expect(chunks("")).toEqual(["Agent finished without a text reply."]);
    expect(chunks("a".repeat(70_000)).join("")).toEndWith(
      "[Response truncated by Stargate.]",
    );
  });
});

test("config fails closed and rejects duplicate registrations", () => {
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({
        bots: [{ ...bot(), access: { users: [], channels: [] } }],
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({ bots: [bot(), bot()] }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(backendSchema)({
        type: "opencode",
        url: "file:///secret",
        directory: "/work",
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(backendSchema)({
        type: "pi-durable",
        directory: "/work",
        model: "unknown/model",
      }),
    ),
  ).toBe(false);
  expect(() => secret("MISSING", {})).toThrow("Missing environment variable");
});
