import type { NativeQuestion } from "./native-question";

export type QuestionControl = {
  target: string;
  token: string;
  answer: string | null | undefined;
  renew?: true;
  invalid?: true;
};

/** Reserve unmistakable token controls, never ordinary `answer …` prose. */
export function questionControl(text: string): QuestionControl | undefined {
  const match =
    /^([^\s:,]{1,64})[:,]\s+(answer|cancel-question|renew-question)\s+([a-f0-9]{32})(?:\s+([^\r\n]{1,4000}))?\s*$/i.exec(
      text,
    );

  if (!match) {
    const malformed =
      /^([^\s:,]{1,64})[:,]\s+(?:answer|cancel-question|renew-question)\s+(\S+)/i.exec(
        text,
      );

    const candidate = malformed?.[2];

    if (
      malformed &&
      candidate &&
      /^[a-f0-9]{24,128}[.,:;!?…)]*$/i.test(candidate)
    )
      return {
        target: (malformed[1] ?? "").replace(/^@/, ""),
        token: "",
        answer: undefined,
        invalid: true,
      };

    return;
  }

  return {
    target: (match[1] ?? "").replace(/^@/, ""),
    token: match[3]?.toLowerCase() ?? "",
    answer: match[2]?.toLowerCase() === "answer" ? match[4] : null,
    ...(match[2]?.toLowerCase() === "renew-question" && {
      renew: true as const,
    }),
  };
}

export function questionFields(question: NativeQuestion) {
  const lines = [
    "OpenCode needs clarification (not a permission approval):",
    question.title,
  ];

  for (const f of question.fields) {
    lines.push(
      `${f.key}: ${[f.title, f.description].filter(Boolean).join(" — ")}`,
    );

    for (const [index, o] of (f.options ?? []).entries()) {
      lines.push(
        `${index + 1}. ${o.label} (value ${JSON.stringify(o.value)})${o.description ? ` — ${o.description}` : ""}`,
      );
    }
  }

  return lines;
}

export function questionText(
  question: NativeQuestion,
  account: string,
  token: string,
): string {
  const lines = questionFields(question);
  lines.push(
    `Only the original requester may reply in this thread: ${account}: answer ${token} ${question.fields.length === 1 ? "<choice number or answer>" : '<JSON object, for example {"q0":"choice"}>'}`,
  );

  if (question.fields.some((f) => f.type === "multiselect"))
    lines.push(
      "For multiple choices use comma-separated numbers; a JSON answer uses native option values.",
    );
  lines.push(
    `Or: ${account}: cancel-question ${token}`,
    `After expiry, only you may request a fresh offer here: ${account}: renew-question ${token}`,
    "Valid for 30 minutes. Never send credentials.",
  );
  const text = lines.join("\n");

  if (Buffer.byteLength(text) > 16_000)
    throw new Error("Question is too large for IRC");

  return text;
}
