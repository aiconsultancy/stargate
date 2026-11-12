import { expect, test } from "bun:test";
import {
  cleanText,
  formatMessage,
  parseCapabilities,
  parseMessage,
  sourceNick,
  tagBytes,
  utf8Bytes,
} from "../src/irc/protocol";
import { ircLines, plainText } from "../src/irc/text";

test("irc parse: tags, escapes, source, middle and trailing params", () => {
  const message = parseMessage(
    "@time=2026-11-12T10:00:00.000Z;account=jack;msgid=abc;+draft/reply=x\\sy\\:z\\\\;flag :jack!~u@host PRIVMSG #galactica :galactica: hi  there",
  );
  expect(message?.command).toBe("PRIVMSG");
  expect(message?.source).toBe("jack!~u@host");
  expect(message?.params).toEqual(["#galactica", "galactica: hi  there"]);
  expect(message?.tags.get("account")).toBe("jack");
  expect(message?.tags.get("+draft/reply")).toBe("x y;z\\");
  expect(message?.tags.get("flag")).toBe("");
  expect(sourceNick(message?.source)).toBe("jack");
  expect(parseMessage("PING :token")?.params).toEqual(["token"]);
  expect(
    parseMessage(":srv 005 me CHANTYPES=# NETWORK=Fleet :are supported")
      ?.params,
  ).toEqual(["me", "CHANTYPES=#", "NETWORK=Fleet", "are supported"]);
  expect(parseMessage("@lonely")).toBeUndefined();
  expect(parseMessage(":only-source")).toBeUndefined();
  expect(parseMessage("BAD-COMMAND x")).toBeUndefined();
  // Invalid tag keys, such as a prototype name, are dropped.
  expect(parseMessage("@__proto__=x;ok=1 PING")?.tags).toEqual(
    new Map([["ok", "1"]]),
  );
});

test("irc format: escapes tags, refuses injected lines and parameters", () => {
  expect(
    formatMessage("PRIVMSG", ["#c", "hi there"], {
      label: "a;b c",
      "+draft/reply": "m1",
    }),
  ).toBe("@label=a\\:b\\sc;+draft/reply=m1 PRIVMSG #c :hi there");
  expect(formatMessage("JOIN", ["#a,#b"])).toBe("JOIN #a,#b");
  expect(formatMessage("PRIVMSG", ["#c", ":colon"])).toBe("PRIVMSG #c ::colon");
  expect(formatMessage("PRIVMSG", ["#c", ""])).toBe("PRIVMSG #c :");
  expect(() => formatMessage("PRIVMSG", ["#c", "a\r\nQUIT"])).toThrow();
  expect(() => formatMessage("PRIVMSG", ["#c x", "y"])).toThrow();
  expect(() =>
    formatMessage("PRIVMSG", ["#c", "y"], { "bad key": "v" }),
  ).toThrow();
  expect(() => formatMessage("bad", [])).toThrow();
  const round = parseMessage(
    formatMessage("TAGMSG", ["#c"], { "+draft/react": "👀", label: "x\ny" }),
  );
  expect(round?.tags.get("+draft/react")).toBe("👀");
  expect(round?.tags.get("label")).toBe("x\ny");
  expect(tagBytes({})).toBe(0);
  expect(tagBytes({ label: "abc" })).toBe("@label=abc ".length);
});

test("irc capabilities and received text cleanup", () => {
  expect([
    ...parseCapabilities("sasl=PLAIN,EXTERNAL account-tag  batch"),
  ]).toEqual([
    ["sasl", "PLAIN,EXTERNAL"],
    ["account-tag", ""],
    ["batch", ""],
  ]);
  expect(
    cleanText("\u0002bold\u000f \u000304,12red\u0003 \u0004ff00ffhex\tz\u0007"),
  ).toBe("bold red hex z");
  expect(cleanText("\u0001ACTION waves\u0001")).toBe("ACTION waves");
});

test("irc plain text: markdown becomes readable lines", () => {
  const text = plainText(
    [
      "# Status",
      "",
      "**Build** passed and _tests_ ran; keep `a_b_c` and `**kwargs`.",
      "* first",
      "+ second",
      "See [the PR](https://example.com/pr/1) and <https://example.com>.",
      "![chart](https://example.com/c.png)",
      "---",
      "| Name | State |",
      "| ---- | ----- |",
      "| ci   | green |",
      "```ts",
      "const x = **y**;",
      "```",
      "snake_case_name and 2*3*4 stay.",
      "Escaped \\*star\\*.",
      "evil\u0001CTCP\u0003",
    ].join("\n"),
  );
  expect(text.split("\n")).toEqual([
    "Status",
    "",
    "Build passed and tests ran; keep `a_b_c` and `**kwargs`.",
    "- first",
    "- second",
    "See the PR (https://example.com/pr/1) and https://example.com.",
    "chart (https://example.com/c.png)",
    "Name | State",
    "ci   | green",
    "const x = **y**;",
    "snake_case_name and 2*3*4 stay.",
    "Escaped *star*.",
    "evilCTCP",
  ]);
});

test("irc lines: byte budget, whitespace breaks, UTF-8 boundaries", () => {
  expect(ircLines("a\n\n  \nb", 100)).toEqual(["a", "b"]);
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const lines = ircLines(words, 50);
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(utf8Bytes(line)).toBeLessThanOrEqual(50);
    expect(line.startsWith(" ")).toBe(false);
  }
  expect(lines.join(" ")).toBe(words);
  // Multi-byte characters are never split, even without spaces.
  const emoji = "🚀".repeat(30);
  const split = ircLines(emoji, 18);
  for (const line of split) {
    expect(utf8Bytes(line)).toBeLessThanOrEqual(18);
    expect(line).toBe("🚀".repeat(Array.from(line).length));
  }
  expect(split.join("")).toBe(emoji);
  const mixed = `${"é".repeat(20)}x`;
  expect(ircLines(mixed, 17).join("")).toBe(mixed);
  expect(() => ircLines("x", 4)).toThrow();
});
