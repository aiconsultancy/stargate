import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import {
  configActionSchema,
  configSnapshotSchema,
} from "../src/chat/meta-commands/config-panel";
import { ircBurstMessageSchema } from "../src/transports/irc/burst";
import type { QuestionSettings } from "../src/chat/questions/question-settings";
import {
  questionAnswer,
  nativeQuestionSchema,
} from "../src/chat/questions/native-question";
import { envelopeSchema } from "../src/gateway/routing";
import { activitySchema } from "../src/transports/teams/registration";
import { activity } from "./teams-support";

test("chat admission, question and stored interaction roots use native codecs", () => {
  for (const schema of [
    envelopeSchema,
    configActionSchema,
    configSnapshotSchema,
    nativeQuestionSchema,
    ircBurstMessageSchema,
    activitySchema,
  ]) {
    expect(Schema.isSchema(schema)).toBe(true);
  }
});

test("panel snapshot validates question settings without replacing or ordering them", () => {
  const questions: QuestionSettings = {
    answer: "allowed",
    timeoutMs: 300_000,
    enabled: true,
  };

  const snapshot = {
    delayMs: null,
    waitingFingerprint: "waiting",
    questions,
    questionsFingerprint: "questions",
    mutes: "[]",
    mutesFingerprint: "mutes",
  };

  const decode = Schema.decodeUnknownSync(configSnapshotSchema);
  const decoded = decode(snapshot);
  expect(decoded.questions).toBe(questions);
  expect(JSON.stringify(decoded)).toBe(JSON.stringify(snapshot));
  expect(() => decode({ ...snapshot, questions: {} })).toThrow();
  expect(() => decode({ ...snapshot, extra: undefined })).toThrow();
  expect(() =>
    decode(Object.assign(Object.create({ extra: true }), snapshot)),
  ).toThrow();
});

test("Teams codec preserves defaults, stripping, UTC calendar and UUID dialect", () => {
  const decode = Schema.decodeUnknownSync(activitySchema);
  const original = activity();
  const decoded = decode({ ...original, text: undefined, extra: true });
  expect(decoded.text).toBe("");
  expect(Object.hasOwn(decoded, "extra")).toBe(false);
  expect(() => decode({ ...original, text: null })).toThrow();

  for (const timestamp of [
    "2024-02-29T23:59:59Z",
    "2000-02-29T00:00:00.000001Z",
  ]) {
    expect(decode({ ...original, timestamp }).timestamp).toBe(timestamp);
  }

  for (const timestamp of [
    "1900-02-29T00:00:00Z",
    "2024-02-30T00:00:00Z",
    "2024-01-01T00:00Z",
    "2024-01-01T00:00:00+00:00",
    "2024-01-01T00:00:00z",
  ]) {
    expect(() => decode({ ...original, timestamp })).toThrow();
  }

  for (const aadObjectId of [
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ]) {
    expect(
      decode({ ...original, from: { ...original.from, aadObjectId } }).from
        .aadObjectId,
    ).toBe(aadObjectId);
  }

  expect(() =>
    decode({
      ...original,
      from: {
        ...original.from,
        aadObjectId: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      },
    }),
  ).toThrow();
});

test("question codecs retain inverted bounds, strict nested keys and Unicode units", () => {
  const question = {
    id: "frm_codec",
    sessionID: "session",
    inputID: "input",
    toolMessageID: "message",
    toolCallID: "call",
    fingerprint: "a".repeat(64),
    title: "Choose a route",
    fields: [{ key: "q0", type: "string", custom: true }],
  };

  const decode = Schema.decodeUnknownSync(nativeQuestionSchema);
  const decoded = decode(question);
  expect(
    questionAnswer(decoded, JSON.stringify({ q0: "😀".repeat(1994) })),
  ).toEqual({ q0: "😀".repeat(1994) });
  expect(() =>
    questionAnswer(decoded, JSON.stringify({ q0: "😀".repeat(2000) })),
  ).toThrow();

  const inverted = decode({
    ...question,
    fields: [
      {
        key: "q0",
        type: "multiselect",
        custom: true,
        options: [],
        minItems: 5,
        maxItems: 1,
      },
    ],
  });

  expect(inverted.fields[0]).toMatchObject({ minItems: 5, maxItems: 1 });
  expect(() =>
    decode({
      ...question,
      fields: [{ ...question.fields[0], unknown: undefined }],
    }),
  ).toThrow();
  expect(() =>
    decode({
      ...question,
      fields: [
        Object.assign(Object.create({ unknown: true }), question.fields[0]),
      ],
    }),
  ).toThrow();
  const title = "😀".repeat(500);
  expect(decode({ ...question, title }).title).toBe(title);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(nativeQuestionSchema)({
        ...question,
        title: `${title}x`,
      }),
    ),
  ).toBe(true);
});
