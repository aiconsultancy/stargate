import { expect, test } from "bun:test";
import {
  parseReactionReply,
  reactionInstructions,
  reactionNames,
  silentDirective,
} from "../src/reactions";

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
      silent: false,
    });
  }
});

test("explicit first-line directives select supported emoji and strip only that line", () => {
  for (const name of reactionNames) {
    expect(parseReactionReply(`[[pogo:react:${name}]]\nMy response.`)).toEqual({
      text: "My response.",
      pending: false,
      reaction: name,
      silent: false,
    });
  }
  expect(parseReactionReply("[[pogo:react:eyes]]\r\nReviewed.").text).toBe(
    "Reviewed.",
  );
  expect(parseReactionReply("[[pogo:react:thumbsup]]")).toEqual({
    text: "",
    pending: false,
    reaction: "thumbsup",
    silent: false,
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
      silent: false,
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
      silent: false,
    });
  }
  expect(parseReactionReply(`${directive}\r`, false).pending).toBe(true);
  expect(parseReactionReply(`${directive}\nLooking now.`, false)).toEqual({
    text: "Looking now.",
    pending: false,
    reaction: "eyes",
    silent: false,
  });
  expect(parseReactionReply("[[pogo:react:not-supported", false)).toEqual({
    text: "[[pogo:react:not-supported",
    pending: false,
    reaction: undefined,
    silent: false,
  });
  expect(parseReactionReply("Normal answer", false).pending).toBe(false);
});

test("a first-line silent directive removes all public text", () => {
  for (const text of [
    "[[pogo:silent]]",
    "[[pogo:silent]]\n",
    "[[pogo:silent]]\r\nThat message is for another captain.",
    "[[pogo:silent]]\n![proof](file:///tmp/proof.png)",
  ]) {
    expect(parseReactionReply(text)).toEqual({
      text: "",
      pending: false,
      reaction: undefined,
      silent: true,
    });
  }
  expect(silentDirective).toBe("[[pogo:silent]]");
  expect(reactionInstructions).toContain(silentDirective);
});

test("silent combines with one reaction in either order", () => {
  for (const text of [
    "[[pogo:react:eyes]]\n[[pogo:silent]]",
    "[[pogo:silent]]\n[[pogo:react:eyes]]",
    "[[pogo:silent]]\r\n[[pogo:react:eyes]]\r\nNot posted.",
  ]) {
    expect(parseReactionReply(text)).toEqual({
      text: "",
      pending: false,
      reaction: "eyes",
      silent: true,
    });
  }
  // Each directive leads at most once; a repeat is ordinary text.
  expect(
    parseReactionReply("[[pogo:react:eyes]]\n[[pogo:react:tada]]\nText"),
  ).toEqual({
    text: "[[pogo:react:tada]]\nText",
    pending: false,
    reaction: "eyes",
    silent: false,
  });
  expect(
    parseReactionReply("[[pogo:react:eyes]]\nText\n[[pogo:silent]]"),
  ).toEqual({
    text: "Text\n[[pogo:silent]]",
    pending: false,
    reaction: "eyes",
    silent: false,
  });
});

test("quoted, embedded, late and altered silent directives remain ordinary text", () => {
  for (const text of [
    " [[pogo:silent]]",
    "\n[[pogo:silent]]",
    "> [[pogo:silent]]",
    "```\n[[pogo:silent]]\n```",
    "Example: [[pogo:silent]]",
    "[[pogo:silent]] trailing prose",
    "[[pogo:silent:all]]",
    "[[POGO:SILENT]]",
    "[[pogo:silent",
    "Answer first.\n[[pogo:silent]]",
  ]) {
    expect(parseReactionReply(text)).toEqual({
      text,
      pending: false,
      reaction: undefined,
      silent: false,
    });
  }
});

test("streaming holds a possible silent directive until its line completes", () => {
  for (let length = 0; length < silentDirective.length; length++) {
    expect(parseReactionReply(silentDirective.slice(0, length), false)).toEqual(
      { text: "", pending: true, reaction: undefined, silent: false },
    );
  }
  expect(parseReactionReply(`${silentDirective}\r`, false).pending).toBe(true);
  // The line is complete: silent is known while a reaction line can follow.
  expect(parseReactionReply(`${silentDirective}\n`, false)).toEqual({
    text: "",
    pending: true,
    reaction: undefined,
    silent: true,
  });
  expect(parseReactionReply(`${silentDirective}\nNot posted`, false)).toEqual({
    text: "",
    pending: false,
    reaction: undefined,
    silent: true,
  });
  expect(parseReactionReply("[[pogo:react:eyes]]\n[[pogo:sil", false)).toEqual({
    text: "",
    pending: true,
    reaction: "eyes",
    silent: false,
  });
  expect(parseReactionReply("[[pogo:silentish", false)).toEqual({
    text: "[[pogo:silentish",
    pending: false,
    reaction: undefined,
    silent: false,
  });
});
