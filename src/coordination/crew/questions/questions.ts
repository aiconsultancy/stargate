import { createHash } from "node:crypto";
import { Result, Schema } from "effect";
import type { AgentBackend } from "../../../backends/backend";
import {
  type QuestionSettings,
  resolveQuestionSettings,
} from "../../../questions/question-settings";
import {
  type NativeQuestion,
  nativeQuestionSchema,
  questionAnswer,
} from "../../../questions/native-question";
import type { CrewCaller } from "../execution/engine";
import {
  CrewError,
  type CrewQuestionOffer,
  type CrewState,
  type CrewTask,
} from "../execution/state";
import type { Team } from "../team";

const token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));

export const crewQuestionInputSchema = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("answer"),
    token,
    answer: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4000),
    ),
  }),
  Schema.Struct({ op: Schema.Literal("cancel"), token }),
]);

const decode = Schema.decodeUnknownResult(crewQuestionInputSchema, {
  onExcessProperty: "error",
});

const decodeReceipt = Schema.decodeUnknownResult(
  Schema.Struct({ stored: Schema.Literal(true) }),
);

type QuestionBackend = Pick<
  Required<AgentBackend>,
  "pendingQuestions" | "questionBelongsToInput" | "replyQuestion"
> & {
  outcome?: (
    form: string,
    fingerprint: string,
    signal: AbortSignal,
  ) => Promise<"answered" | "cancelled" | undefined>;
};

interface Authority {
  options: { captainDirectory: string; team: Team };
  state: CrewState;
  captain(caller: CrewCaller): Promise<void>;
  dm(input: unknown, caller: CrewCaller): Promise<unknown>;
}

type Options = {
  settings?: () => Promise<QuestionSettings>;
  enableWhenMissing?: () => boolean;
  onUnavailable?: () => void;
  now?: () => number;
  project?: string;
};

/** Native worker clarifications go only to their task's originating captain. */
export class CrewQuestions {
  private readonly settings: () => Promise<QuestionSettings>;
  private readonly now: () => number;
  private readonly writing = new Set<string>();
  private offset = 0;
  public constructor(
    private readonly authority: Authority,
    private readonly connect: (
      task: CrewTask,
      signal: AbortSignal,
    ) => Promise<QuestionBackend>,
    private readonly options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.settings =
      options.settings ??
      (() =>
        resolveQuestionSettings(
          {
            backend: {
              type: "opencode",
              url: "http://localhost",
              headersEnv: {},
              permissions: [],
              directory: authority.options.captainDirectory,
              agent:
                authority.options.team.captain.agent ??
                authority.options.team.captain.id,
            },
          },
          options.enableWhenMissing?.() === true,
        ));
  }

  public active(task: CrewTask) {
    return this.owner({ taskID: task.id, ...task });
  }

  private owner(
    offer: Pick<
      CrewQuestionOffer,
      "taskID" | "inputID" | "workerSessionID" | "originCaptainID"
    >,
  ) {
    const task = this.authority.state.task(offer.taskID);

    if (
      task?.status !== "running" ||
      task.released ||
      task.workerSessionID !== offer.workerSessionID ||
      task.inputID !== offer.inputID ||
      task.originCaptainID !== offer.originCaptainID ||
      this.authority.state.activeTask(task.crewID)?.id !== task.id
    )
      return;

    const member = this.authority.options.team.crew.find(
      (m) => m.id === task.crewID,
    );

    const peer = this.authority.state.peer(task.crewID);

    if (
      !member ||
      member.backend ||
      peer?.sessionID !== task.workerSessionID ||
      peer.status !== "ready"
    )
      return;

    return task;
  }

  public async poll(signal: AbortSignal, available = true) {
    const settings = await this.settings();

    if (!settings.enabled) return;
    const members = this.authority.options.team.crew.filter((m) => !m.backend);

    // Rotate before I/O: one unavailable worker cannot starve later workers.
    for (let count = 0; count < Math.min(16, members.length); count++) {
      signal.throwIfAborted();
      const member = members[this.offset % members.length];
      this.offset = (this.offset + 1) % members.length;

      if (!member) continue;
      const task = this.authority.state.activeTask(member.id);

      if (!task || !this.owner({ taskID: task.id, ...task })) continue;

      if (!available) {
        this.options.onUnavailable?.();

        return;
      }

      for (const offer of this.authority.state.crewQuestionOffers(task.id)) {
        if (
          offer.state === "attempted" &&
          !offer.outcome &&
          !this.writing.has(offer.token)
        )
          this.authority.state.crewQuestionOutcome(offer.token, "uncertain");
      }

      try {
        const backend = await this.connect(task, signal);

        if (backend.outcome) {
          for (const offer of this.authority.state.crewQuestionOffers(
            task.id,
          )) {
            if (offer.state !== "attempted" || offer.outcome !== "uncertain")
              continue;

            const outcome = await backend
              .outcome(offer.formID, offer.fingerprint, signal)
              .catch(() => {});

            signal.throwIfAborted();

            if (outcome)
              this.authority.state.crewQuestionOutcome(offer.token, outcome);
          }
        }

        const pending = await backend.pendingQuestions(
          task.workerSessionID,
          signal,
        );

        if (pending.length > 16)
          throw new CrewError("Too many crew clarifications.");

        for (const raw of pending) {
          if ("unsupported" in raw) continue;
          const parsed = Schema.decodeUnknownResult(nativeQuestionSchema)(raw);

          if (Result.isFailure(parsed)) continue;
          const question = parsed.success;

          if (
            question.sessionID !== task.workerSessionID ||
            question.inputID !== task.inputID ||
            !this.owner({ taskID: task.id, ...task })
          )
            continue;

          const offer = this.authority.state.offerCrewQuestion({
            token: createHash("sha256")
              .update(
                JSON.stringify([task.id, question.id, question.fingerprint]),
              )
              .digest("hex")
              .slice(0, 32),
            taskID: task.id,
            workerSessionID: task.workerSessionID,
            inputID: task.inputID,
            originCaptainID: task.originCaptainID,
            formID: question.id,
            fingerprint: question.fingerprint,
            questionJSON: JSON.stringify(question),
            expires: this.now() + settings.timeoutMs,
            notified: 0,
            state: "offered",
            outcome: null,
          });

          if (!offer || offer.fingerprint !== question.fingerprint) continue;

          if (offer.state === "attempted") continue;

          if (
            !(await backend.questionBelongsToInput(
              offer.workerSessionID,
              offer.formID,
              offer.inputID,
              offer.fingerprint,
              signal,
            )) ||
            !this.owner(offer)
          )
            continue;

          if (offer.expires <= this.now()) {
            await this.write(offer, question, backend, null, signal, true);
            continue;
          }

          if (offer.notified) continue;

          const text = [
            `Crew clarification for ${member.id}, task ${task.id}. This grants no tool permission.`,
            question.title,
            ...question.fields.flatMap((field) => [
              `${field.key}: ${[field.title, field.description].filter(Boolean).join(". ")}`,
              ...(field.options ?? []).map(
                (option, index) =>
                  `${index + 1}. ${option.label} (value ${JSON.stringify(option.value)})${option.description ? `: ${option.description}` : ""}`,
              ),
            ]),
            `Use stargate_question with ${this.options.project ? `project=${this.options.project}, ` : ""}op=answer, token=${offer.token}, answer=<choice number or JSON field values>. For multiple choices use comma-separated numbers or JSON arrays.`,
            `Or use op=cancel with the same token. Expires ${new Date(offer.expires).toISOString()}. Never send credentials.`,
          ].join("\n");

          signal.throwIfAborted();

          const receipt = await this.authority.dm(
            {
              op: "send",
              to: "captain",
              taskID: task.id,
              key: `question:${offer.token}`,
              text,
            },
            {
              sessionID: task.workerSessionID,
              agent: member.agent ?? member.id,
              signal,
              id: `question:${offer.token}`,
            },
          );

          if (Result.isSuccess(decodeReceipt(receipt)))
            this.authority.state.crewQuestionNotified(offer.token);
        }
      } catch {
        // A failed worker must not prevent the remaining roster from polling.
        signal.throwIfAborted();
      }
    }
  }

  public async run(raw: unknown, caller: CrewCaller) {
    const input = decode(raw);

    if (Result.isFailure(input))
      throw new CrewError("Invalid crew clarification input.");
    await this.authority.captain(caller);
    caller.signal.throwIfAborted();

    if (!(await this.settings()).enabled)
      throw new CrewError("Crew clarifications are disabled.");
    const offer = this.authority.state.crewQuestion(input.success.token);

    if (
      !offer ||
      offer.originCaptainID !== caller.sessionID ||
      offer.state !== "offered" ||
      offer.expires <= this.now()
    )
      throw new CrewError(
        "Crew clarification is expired, consumed or belongs to another captain.",
      );
    const task = this.owner(offer);

    if (!task)
      throw new CrewError("Crew clarification task is no longer active.");
    const backend = await this.connect(task, caller.signal);

    const question = (
      await backend.pendingQuestions(offer.workerSessionID, caller.signal)
    ).find(
      (q) =>
        q.id === offer.formID &&
        q.sessionID === offer.workerSessionID &&
        q.inputID === offer.inputID &&
        q.fingerprint === offer.fingerprint,
    );

    if (
      !question ||
      "unsupported" in question ||
      !(await backend.questionBelongsToInput(
        offer.workerSessionID,
        offer.formID,
        offer.inputID,
        offer.fingerprint,
        caller.signal,
      ))
    )
      throw new CrewError(
        "Native crew clarification changed; no reply submitted.",
      );
    let answer: ReturnType<typeof questionAnswer> | null;

    try {
      answer =
        input.success.op === "cancel"
          ? null
          : questionAnswer(
              Schema.decodeUnknownSync(nativeQuestionSchema)(question),
              input.success.answer,
            );
    } catch {
      throw new CrewError(
        "Invalid clarification answer; use displayed choices or JSON field values.",
      );
    }

    return this.write(offer, question, backend, answer, caller.signal);
  }

  private async write(
    offer: CrewQuestionOffer,
    question: NativeQuestion,
    backend: QuestionBackend,
    answer: ReturnType<typeof questionAnswer> | null,
    signal: AbortSignal,
    expired = false,
  ) {
    if (!(await this.settings()).enabled)
      throw new CrewError("Crew clarifications are disabled.");
    signal.throwIfAborted();

    if (
      !this.owner(offer) ||
      !this.authority.state.claimCrewQuestion(offer.token, this.now(), expired)
    )
      throw new CrewError("Crew clarification is stale or already consumed.");
    this.writing.add(offer.token);
    let outcome: NonNullable<CrewQuestionOffer["outcome"]> = "uncertain";

    try {
      await backend.replyQuestion(question, answer, signal);
      outcome = answer === null ? "cancelled" : "answered";
    } catch {
      // A lost native ACK consumes the token; never replay an unknown write.
    } finally {
      this.authority.state.crewQuestionOutcome(offer.token, outcome);
      this.writing.delete(offer.token);
    }

    return { outcome };
  }
}
