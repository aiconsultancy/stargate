import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  settingsCheck,
  settingsDiscriminatedUnion,
  settingsPattern,
  settingsRecord,
  settingsStruct,
} from "../../config/settings-schema";
import { containsCredential } from "../../lib/credentials";

const option = settingsStruct({
  value: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(500),
  ),
  label: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(300),
  ),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxCodePoints(1500)),
  ),
});

const fieldBase = {
  key: Schema.String.check(settingsPattern(/^q[0-9]{1,2}$/)),
  title: Schema.optional(Schema.String.check(Schema.isMaxCodePoints(300))),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxCodePoints(4000)),
  ),
  required: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Literal(false)),
  custom: Schema.optional(Schema.Boolean),
};

const field = settingsDiscriminatedUnion("type", [
  settingsStruct({
    ...fieldBase,
    type: Schema.Literal("string"),
    options: Schema.optional(
      Schema.mutable(Schema.Array(option)).check(Schema.isMaxLength(20)),
    ),
  }),
  settingsStruct({
    ...fieldBase,
    type: Schema.Literal("multiselect"),
    options: Schema.mutable(Schema.Array(option)).check(Schema.isMaxLength(20)),
    minItems: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
    ),
    maxItems: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    ),
  }),
]);

/** Clarification only. Auth, hidden, conditional and default-valued forms fail closed. */
export const nativeQuestionSchema = settingsStruct({
  id: Schema.String.check(
    settingsPattern(/^frm_[A-Za-z0-9_]+$/),
    Schema.isMaxCodePoints(128),
  ),
  sessionID: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(200),
  ),
  inputID: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(200),
  ),
  toolMessageID: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(200),
  ),
  toolCallID: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(200),
  ),
  fingerprint: Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/)),
  title: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(500),
  ),
  fields: Schema.mutable(Schema.Array(field)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
}).check(
  settingsCheck((value, context) => {
    if (new Set(value.fields.map((f) => f.key)).size !== value.fields.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate question fields",
      });
    }

    if (
      value.fields.some(
        (f) =>
          f.options &&
          new Set(f.options.map((o) => o.value)).size !== f.options.length,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Ambiguous question options",
      });
    }

    if (value.fields.some((f) => f.options?.length === 0 && !f.custom)) {
      context.addIssue({ code: "custom", message: "Empty closed question" });
    }

    const text = [
      value.title,
      ...value.fields.flatMap((f) => [
        f.title ?? "",
        f.description ?? "",
        ...(f.options ?? []).flatMap((o) => [
          o.value,
          o.label,
          o.description ?? "",
        ]),
      ]),
    ].join("\n");

    if (
      Buffer.byteLength(text) > 12_000 ||
      containsCredential(text) ||
      /\b(password|passcode|secret|credential|api[ -]?key|access[ -]?token|private[ -]?key|one[ -]?time[ -]?code)\b/i.test(
        text,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Sensitive or oversized question",
      });
    }
  }),
);

export type NativeQuestion = typeof nativeQuestionSchema.Type;

/** Verified question-tool ownership, with unsafe/unsupported content omitted. */
export type UnsupportedQuestion = Pick<
  NativeQuestion,
  | "id"
  | "sessionID"
  | "inputID"
  | "toolMessageID"
  | "toolCallID"
  | "fingerprint"
> & { unsupported: true };

export type PendingQuestion = NativeQuestion | UnsupportedQuestion;

export type QuestionAnswer = Record<string, string | string[]>;

/** Hash the native form, not just the text selected for display. */
export function questionFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map((item) => canonical(item));
    }

    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([k, item]) => [k, canonical(item)]),
      );
    }

    return v;
  };

  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function questionAnswer(
  question: NativeQuestion,
  text: string,
): QuestionAnswer {
  if (text.length > 4000 || containsCredential(text)) {
    throw new Error("Unsafe question answer");
  }

  let input: unknown;

  if (question.fields.length === 1 && !text.trimStart().startsWith("{")) {
    const f = question.fields[0];

    if (!f) {
      throw new Error("Missing question field");
    }

    const choices = text.split(",").map((v) => v.trim());

    const selected = choices.map((v) =>
      /^\d+$/.test(v) ? f.options?.[Number(v) - 1]?.value : undefined,
    );

    const value = selected.every((v) => v !== undefined)
      ? f.type === "multiselect"
        ? selected
        : selected.length === 1
          ? selected[0]
          : undefined
      : f.type === "string"
        ? text
        : choices;

    input = { [f.key]: value };
  } else {
    input = JSON.parse(text);
  }

  const answerText = Schema.String.check(Schema.isMaxCodePoints(2000));

  const answerList = Schema.mutable(Schema.Array(answerText)).check(
    Schema.isMaxLength(20),
  );

  const answerSchema = settingsRecord(
    Schema.String,
    Schema.Union([answerText, answerList]),
  );

  const parsed = Schema.decodeUnknownSync(answerSchema)(input);

  if (
    Object.keys(parsed).some(
      (key) => !question.fields.some((f) => f.key === key),
    )
  ) {
    throw new Error("Unknown answer field");
  }

  for (const f of question.fields) {
    const value = parsed[f.key];

    if (value === undefined) {
      if (f.required !== false) {
        throw new Error("Missing answer field");
      }

      continue;
    }

    if (
      f.type === "string" ? typeof value !== "string" : !Array.isArray(value)
    ) {
      throw new Error("Wrong answer type");
    }

    const values = typeof value === "string" ? [value] : value;

    if (
      new Set(values).size !== values.length ||
      values.some((v) => !v.trim() || containsCredential(v))
    ) {
      throw new Error("Invalid answer");
    }

    const options = f.options;

    if (
      options &&
      !f.custom &&
      values.some((v) => !options.some((o) => o.value === v))
    ) {
      throw new Error("Unknown answer choice");
    }

    if (
      f.type === "multiselect" &&
      (values.length < (f.minItems ?? 1) || values.length > (f.maxItems ?? 20))
    ) {
      throw new Error("Wrong selection count");
    }
  }

  return parsed;
}
