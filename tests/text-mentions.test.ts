import { afterEach, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend, PromptSourceContext } from "../src/backend";
import { botSchema } from "../src/config";
import { Gateway, type SlackDelivery } from "../src/gateway";
import {
  findMention,
  mentionRuleSchema,
  textMentionInstructions,
  textMentionNote,
} from "../src/mentions";
import { PeerDirectory, type PeerSender, peerTurnsPerHour } from "../src/peers";
import { routeEvent } from "../src/routing";
import { Store } from "../src/store";
import { identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const names = ["captains", "all captains", "Galactica", "Adama"];
const defiant: PeerSender = { user: "UDEFIANT", bot: "BDEFIANT" };

function config(
  options: {
    textMentions?: boolean;
    peerCaptains?: boolean;
    mentionOnly?: boolean;
  } = {},
) {
  return Schema.decodeUnknownSync(botSchema)({
    id: "galactica-captain",
    slack: { appId: "A123", appTokenEnv: "APP", botTokenEnv: "BOT" },
    access: {
      users: ["*"],
      channels: ["C123", "C999", "D123"],
      deniedUsers: ["U456"],
      mentionOnly: options.mentionOnly ?? false,
      ...(options.peerCaptains === false ? {} : { peerCaptains: true }),
      ...(options.textMentions === false
        ? {}
        : { textMentions: { channels: ["C123"], names } }),
    },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
    },
  });
}

function message(
  text: string,
  options: {
    ts?: string;
    thread?: string;
    channel?: string;
    user?: string;
    bot?: string;
  } = {},
) {
  const channel = options.channel ?? "C123";
  const ts = options.ts ?? "1.000";
  return {
    api_app_id: "A123",
    team_id: "T123",
    event_id: `Ev${ts}`,
    event: {
      type: "message",
      user: options.user ?? "U123",
      ...(options.bot ? { bot_id: options.bot } : {}),
      channel,
      ...(channel.startsWith("D") ? { channel_type: "im" } : {}),
      text,
      ts,
      ...(options.thread ? { thread_ts: options.thread } : {}),
    },
  };
}

test("setting: off by default; channel IDs and literal names", () => {
  expect(config({ textMentions: false }).access.textMentions).toBeUndefined();
  expect(config().access.textMentions).toEqual({ channels: ["C123"], names });
  for (const rule of [
    { channels: ["*"], names },
    { channels: ["D123"], names },
    { channels: ["C1"], names: ["capt.*"] },
    { channels: ["C1"], names: [] },
  ])
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(mentionRuleSchema)(rule)),
    ).toBe(false);
});

test("the longest whole-word name wins, in any letter case", () => {
  expect(findMention(["Calling ALL CAPTAINS: status"], names)).toBe(
    "all captains",
  );
  expect(findMention(["captains, please update"], names)).toBe("captains");
  expect(findMention(["Galactica's PR merged"], names)).toBe("Galactica");
  expect(findMention(["all\ncaptains"], names)).toBe("all captains");
  for (const text of ["the captain said", "captainship", "galactic", ""])
    expect(findMention([text], names)).toBeUndefined();
});

test("only text that Slack shows can name the bot", () => {
  const cfg = config();
  for (const text of [
    "<https://example.test/captains|notes>",
    "<https://example.test/all-captains>",
    "status :captains: done",
    "<#C123|captains> is busy",
    "<!subteam^S1|@captains> fyi",
    "<@UCAPTAINS>",
  ])
    expect(routeEvent(message(text), cfg, identity)).not.toHaveProperty(
      "textMention",
    );
  expect(
    routeEvent(
      message("see <https://example.test/x|all captains briefing>"),
      cfg,
      identity,
    )?.textMention,
  ).toBe("all captains");
  expect(
    routeEvent(message("<!channel> captains: freeze"), cfg, identity)
      ?.textMention,
  ).toBe("captains");
});

test("routing admits a top-level message that names the bot, marked with the name", () => {
  const cfg = config();
  expect(
    routeEvent(message("Calling all captains: deploy freeze"), cfg, identity),
  ).toMatchObject({ textMention: "all captains", startsConversation: true });
  expect(
    routeEvent(message("captains, check in <@UDEFIANT>"), cfg, identity),
  ).toMatchObject({ textMention: "captains", startsConversation: true });
  // Unrelated text, a thread reply, another channel, or setting off: unchanged.
  for (const [body, c] of [
    [message("lunch is here"), cfg],
    [message("captains?", { ts: "1.100", thread: "1.000" }), cfg],
    [message("all captains", { channel: "C999" }), cfg],
    [message("all captains"), config({ textMentions: false })],
  ] as const) {
    const routed = routeEvent(body, c, identity);
    expect(routed?.startsConversation ?? false).toBe(false);
    expect(routed).not.toHaveProperty("textMention");
  }
  // A typed mention and a DM work as before, with no marker.
  for (const body of [
    message("<@UBOT> all captains"),
    message("all captains", { channel: "D123" }),
  ]) {
    const routed = routeEvent(body, cfg, identity);
    expect(routed?.startsConversation).toBe(true);
    expect(routed).not.toHaveProperty("textMention");
  }
  // mentionOnly admits a named top-level message.
  expect(
    routeEvent(message("all captains"), config({ mentionOnly: true }), identity)
      ?.textMention,
  ).toBe("all captains");
});

test("own bot, denied users and unverified bots are never admitted by text", () => {
  const cfg = config();
  const own = { user: identity.user, bot: "BOWN" };
  expect(
    routeEvent(
      message("all captains", { user: identity.user, bot: "BOWN" }),
      cfg,
      identity,
      own,
    ),
  ).toBeUndefined();
  expect(
    routeEvent(message("all captains", { user: "U456" }), cfg, identity),
  ).toBeUndefined();
  const bot = message("all captains", { user: "UDEFIANT", bot: "BDEFIANT" });
  expect(routeEvent(bot, cfg, identity)).toBeUndefined();
  expect(
    routeEvent(bot, config({ peerCaptains: false }), identity, defiant),
  ).toBeUndefined();
  expect(routeEvent(bot, cfg, identity, defiant)).toMatchObject({
    sender: "captain",
    textMention: "all captains",
  });
});

function fixture() {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const prompts: { text: string; context?: PromptSourceContext }[] = [];
  let answer = "[[stargate:silent]]";
  const backend: AgentBackend = {
    sessionID: "captain",
    async createSession() {
      return "captain";
    },
    async prompt(_session, text, _signal, _onText, _onInput, _files, context) {
      prompts.push({ text, ...(context ? { context } : {}) });
      return answer;
    },
    async close() {},
  };
  const posts: string[] = [];
  const slack: SlackDelivery = {
    async post(_channel, _thread, text) {
      posts.push(text);
    },
  };
  const peers = new PeerDirectory(
    async (user) =>
      user === "UDEFIANT"
        ? {
            ok: true,
            user: {
              id: "UDEFIANT",
              team_id: "T123",
              is_bot: true,
              name: "defiantcaptain",
              real_name: "defiant-captain",
              profile: { bot_id: "BDEFIANT" },
            },
          }
        : { ok: false },
    "T123",
  );
  const gateway = new Gateway(
    config(),
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
    undefined,
    peers,
  );
  cleanup.push(() => gateway.close());
  const signal = new AbortController().signal;
  const drain = async () => {
    for (
      let jobs = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 20);
      jobs.length;
      jobs = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 20)
    )
      for (const job of jobs) await gateway.process(job, signal);
  };
  return {
    gateway,
    prompts,
    posts,
    drain,
    answer(next: string) {
      answer = next;
    },
  };
}

test("an admitted message carries the marker; the captain can stay silent", async () => {
  const f = fixture();
  expect(
    await f.gateway.receive(message("Calling all captains: who has NET-9?")),
  ).toBe(true);
  await f.drain();
  expect(f.prompts[0]?.text).toBe(
    `${textMentionNote("all captains")}\n\nCalling all captains: who has NET-9?`,
  );
  expect(f.prompts[0]?.context?.source.user).toBe("U123");
  expect(f.posts).toEqual([]);
  // The thread is followed thereafter, without a marker on replies.
  f.answer("Galactica has it.");
  expect(
    await f.gateway.receive(
      message("anyone?", { ts: "1.100", thread: "1.000" }),
    ),
  ).toBe(true);
  await f.drain();
  expect(f.prompts[1]?.text).toBe("anyone?");
  expect(f.posts).toEqual(["Galactica has it."]);
});

test("unrelated and typed-mention messages are unchanged", async () => {
  const f = fixture();
  expect(await f.gateway.receive(message("lunch is here"))).toBe(false);
  expect(
    await f.gateway.receive(message("<@UBOT> captains", { ts: "2.000" })),
  ).toBe(true);
  await f.drain();
  expect(f.prompts.map((prompt) => prompt.text)).toEqual(["captains"]);
});

test("a peer captain's call to all captains is admitted and keeps the thread limit", async () => {
  const f = fixture();
  const now = Math.floor(Date.now() / 1000);
  const root = `${now}.000100`;
  expect(
    await f.gateway.receive(
      message("all captains: handoff", {
        ts: root,
        user: "UDEFIANT",
        bot: "BDEFIANT",
      }),
    ),
  ).toBe(true);
  for (let i = 1; i < peerTurnsPerHour; i++)
    expect(
      await f.gateway.receive(
        message(`more ${i}`, {
          ts: `${now + i}.000100`,
          thread: root,
          user: "UDEFIANT",
          bot: "BDEFIANT",
        }),
      ),
    ).toBe(true);
  expect(
    await f.gateway.receive(
      message("again", {
        ts: `${now + 30}.000100`,
        thread: root,
        user: "UDEFIANT",
        bot: "BDEFIANT",
      }),
    ),
  ).toBe(false);
  await f.drain();
  expect(f.prompts[0]?.text).toStartWith(textMentionNote("all captains"));
  expect(f.prompts[0]?.context?.source.sender).toBe("captain");
});

test("captain instructions explain the marker and the silent reply", () => {
  expect(textMentionInstructions).toContain("[Admitted by text mention: NAME]");
  expect(textMentionInstructions).toContain("[[stargate:silent]]");
});
