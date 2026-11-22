import { expect, test } from "bun:test";
import {
  parseReactionReply,
  reactionInstructions,
  reactionNames,
  silentDirective,
} from "../src/shared/reactions";

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
    expect(
      parseReactionReply(`[[stargate:react:${name}]]\nMy response.`),
    ).toEqual({
      text: "My response.",
      pending: false,
      reaction: name,
      silent: false,
    });
  }
  expect(parseReactionReply("[[stargate:react:eyes]]\r\nReviewed.").text).toBe(
    "Reviewed.",
  );
  expect(parseReactionReply("[[stargate:react:thumbsup]]")).toEqual({
    text: "",
    pending: false,
    reaction: "thumbsup",
    silent: false,
  });
});

test("invalid, quoted, embedded, and target-bearing directives remain ordinary text", () => {
  for (const text of [
    "[[stargate:react:unknown]]\nResponse",
    "[[stargate:react:eyes channel=COTHER timestamp=123.456]]\nResponse",
    " [[stargate:react:eyes]]\nResponse",
    "\n[[stargate:react:eyes]]\nResponse",
    "> [[stargate:react:eyes]]\nResponse",
    "```\n[[stargate:react:eyes]]\n```",
    "Example: [[stargate:react:thumbsup]]",
    "[[stargate:react:eyes]] trailing prose",
    "[[stargate:react:eyes",
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
  const directive = "[[stargate:react:eyes]]";
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
  expect(parseReactionReply("[[stargate:react:not-supported", false)).toEqual({
    text: "[[stargate:react:not-supported",
    pending: false,
    reaction: undefined,
    silent: false,
  });
  expect(parseReactionReply("Normal answer", false).pending).toBe(false);
});

test("a first-line silent directive removes all public text", () => {
  for (const text of [
    "[[stargate:silent]]",
    "[[stargate:silent]]\n",
    "[[stargate:silent]]\r\nThat message is for another captain.",
    "[[stargate:silent]]\n![proof](file:///tmp/proof.png)",
  ]) {
    expect(parseReactionReply(text)).toEqual({
      text: "",
      pending: false,
      reaction: undefined,
      silent: true,
    });
  }
  expect(silentDirective).toBe("[[stargate:silent]]");
  expect(reactionInstructions).toContain(silentDirective);
});

test("silent combines with one reaction in either order", () => {
  for (const text of [
    "[[stargate:react:eyes]]\n[[stargate:silent]]",
    "[[stargate:silent]]\n[[stargate:react:eyes]]",
    "[[stargate:silent]]\r\n[[stargate:react:eyes]]\r\nNot posted.",
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
    parseReactionReply(
      "[[stargate:react:eyes]]\n[[stargate:react:tada]]\nText",
    ),
  ).toEqual({
    text: "[[stargate:react:tada]]\nText",
    pending: false,
    reaction: "eyes",
    silent: false,
  });
  expect(
    parseReactionReply("[[stargate:react:eyes]]\nText\n[[stargate:silent]]"),
  ).toEqual({
    text: "Text\n[[stargate:silent]]",
    pending: false,
    reaction: "eyes",
    silent: false,
  });
});

test("quoted, embedded, late and altered silent directives remain ordinary text", () => {
  for (const text of [
    " [[stargate:silent]]",
    "\n[[stargate:silent]]",
    "> [[stargate:silent]]",
    "```\n[[stargate:silent]]\n```",
    "Example: [[stargate:silent]]",
    "[[stargate:silent]] trailing prose",
    "[[stargate:silent:all]]",
    "[[STARGATE:SILENT]]",
    "[[stargate:silent",
    "Answer first.\n[[stargate:silent]]",
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
  expect(
    parseReactionReply("[[stargate:react:eyes]]\n[[stargate:sil", false),
  ).toEqual({
    text: "",
    pending: true,
    reaction: "eyes",
    silent: false,
  });
  expect(parseReactionReply("[[stargate:silentish", false)).toEqual({
    text: "[[stargate:silentish",
    pending: false,
    reaction: undefined,
    silent: false,
  });
});
