import { expect, test } from "bun:test";
import { parseReactionReply, reactionNames } from "../src/reactions";

test("normal questions and concrete-item keywords do not trigger reactions", () => {
  for (const text of [
    "",
    "The answer is 42.",
    "I will inspect the PR and read the webpage.",
    "Use :eyes: when you inspect a concrete thing.",
  ]) {
    expect(parseReactionReply(text)).toEqual({
      text,
      pending: false,
      reaction: undefined,
    });
  }
});

test("explicit first-line directives select supported emoji and strip only that line", () => {
  for (const name of reactionNames) {
    expect(parseReactionReply(`[[pogo:react:${name}]]\nMy response.`)).toEqual({
      text: "My response.",
      pending: false,
      reaction: name,
    });
  }
  expect(parseReactionReply("[[pogo:react:eyes]]\r\nReviewed.").text).toBe(
    "Reviewed.",
  );
  expect(parseReactionReply("[[pogo:react:thumbsup]]")).toEqual({
    text: "",
    pending: false,
    reaction: "thumbsup",
  });
});

test("invalid, quoted, embedded, and target-bearing directives remain ordinary text", () => {
  for (const text of [
    "[[pogo:react:unknown]]\nResponse",
    "[[pogo:react:eyes channel=COTHER timestamp=123.456]]\nResponse",
    " [[pogo:react:eyes]]\nResponse",
    "\n[[pogo:react:eyes]]\nResponse",
    "> [[pogo:react:eyes]]\nResponse",
    "```\n[[pogo:react:eyes]]\n```",
    "Example: [[pogo:react:thumbsup]]",
    "[[pogo:react:eyes]] trailing prose",
    "[[pogo:react:eyes",
  ]) {
    expect(parseReactionReply(text)).toEqual({
      text,
      pending: false,
      reaction: undefined,
    });
  }
});

test("streaming buffers only possible leading directives until the line completes", () => {
  const directive = "[[pogo:react:eyes]]";
  for (let length = 0; length <= directive.length; length++) {
    expect(parseReactionReply(directive.slice(0, length), false)).toEqual({
      text: "",
      pending: true,
      reaction: undefined,
    });
  }
  expect(parseReactionReply(`${directive}\r`, false).pending).toBe(true);
  expect(parseReactionReply(`${directive}\nLooking now.`, false)).toEqual({
    text: "Looking now.",
    pending: false,
    reaction: "eyes",
  });
  expect(parseReactionReply("[[pogo:react:not-supported", false)).toEqual({
    text: "[[pogo:react:not-supported",
    pending: false,
    reaction: undefined,
  });
  expect(parseReactionReply("Normal answer", false).pending).toBe(false);
});
