import { expect, test } from "bun:test";
import { slackContent } from "../src/slack-format";

test("standard Markdown stays unchanged, including literal code and quotes", () => {
  const text =
    '# Heading\n\n**Bold** and [link](https://example.test).\n\n> Quote\n\n```html\n<!DOCTYPE html>\n<a href="x">A & B</a>\n```';
  expect(slackContent(text).blocks).toEqual([{ type: "markdown", text }]);
});

test("Slack mentions and broadcast directives retain literal rendering", () => {
  for (const text of [
    "<@U123>",
    "<@",
    "<#C123>",
    "<!here>",
    "<!channel>",
    "<!everyone>",
    "<!subteam^S123>",
    "hello @here",
    "@channel",
    "@everyone",
  ]) {
    expect(slackContent(text).blocks).toEqual([
      { type: "section", text: { type: "plain_text", text, emoji: false } },
    ]);
    expect(slackContent(text).text).not.toContain("<");
  }
});

test("scheduled announcements can explicitly retain plain-text names", () => {
  const text = "Scheduled task: **literal title**";
  expect(slackContent(text, "plain").blocks).toEqual([
    { type: "section", text: { type: "plain_text", text, emoji: false } },
  ]);
});
