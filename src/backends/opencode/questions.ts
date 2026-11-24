import {
  type OpenCodeClient,
  isFormNotFoundError,
  isSessionNotFoundError,
} from "@opencode/client";
import { Option, Result, Schema } from "effect";
import {
  type NativeQuestion,
  type PendingQuestion,
  type QuestionAnswer,
  nativeQuestionSchema,
  questionFingerprint,
} from "../../chat/questions/native-question";
import {
  type InputBoundaryRecord,
  boundaryRecord,
  closesBoundaryContext,
  resolveBoundaryContext,
} from "./input-boundary";
import { InputBoundaryReader, inputOwnership } from "./input-origin";

const questionOriginSchema = Schema.Struct({
  kind: Schema.Literal("question"),
  tool: Schema.Struct({
    messageID: Schema.NonEmptyString,
    id: Schema.NonEmptyString,
  }),
});

const decodeQuestionOrigin = Schema.decodeUnknownOption(questionOriginSchema, {
  onExcessProperty: "error",
});

/** Reads and answers forms on an attached OpenCode client. */
export class OpenCodeQuestions {
  public constructor(
    private readonly client: OpenCodeClient,
    private readonly sessionID?: string,
  ) {}

  // Native messages/form IDs are immutable. Recheck their live tool/input state,
  // But do not traverse the entire session twice every second for the same form.
  private readonly questionAncestry = new Map<
    string,
    { fingerprint: string; inputID: string }
  >();
  private async runningQuestion(
    sessionID: string,
    formID: string,
    signal: AbortSignal,
  ) {
    if (this.sessionID !== undefined && sessionID !== this.sessionID) return;

    const form = await this.client.session.form
      .get({ sessionID, formID }, { signal })
      .catch((error: unknown) => {
        if (
          (isFormNotFoundError(error) && error.id === formID) ||
          (isSessionNotFoundError(error) && error.sessionID === sessionID)
        )
          return;
        throw error;
      });

    if (
      !form ||
      form.id !== formID ||
      form.sessionID !== sessionID ||
      form.state.status !== "pending"
    )
      return;
    const origin = decodeQuestionOrigin(form.metadata);

    if (Option.isNone(origin)) return;

    const message = await this.client.session.message.get(
      { sessionID, messageID: origin.value.tool.messageID },
      { signal },
    );

    if (
      message.id !== origin.value.tool.messageID ||
      message.type !== "assistant" ||
      message.time.completed !== undefined
    )
      return;

    const tools = message.content.filter(
      (p) => p.type === "tool" && p.id === origin.value.tool.id,
    );

    const tool = tools[0];

    if (
      tools.length !== 1 ||
      tool?.type !== "tool" ||
      tool.name !== "question" ||
      tool.state.status !== "running" ||
      tool.time.completed !== undefined
    )
      return;

    return { form, toolMessageID: message.id, toolCallID: tool.id };
  }

  public async nativeQuestion(
    sessionID: string,
    formID: string,
    signal: AbortSignal,
  ): Promise<PendingQuestion | undefined> {
    const running = await this.runningQuestion(sessionID, formID, signal);

    if (!running) return;
    const { form, toolMessageID, toolCallID } = running;

    const fingerprint = questionFingerprint({
      id: form.id,
      sessionID,
      title: form.title,
      metadata: form.metadata,
      fields: form.fields,
    });

    const cacheKey = JSON.stringify([
      sessionID,
      form.id,
      toolMessageID,
      toolCallID,
    ]);

    const cached = this.questionAncestry.get(cacheKey);

    let inputID =
      cached?.fingerprint === fingerprint ? cached.inputID : undefined;

    if (inputID) {
      const input = await this.client.session.message.get(
        { sessionID, messageID: inputID },
        { signal },
      );

      if (
        input.id !== inputID ||
        boundaryRecord(input, sessionID).input !== inputID ||
        (await this.client.session.inbox.list({ sessionID }, { signal })).some(
          (v) => v.id === inputID,
        )
      )
        return;
    } else {
      inputID = await this.questionInput(sessionID, toolMessageID, signal);

      if (
        inputID &&
        (await inputOwnership(
          this.client,
          sessionID,
          inputID,
          signal,
          toolMessageID,
        )) === true
      ) {
        if (this.questionAncestry.size >= 128) {
          const oldest = this.questionAncestry.keys().next().value;

          if (oldest !== undefined) this.questionAncestry.delete(oldest);
        }

        this.questionAncestry.set(cacheKey, { fingerprint, inputID });
      } else return;
    }

    if (!inputID) return;

    const parsed = Schema.decodeUnknownResult(nativeQuestionSchema)({
      id: form.id,
      sessionID,
      inputID,
      toolMessageID,
      toolCallID,
      fingerprint,
      title: form.title,
      fields: form.fields,
    });

    return Result.isSuccess(parsed)
      ? parsed.success
      : {
          id: form.id,
          sessionID,
          inputID,
          toolMessageID,
          toolCallID,
          fingerprint,
          unsupported: true,
        };
  }

  /** Resolve the actual delivered input before this particular tool message. */
  private async questionInput(
    sessionID: string,
    assistant: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const boundaries = new InputBoundaryReader(this.client, sessionID, signal);
    let found = false;
    let cursor: string | undefined;
    const seen = new Set<string>();
    const chain: InputBoundaryRecord[] = [];

    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.client.message.list(
        cursor
          ? { sessionID, limit: 100, cursor }
          : { sessionID, limit: 100, order: "desc" },
        { signal },
      );

      for (const message of page.data) {
        if (!found) {
          if (message.id === assistant && message.type === "assistant")
            found = true;
          continue;
        }

        const record = await boundaries.record(message);

        if (chain.length > 0 && closesBoundaryContext(record)) {
          chain.push(record);

          return resolveBoundaryContext(chain);
        }

        if (record.input === undefined) continue;

        if (chain.length === 0 && record.type !== "synthetic")
          return record.input;
        chain.push(record);
      }

      cursor = page.cursor.next ?? undefined;

      if (!cursor) return resolveBoundaryContext(chain);

      if (seen.has(cursor)) throw new Error("Question history cursor repeated");
      seen.add(cursor);
    }

    throw new Error("Question ancestry exceeds history bound");
  }

  public async pendingQuestions(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<PendingQuestion[]> {
    if (this.sessionID !== undefined && sessionID !== this.sessionID) return [];

    const forms = await this.client.session.form
      .list({ sessionID }, { signal })
      .catch((error: unknown) => {
        if (isSessionNotFoundError(error) && error.sessionID === sessionID)
          return [];
        throw error;
      });

    if (forms.length > 16) throw new Error("Too many native forms");
    const questions: PendingQuestion[] = [];

    for (const form of forms) {
      if (form.sessionID !== sessionID) continue;
      const question = await this.nativeQuestion(sessionID, form.id, signal);

      if (question) questions.push(question);
    }

    return questions;
  }

  public async questionState(
    sessionID: string,
    formID: string,
    signal: AbortSignal,
  ): Promise<"pending" | "resolved" | "missing-session" | "unknown"> {
    if (this.sessionID !== undefined && sessionID !== this.sessionID)
      return "unknown";

    try {
      const form = await this.client.session.form.get(
        { sessionID, formID },
        { signal },
      );

      if (form.id !== formID || form.sessionID !== sessionID) return "unknown";

      return form.state.status === "pending" ? "pending" : "resolved";
    } catch (error) {
      if (isFormNotFoundError(error) && error.id === formID) return "resolved";

      if (isSessionNotFoundError(error) && error.sessionID === sessionID)
        return "missing-session";
      throw error;
    }
  }

  public async questionBelongsToInput(
    sessionID: string,
    formID: string,
    inputID: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const question = await this.nativeQuestion(sessionID, formID, signal);

    return (
      question?.inputID === inputID && question.fingerprint === fingerprint
    );
  }

  public async backgroundOutcome(
    sessionID: string,
    formID: string,
    fingerprint: string,
    signal: AbortSignal,
  ) {
    if (sessionID !== this.sessionID) return;

    const form = await this.client.session.form.get(
      { sessionID, formID },
      { signal },
    );

    if (
      form.id !== formID ||
      form.sessionID !== sessionID ||
      questionFingerprint({
        id: form.id,
        sessionID,
        title: form.title,
        metadata: form.metadata,
        fields: form.fields,
      }) !== fingerprint
    )
      return;

    if (form.state.status === "answered" || form.state.status === "cancelled")
      return form.state.status;

    return;
  }

  public async replyQuestion(
    question: NativeQuestion,
    answer: QuestionAnswer | null,
    signal: AbortSignal,
    allowed?: () => boolean,
  ) {
    const live = await this.nativeQuestion(
      question.sessionID,
      question.id,
      signal,
    );

    if (
      !live ||
      "unsupported" in live ||
      live.inputID !== question.inputID ||
      live.fingerprint !== question.fingerprint
    )
      throw new Error("Native question is stale or has no owned input");
    const input = { sessionID: question.sessionID, formID: question.id };

    if (allowed && !allowed()) throw new Error("Question route changed");

    if (answer === null)
      await this.client.session.form.cancel(input, { signal });
    else await this.client.session.form.reply({ ...input, answer }, { signal });
  }

  public async questionInputSettled(
    sessionID: string,
    inputID: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.sessionID !== undefined && sessionID !== this.sessionID)
      return false;
    const session = await this.client.session.get({ sessionID }, { signal });

    if (
      session.id !== sessionID ||
      session.time.idle === undefined ||
      session.time.idle < (session.time.busy ?? 0)
    )
      return false;

    if ((await this.client.session.active({ signal }))[sessionID]) return false;

    if (
      (await this.client.session.inbox.list({ sessionID }, { signal })).some(
        (v) => v.id === inputID,
      )
    )
      return false;

    const input = await this.client.session.message.get(
      { sessionID, messageID: inputID },
      { signal },
    );

    return (
      input.id === inputID && boundaryRecord(input, sessionID).input === inputID
    );
  }
  /** A pending form from earlier work can hold the native queue indefinitely. */
  public async waitingForAnswer(sessionID: string, signal: AbortSignal) {
    const forms = await this.client.session.form.list(
      { sessionID },
      { signal },
    );

    const candidates = forms.filter(
      (form) =>
        form.sessionID === sessionID &&
        Option.isSome(decodeQuestionOrigin(form.metadata)),
    );

    if (candidates.length === 0) return false;
    const active = await this.client.session.active({ signal });

    if (!active[sessionID]) return false;

    for (const form of candidates) {
      signal.throwIfAborted();

      const running = await this.runningQuestion(
        sessionID,
        form.id,
        signal,
      ).catch(() => {});

      signal.throwIfAborted();

      if (running) return true;
    }

    return false;
  }
}
