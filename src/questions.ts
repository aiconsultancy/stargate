import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentBackend } from "./backend";
import { containsCredential } from "./credentials";
import type { Incoming, Job, Store } from "./store";

const option = z.strictObject({
  value: z.string().min(1).max(500),
  label: z.string().min(1).max(300),
  description: z.string().max(1500).optional(),
});
const fieldBase = {
  key: z.string().regex(/^q[0-9]{1,2}$/),
  title: z.string().max(300).optional(),
  description: z.string().max(4000).optional(),
  required: z.boolean().optional(),
  hidden: z.literal(false).optional(),
  custom: z.boolean().optional(),
};
const field = z.discriminatedUnion("type", [
  z.strictObject({
    ...fieldBase,
    type: z.literal("string"),
    options: z.array(option).max(20).optional(),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("multiselect"),
    options: z.array(option).max(20),
    minItems: z.number().int().min(0).max(20).optional(),
    maxItems: z.number().int().min(1).max(20).optional(),
  }),
]);

/** Clarification only. Auth, hidden, conditional and default-valued forms fail closed. */
export const nativeQuestionSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^frm_[A-Za-z0-9_]+$/)
      .max(128),
    sessionID: z.string().min(1).max(200),
    inputID: z.string().min(1).max(200),
    toolMessageID: z.string().min(1).max(200),
    toolCallID: z.string().min(1).max(200),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).max(500),
    fields: z.array(field).min(1).max(8),
  })
  .superRefine((value, context) => {
    if (new Set(value.fields.map((f) => f.key)).size !== value.fields.length)
      context.addIssue({
        code: "custom",
        message: "Duplicate question fields",
      });
    if (
      value.fields.some(
        (f) =>
          f.options &&
          new Set(f.options.map((o) => o.value)).size !== f.options.length,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Ambiguous question options",
      });
    if (value.fields.some((f) => f.options?.length === 0 && !f.custom))
      context.addIssue({ code: "custom", message: "Empty closed question" });
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
    )
      context.addIssue({
        code: "custom",
        message: "Sensitive or oversized question",
      });
  });
export type NativeQuestion = z.infer<typeof nativeQuestionSchema>;
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
export type QuestionOffer = {
  token: string;
  botKey: string;
  formID: string;
  sessionID: string;
  inputID: string;
  jobID: number;
  fingerprint: string;
  expires: number;
  state: "offered" | "attempted" | "closed";
  notified: number;
  recovering: number;
  outcome?: "answered" | "cancelled" | "uncertain" | null;
  outcomeNotified?: number;
};

/** Hash the native form, not just the text selected for display. */
export function questionFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, item]) => [k, canonical(item)]),
      );
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Recognise the namespace even on other ships; controls are never model prompts. */
export function questionControl(text: string) {
  const match =
    /^([^\s:,]{1,64})[:,]\s+(answer|cancel-question)\s+([a-f0-9]{32})(?:\s+([^\r\n]{1,4000}))?\s*$/i.exec(
      text,
    );
  if (!match) return;
  return {
    target: match[1] ?? "",
    token: match[3]?.toLowerCase() ?? "",
    answer: match[2]?.toLowerCase() === "answer" ? match[4] : null,
  };
}

export function questionAnswer(
  question: NativeQuestion,
  text: string,
): QuestionAnswer {
  if (text.length > 4000 || containsCredential(text))
    throw new Error("Unsafe question answer");
  let input: unknown;
  if (question.fields.length === 1 && !text.trimStart().startsWith("{")) {
    const f = question.fields[0];
    if (!f) throw new Error("Missing question field");
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
  } else input = JSON.parse(text);
  const parsed = z
    .record(
      z.string(),
      z.union([z.string().max(2000), z.array(z.string().max(2000)).max(20)]),
    )
    .parse(input);
  if (
    Object.keys(parsed).some(
      (key) => !question.fields.some((f) => f.key === key),
    )
  )
    throw new Error("Unknown answer field");
  for (const f of question.fields) {
    const value = parsed[f.key];
    if (value === undefined) {
      if (f.required !== false) throw new Error("Missing answer field");
      continue;
    }
    if (f.type === "string" ? typeof value !== "string" : !Array.isArray(value))
      throw new Error("Wrong answer type");
    const values = typeof value === "string" ? [value] : value;
    if (
      new Set(values).size !== values.length ||
      values.some((v) => !v.trim() || containsCredential(v))
    )
      throw new Error("Invalid answer");
    const options = f.options;
    if (
      options &&
      !f.custom &&
      values.some((v) => !options.some((o) => o.value === v))
    )
      throw new Error("Unknown answer choice");
    if (
      f.type === "multiselect" &&
      (values.length < (f.minItems ?? 1) || values.length > (f.maxItems ?? 20))
    )
      throw new Error("Wrong selection count");
  }
  return parsed;
}

export function questionText(
  question: NativeQuestion,
  account: string,
  token: string,
): string {
  const lines = [
    "OpenCode needs clarification (not a permission approval):",
    question.title,
  ];
  for (const f of question.fields) {
    lines.push(
      `${f.key}: ${[f.title, f.description].filter(Boolean).join(" — ")}`,
    );
    f.options?.forEach((o, index) => {
      lines.push(
        `${index + 1}. ${o.label} (value ${JSON.stringify(o.value)})${o.description ? ` — ${o.description}` : ""}`,
      );
    });
  }
  lines.push(
    `Only the original requester may reply in this thread: ${account}: answer ${token} ${question.fields.length === 1 ? "<choice number or answer>" : '<JSON object, for example {"q0":"choice"}>'}`,
  );
  if (question.fields.some((f) => f.type === "multiselect"))
    lines.push(
      "For multiple choices use comma-separated numbers; a JSON answer uses native option values.",
    );
  lines.push(`Or: ${account}: cancel-question ${token}`);
  lines.push("Valid for 30 minutes. Never send credentials.");
  const text = lines.join("\n");
  if (Buffer.byteLength(text) > 16_000)
    throw new Error("Question is too large for IRC");
  return text;
}

export type QuestionPort = {
  account: string;
  matchesTarget?(target: string): boolean;
  human(user: string): boolean;
  publish(job: Job, text: string, allowed: () => boolean): Promise<void>;
};

/** Gateway-owned durable forms. Neither the model nor the dashboard can answer. */
export class Questions {
  private offset = 0;
  private readonly inFlight = new Set<string>();
  private pruned = 0;
  constructor(
    private readonly key: string,
    private readonly store: Store,
    private readonly backend: AgentBackend,
    private readonly port: () => QuestionPort | undefined,
    private readonly allowed: (job: Job) => boolean,
    private readonly settled: (session: string) => void,
    private readonly lifetime: AbortSignal = new AbortController().signal,
  ) {}

  private owner(
    offer: Pick<QuestionOffer, "jobID" | "inputID" | "sessionID">,
  ): Job | undefined {
    const job = this.store.jobByInput(this.key, offer.inputID);
    if (
      !job ||
      job.id !== offer.jobID ||
      job.deferDelivery ||
      job.sender ||
      job.fleet ||
      !this.store.ownsQuestionSource(job) ||
      !this.port()?.human(job.user) ||
      !this.allowed(job) ||
      (this.backend.sessionID ?? this.store.session(job.conversation)) !==
        offer.sessionID
    )
      return;
    return job;
  }

  /** Only a previously persisted, still-pending exact native form permits recovery. */
  async recover(signal: AbortSignal): Promise<string[]> {
    const retained: string[] = [];
    for (const offer of this.store.questionOffers(this.key)) {
      const job = this.owner(offer);
      if (job?.status !== "running" || offer.state === "closed") continue;
      if (
        await this.backend.questionBelongsToInput?.(
          offer.sessionID,
          offer.formID,
          offer.inputID,
          offer.fingerprint,
          signal,
        )
      ) {
        this.store.questionRecovering(offer.token);
        retained.push(offer.inputID);
      }
    }
    return retained;
  }

  async poll(signal: AbortSignal) {
    if (Date.now() - this.pruned >= 3_600_000) {
      this.store.pruneIrcHistory(this.key, Date.now());
      this.pruned = Date.now();
    }
    const sessions = [
      ...new Set([
        ...this.store.activeQuestionSessions(this.key, this.backend.sessionID),
        ...this.store.questionOffers(this.key).map((o) => o.sessionID),
      ]),
    ].sort();
    if (!sessions.length) return;
    const selected = Array.from(
      { length: Math.min(16, sessions.length) },
      (_, i) => sessions[(this.offset + i) % sessions.length],
    ).filter((s): s is string => s !== undefined);
    let failed = false;
    for (const session of selected) {
      // Advance before awaiting: even a session exhausting the whole poll's
      // deadline cannot monopolise the first position after every timeout.
      this.offset = (sessions.indexOf(session) + 1) % sessions.length;
      try {
        await this.pollSession(session, signal);
      } catch {
        signal.throwIfAborted();
        failed = true;
      }
    }
    if (failed) throw new Error("Native clarification session unavailable");
  }

  private async pollSession(session: string, signal: AbortSignal) {
    for (const offer of this.store
      .questionOffers(this.key)
      .filter((o) => o.sessionID === session)) {
      if (
        offer.state === "attempted" &&
        !offer.outcome &&
        !this.inFlight.has(offer.token)
      )
        this.store.questionOutcome(offer.token, "uncertain");
      await this.notifyOutcome(
        this.store.questionByToken(this.key, offer.token) ?? offer,
      );
    }
    const pending =
      (await this.backend.pendingQuestions?.(session, signal)) ?? [];
    if (pending.length > 16)
      throw new Error("Too many native clarification questions");
    for (const raw of pending) {
      const question =
        "unsupported" in raw ? raw : nativeQuestionSchema.parse(raw);
      if (question.sessionID !== session) continue;
      const job = this.store.jobByInput(this.key, question.inputID);
      if (
        job?.status !== "running" ||
        !this.owner({
          jobID: job.id,
          inputID: question.inputID,
          sessionID: session,
        })
      )
        continue;
      let offer = this.store.offerQuestion({
        token: randomBytes(16).toString("hex"),
        botKey: this.key,
        formID: question.id,
        sessionID: session,
        inputID: question.inputID,
        jobID: job.id,
        fingerprint: question.fingerprint,
        expires: Date.now() + 1_800_000,
        state: "offered",
        notified: 0,
        recovering: 0,
      });
      let renewed = false;
      if (
        offer?.state === "offered" &&
        offer.expires <= Date.now() &&
        !("unsupported" in question)
      ) {
        if (
          !(await this.backend.questionBelongsToInput?.(
            session,
            question.id,
            question.inputID,
            question.fingerprint,
            signal,
          ))
        )
          continue;
        offer = this.store.renewQuestion(
          offer.token,
          randomBytes(16).toString("hex"),
          Date.now(),
        );
        renewed = !!offer;
      }
      if (offer?.state !== "offered" || offer.notified) continue;
      if (
        !(await this.backend.questionBelongsToInput?.(
          session,
          question.id,
          question.inputID,
          question.fingerprint,
          signal,
        ))
      )
        continue;
      const port = this.port();
      if (!port) continue;
      await port.publish(
        job,
        "unsupported" in question
          ? "OpenCode needs clarification, but this form cannot be safely shown or answered on IRC. The original requester must use the native operator interface. No answer or cancellation has been submitted."
          : `${renewed ? "Previous clarification token expired; use this new token.\n" : ""}${questionText(question, port.account, offer.token)}`,
        () => !signal.aborted && !!this.owner(offer),
      );
      this.store.questionNotified(offer.token);
    }
    for (const offer of this.store
      .questionOffers(this.key)
      .filter((o) => o.sessionID === session)) {
      if (pending.some((q) => q.id === offer.formID)) continue;
      // A filtered list is not proof of absence. Only the native form API can
      // authoritatively report settlement; transient/unsupported forms stay live.
      if (
        (await this.backend.questionState?.(session, offer.formID, signal)) !==
        "resolved"
      )
        continue;
      // The form may settle before its reply request returns. Keep the durable
      // attempt writable until that request records its success/uncertainty.
      // Check after the awaited state read: an answer may start during it.
      if (this.inFlight.has(offer.token)) continue;
      this.store.closeQuestion(offer.token);
      if (
        offer.recovering &&
        (await this.backend.questionInputSettled?.(
          session,
          offer.inputID,
          signal,
        ))
      ) {
        this.store.finishQuestionRecovery(offer);
        this.settled(session);
      }
    }
  }

  private async notifyOutcome(offer: QuestionOffer) {
    if (!offer.outcome || offer.outcomeNotified || this.lifetime.aborted)
      return;
    const job = this.owner(offer);
    const port = this.port();
    if (!job || !port) return;
    try {
      await port.publish(
        job,
        offer.outcome === "uncertain"
          ? "Clarification reply outcome is uncertain. This token is consumed; an operator must check OpenCode before another answer is attempted."
          : "Clarification decision recorded. This grants no tool permission.",
        () => !this.lifetime.aborted && !!this.owner(offer),
      );
      this.store.questionOutcomeNotified(offer.token);
    } catch {
      // Delivery can retry. The native API outcome and spent token cannot change.
    }
  }

  async answer(
    input: Incoming,
    control: NonNullable<ReturnType<typeof questionControl>>,
    signal: AbortSignal,
  ) {
    const offer = this.store.questionByToken(this.key, control.token);
    if (offer?.state !== "offered" || offer.expires <= Date.now()) return;
    const job = this.owner(offer);
    if (
      job?.status !== "running" ||
      !(
        this.port()?.matchesTarget?.(control.target) ??
        control.target.toLowerCase() === this.port()?.account.toLowerCase()
      ) ||
      input.botKey !== this.key ||
      input.sender ||
      input.fleet ||
      input.user !== job.user ||
      input.channel !== job.channel ||
      (input.replyParent ?? input.thread) !== (job.replyParent ?? job.thread) ||
      !this.port()?.human(input.user)
    )
      return;
    const question = (
      await this.backend.pendingQuestions?.(offer.sessionID, signal)
    )?.find(
      (q) =>
        q.id === offer.formID &&
        q.sessionID === offer.sessionID &&
        q.inputID === offer.inputID &&
        q.fingerprint === offer.fingerprint,
    );
    if (
      !question ||
      "unsupported" in question ||
      !(await this.backend.questionBelongsToInput?.(
        offer.sessionID,
        offer.formID,
        offer.inputID,
        offer.fingerprint,
        signal,
      ))
    )
      return;
    let answer: QuestionAnswer | null;
    try {
      answer =
        control.answer === null
          ? null
          : questionAnswer(
              nativeQuestionSchema.parse(question),
              control.answer ?? "",
            );
    } catch {
      await this.port()?.publish(
        job,
        "Invalid clarification answer. Use the displayed choices or JSON field values; no credentials.",
        () => !signal.aborted && !!this.owner(offer),
      );
      return;
    }
    signal.throwIfAborted();
    if (
      !this.owner(offer) ||
      !this.store.attemptQuestion(offer.token, Date.now())
    )
      return;
    this.inFlight.add(offer.token);
    try {
      if (!this.backend.replyQuestion)
        throw new Error("Question reply unavailable");
      await this.backend.replyQuestion(question, answer, signal);
      this.store.questionOutcome(
        offer.token,
        answer === null ? "cancelled" : "answered",
      );
    } catch {
      this.store.questionOutcome(offer.token, "uncertain");
    } finally {
      this.inFlight.delete(offer.token);
    }
    await this.notifyOutcome(
      this.store.questionByToken(this.key, offer.token) ?? offer,
    );
  }
}
