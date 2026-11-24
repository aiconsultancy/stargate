import { randomBytes } from "node:crypto";
import { Schema } from "effect";
import {
  type BackgroundCases,
  type OperatorRoute,
} from "./background-questions";
import { operatorControl } from "./question-settings";
import {
  type NativeQuestion,
  type PendingQuestion,
  type QuestionAnswer,
  nativeQuestionSchema,
  questionAnswer,
} from "./native-question";
import {
  type QuestionControl,
  questionFields,
  questionText,
} from "./text-controls";
import type { Incoming, Job } from "../../gateway/store-types";

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
  publicationStarted?: number;
  recovering: number;
  outcome?: "answered" | "cancelled" | "uncertain" | null;
  outcomeNotified?: number;
};

export type QuestionPort = {
  operator?: OperatorRoute;
  account: string;
  settings?(): Promise<{
    enabled: boolean;
    timeoutMs: number;
    answer: "requester" | "allowed";
  }>;
  answerAllowed?(user: string, job: Job): Promise<boolean>;
  publishQuestion?(
    job: Job,
    offer: QuestionOffer,
    question: NativeQuestion,
    allowed: () => boolean,
  ): Promise<void>;
  /** Current authority only; connection readiness must not revoke ownership. */
  authorized?(job: Job): boolean;
  ready?(job: Job): boolean;
  matchesTarget?(target: string): boolean;
  human(user: string): boolean;
  publish(job: Job, text: string, allowed: () => boolean): Promise<void>;
};

/**
 * Narrow store surface the question engine reads. `Store` satisfies it
 * structurally; members mirror `store.ts`. Keeps `questions.ts` free of a
 * store import edge.
 */
type QuestionStore = {
  readonly backgroundCases: BackgroundCases;
  session(conversation: string): string | undefined;
  jobByInput(botKey: string, input: string): Job | null;
  offerQuestion(offer: QuestionOffer): QuestionOffer | undefined;
  failQuestionRecovery(offer: QuestionOffer): void;
  finishQuestionRecovery(offer: QuestionOffer): void;
  readonly questions: {
    ownsQuestionSource(job: Job): boolean;
    recordedQuestionSource(job: Job): boolean;
    questionByToken(botKey: string, token: string): QuestionOffer | undefined;
    questionOffers(
      botKey: string,
      includeRunningOutcomes?: boolean,
    ): QuestionOffer[];
    activeQuestionSessions(botKey: string, pinned?: string): string[];
    renewQuestion(
      token: string,
      replacement: string,
      now: number,
    ): QuestionOffer | undefined;
    attemptQuestion(token: string, now: number): boolean;
    claimExpiredQuestion(token: string, now: number): boolean;
    claimQuestionStop(offer: QuestionOffer): boolean;
    questionOutcome(
      token: string,
      outcome: NonNullable<QuestionOffer["outcome"]>,
    ): void;
    questionOutcomeNotified(token: string): void;
    retireQuestion(token: string): void;
    closeQuestion(token: string): void;
    questionNotified(token: string): void;
    questionRecovering(token: string): void;
    questionSourceCancelled(offer: QuestionOffer): boolean;
    startQuestionPublication(
      botKey: string,
      token: string,
      timeoutMs?: number,
    ): QuestionOffer | undefined;
  };
};

/**
 * Narrow backend surface the question engine reads. `AgentBackend`
 * satisfies it structurally; members mirror `backend.ts`. Keeps
 * `questions.ts` free of a backend import edge.
 */
type QuestionBackend = {
  readonly sessionID?: string | undefined;
  pinnedBackgroundQuestions?(signal: AbortSignal): Promise<NativeQuestion[]>;
  pendingQuestions?(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<PendingQuestion[]>;
  questionState?(
    sessionID: string,
    formID: string,
    signal: AbortSignal,
  ): Promise<"pending" | "resolved" | "missing-session" | "unknown">;
  questionBelongsToInput?(
    sessionID: string,
    formID: string,
    inputID: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  backgroundOutcome?(
    session: string,
    form: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<"answered" | "cancelled" | undefined>;
  replyQuestion?(
    question: NativeQuestion,
    answer: QuestionAnswer | null,
    signal: AbortSignal,
    allowed?: () => boolean,
  ): Promise<void>;
  questionInputSettled?(
    sessionID: string,
    inputID: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  interruptInput?(
    sessionId: string,
    inputId: string,
    signal: AbortSignal,
  ): Promise<void>;
};

/** Gateway-owned durable forms. Neither the model nor the dashboard can answer. */
export class Questions {
  private offset = 0;
  private readonly inFlight = new Set<string>();
  private readonly notifying = new Set<string>();
  private readonly offering = new Set<string>();
  private readonly noticeFailures = new Map<
    string,
    { count: number; until: number }
  >();
  private readonly failures = new Map<
    string,
    { count: number; until: number }
  >();
  private readonly missing = new Map<string, number>();
  public constructor(
    private readonly key: string,
    private readonly store: QuestionStore,
    private readonly backend: QuestionBackend,
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
      !this.store.questions.ownsQuestionSource(job) ||
      !this.port()?.human(job.user) ||
      !(this.port()?.authorized?.(job) ?? this.allowed(job)) ||
      (this.backend.sessionID ?? this.store.session(job.conversation)) !==
        offer.sessionID
    ) {
      return;
    }

    return job;
  }

  /** Preserve established native waiters only; this grants no reply authority. */
  private establishedWaiter(offer: QuestionOffer): Job | undefined {
    if (!offer.recovering && offer.state !== "attempted" && !offer.outcome) {
      return;
    }

    const job = this.store.jobByInput(this.key, offer.inputID);

    if (
      !job ||
      job.id !== offer.jobID ||
      job.status !== "running" ||
      job.deferDelivery ||
      job.sender ||
      job.fleet ||
      !this.store.questions.recordedQuestionSource(job) ||
      (this.backend.sessionID ?? this.store.session(job.conversation)) !==
        offer.sessionID
    ) {
      return;
    }

    return job;
  }

  /** New holds need pending forms; established holds preserve their exact input. */
  public async recover(signal: AbortSignal): Promise<string[]> {
    const retained: string[] = [];

    for (const offer of this.store.questions.questionOffers(this.key, true)) {
      // A form may disappear while its original input still runs. Preserve an
      // Established hold through that unknown interval without restoring any
      // Permission to answer or notify the original requester.
      if (this.establishedWaiter(offer)) {
        this.store.questions.questionRecovering(offer.token);
        retained.push(offer.inputID);
        continue;
      }

      const job = this.owner(offer);

      if (job?.status !== "running" || offer.state === "closed") {
        continue;
      }

      if (
        await this.backend.questionBelongsToInput?.(
          offer.sessionID,
          offer.formID,
          offer.inputID,
          offer.fingerprint,
          signal,
        )
      ) {
        this.store.questions.questionRecovering(offer.token);
        retained.push(offer.inputID);
      }
    }

    return retained;
  }

  /** Called only for a newly received, authenticated Stop, never by recovery. */
  public async stop(jobID: number, signal: AbortSignal): Promise<boolean> {
    const offer = this.store.questions
      .questionOffers(this.key)
      .find((o) => o.jobID === jobID && o.recovering !== 0);

    if (!offer || !this.backend.interruptInput) {
      return false;
    }

    const job = this.establishedWaiter(offer);
    const port = this.port();

    if (
      !job ||
      !this.store.questions.questionSourceCancelled(offer) ||
      !port?.human(job.user) ||
      !(port.authorized?.(job) ?? this.allowed(job))
    ) {
      return false;
    }

    signal.throwIfAborted();

    if (!this.store.questions.claimQuestionStop(offer)) {
      return false;
    }

    // The adapter revalidates exact input ownership. Never fall back to a
    // Whole-session interruption, and never replay an uncertain Stop on boot.
    await this.backend.interruptInput(offer.sessionID, offer.inputID, signal);

    return true;
  }

  public reconcileBackground() {
    this.nextBackgroundPoll = 0;
  }
  private nextBackgroundPoll = 0;

  private async checkBackground(signal: AbortSignal) {
    const route = this.port()?.operator;

    if (
      !route ||
      !this.backend.pinnedBackgroundQuestions ||
      Date.now() < this.nextBackgroundPoll
    ) {
      return;
    }

    this.nextBackgroundPoll = Date.now() + 10_000;
    const pending = await this.backend.pinnedBackgroundQuestions(signal);

    for (const row of this.store.backgroundCases.unsettled(this.key)) {
      this.store.backgroundCases.checked(row.reference);

      if (
        pending.some((q) => q.id === row.form && q.sessionID === row.session)
      ) {
        continue;
      }

      const outcome = await this.backend
        .backgroundOutcome?.(row.session, row.form, row.fingerprint, signal)
        .catch(() => {});

      if (outcome) {
        this.store.backgroundCases.close(row.reference, outcome);
      }
    }

    for (const q of pending) {
      if (this.store.jobByInput(this.key, q.inputID)) {
        continue;
      }

      const found = this.store.backgroundCases.remember(
        this.key,
        route.account,
        q,
      );

      if (
        !found ||
        found.owner !== route.account ||
        found.fingerprint !== q.fingerprint ||
        found.state !== "new" ||
        !route.ready()
      ) {
        continue;
      }

      const allowed = () =>
        !signal.aborted && this.port()?.operator === route && route.ready();

      await route.send(
        `An earlier task has a question. Send show ${found.reference} here to answer it.`,
        allowed,
      );

      if (allowed()) {
        this.store.backgroundCases.alerted(found.reference);
      }
    }
  }

  public async operatorAnswer(
    actor: string,
    text: string,
    signal: AbortSignal,
    connected = () => true,
  ) {
    const control = operatorControl(text);
    const route = this.port()?.operator;

    if (!control || !route || actor !== route.account || !route.ready()) {
      return;
    }

    const key = control[2]?.toLowerCase() ?? "";

    if (this.inFlight.has(key)) {
      return;
    }

    this.inFlight.add(key);

    try {
      await this.operatorControl(actor, control, route, signal, connected);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async operatorControl(
    actor: string,
    control: RegExpExecArray,
    route: OperatorRoute,
    signal: AbortSignal,
    connected: () => boolean,
  ) {
    const answering = control[1]?.toLowerCase() === "answer";
    const value = control[2] ?? "";
    const found = this.store.backgroundCases.find(this.key, value, answering);

    if (
      !found ||
      found.owner !== actor ||
      found.session !== this.backend.sessionID
    ) {
      if (connected() && !this.lifetime.aborted) {
        await route.send(
          "No current question matches that reference.",
          () =>
            connected() &&
            !this.lifetime.aborted &&
            this.port()?.operator === route &&
            route.ready(),
        );
      }

      return;
    }

    const allowed = () =>
      connected() &&
      !this.lifetime.aborted &&
      this.port()?.operator === route &&
      route.ready() &&
      !this.store.jobByInput(this.key, found.input);

    const q = (await this.backend.pinnedBackgroundQuestions?.(signal))?.find(
      (v) =>
        v.id === found.form &&
        v.sessionID === found.session &&
        v.inputID === found.input &&
        v.fingerprint === found.fingerprint,
    );

    if (!allowed()) {
      return;
    }

    if (
      !q ||
      found.state === "attempted" ||
      found.state === "answered" ||
      found.state === "cancelled"
    ) {
      await route.send(
        "This question is no longer available for an IRC answer.",
        allowed,
      );

      return;
    }

    if (!answering) {
      const token = this.store.backgroundCases.show(found.reference);

      if (token) {
        const lines = questionFields(q);

        if (q.fields.some((field) => field.type === "multiselect")) {
          lines.push("Use comma-separated numbers for multiple choices.");
        }

        lines.push(
          `Send answer ${token} <choice or answer> here within 30 minutes.`,
        );
        const text = lines.join("\n");
        await route.send(
          Buffer.byteLength(text) <= 16_000
            ? text
            : "This question is too large for IRC. Open it in OpenCode.",
          allowed,
        );
      }

      return;
    }

    let answer: QuestionAnswer;

    try {
      answer = questionAnswer(q, control[3] ?? "");
    } catch {
      await route.send(
        "Use a displayed choice or a supported field value.",
        allowed,
      );

      return;
    }

    if (!this.backend.replyQuestion || !allowed()) {
      return;
    }

    if (found.expires <= Date.now()) {
      await route.send(
        `Use show ${found.reference} to get a fresh answer token.`,
        allowed,
      );

      return;
    }

    let claimed = false;

    try {
      await this.backend.replyQuestion(q, answer, signal, () => {
        claimed =
          !signal.aborted &&
          allowed() &&
          this.store.backgroundCases.attempt(value);

        return claimed;
      });
    } catch {
      if (!claimed) {
        if (allowed()) {
          await route.send(
            "The answer was not submitted. Show the current question before answering.",
            allowed,
          );
        }

        return;
      }

      const outcome = await this.backend
        .backgroundOutcome?.(
          found.session,
          found.form,
          found.fingerprint,
          AbortSignal.any([this.lifetime, AbortSignal.timeout(3000)]),
        )
        .catch(() => {});

      if (outcome) {
        this.store.backgroundCases.close(found.reference, outcome);
        await route.send(
          `OpenCode reports the question was ${outcome}.`,
          allowed,
        );

        return;
      }

      await route.send(
        "Answer delivery is unconfirmed. Check OpenCode before taking further action.",
        allowed,
      );

      return;
    }

    this.store.backgroundCases.close(found.reference, "answered");
    await route.send("OpenCode accepted your answer.", allowed);
  }

  public async poll(signal: AbortSignal) {
    await Promise.all([
      this.checkBackground(signal).catch(() => {
        signal.throwIfAborted();
      }),
      this.pollOwned(signal),
    ]);
  }

  private async pollOwned(signal: AbortSignal) {
    const offers = this.store.questions.questionOffers(this.key);
    const tokens = new Set(offers.map((o) => o.token));

    for (const token of this.noticeFailures.keys()) {
      if (!tokens.has(token)) {
        this.noticeFailures.delete(token);
      }
    }

    const sessions = [
      ...new Set([
        ...this.store.questions.activeQuestionSessions(
          this.key,
          this.backend.sessionID,
        ),
        ...offers.map((o) => o.sessionID),
      ]),
    ].toSorted();

    for (const session of this.failures.keys()) {
      if (!sessions.includes(session)) {
        this.failures.delete(session);
      }
    }

    for (const session of this.missing.keys()) {
      if (!sessions.includes(session)) {
        this.missing.delete(session);
      }
    }

    if (sessions.length === 0) {
      return;
    }

    const selected = Array.from(
      { length: Math.min(16, sessions.length) },
      (_, i) => sessions[(this.offset + i) % sessions.length],
    ).filter((s): s is string => s !== undefined);

    let failed = false;

    for (const session of selected) {
      // Advance before awaiting: even a session exhausting the whole poll's
      // Deadline cannot monopolise the first position after every timeout.
      this.offset = (sessions.indexOf(session) + 1) % sessions.length;

      if (
        (this.missing.get(session) ?? 0) > Date.now() ||
        (this.failures.get(session)?.until ?? 0) > Date.now()
      ) {
        continue;
      }

      try {
        await this.pollSession(session, signal);
        this.failures.delete(session);
      } catch {
        signal.throwIfAborted();
        const count = Math.min(6, (this.failures.get(session)?.count ?? 0) + 1);
        this.failures.set(session, {
          count,
          until: Date.now() + Math.min(60_000, 1000 * 2 ** count),
        });
        failed = true;
      }
    }

    for (const session of this.failures.keys()) {
      if (!sessions.includes(session)) {
        this.failures.delete(session);
      }
    }

    for (const session of this.missing.keys()) {
      if (!sessions.includes(session)) {
        this.missing.delete(session);
      }
    }

    if (failed) {
      throw new Error("Native clarification session unavailable");
    }
  }

  private async pollSession(session: string, signal: AbortSignal) {
    let missingSession = false;

    for (const offer of this.store.questions
      .questionOffers(this.key)
      .filter((o) => o.sessionID === session)) {
      if (this.store.questions.questionSourceCancelled(offer)) {
        if (!this.inFlight.has(offer.token)) {
          if (offer.state === "attempted" && !offer.outcome) {
            this.store.questions.questionOutcome(offer.token, "uncertain");
          }

          this.store.questions.questionOutcomeNotified(offer.token);
          this.store.questions.retireQuestion(offer.token);
        }

        continue;
      }

      if (
        offer.state === "attempted" &&
        !offer.outcome &&
        !this.inFlight.has(offer.token)
      ) {
        this.store.questions.questionOutcome(offer.token, "uncertain");
      }

      await this.notifyOutcome(
        this.store.questions.questionByToken(this.key, offer.token) ?? offer,
      );
    }

    if (
      !this.store.questions
        .activeQuestionSessions(this.key, this.backend.sessionID)
        .includes(session) &&
      !this.store.questions
        .questionOffers(this.key)
        .some(
          (o) =>
            o.sessionID === session &&
            (o.state !== "closed" || o.recovering !== 0),
        )
    ) {
      return;
    }

    const settings = await this.port()?.settings?.();

    // Disabling controls revokes publication and writes, not settlement reads.
    // Recovered inputs have no live prompt worker to release their queue hold.
    const pending =
      settings && !settings.enabled
        ? []
        : ((await this.backend.pendingQuestions?.(session, signal)) ?? []);

    if (pending.length > 16) {
      throw new Error("Too many native clarification questions");
    }

    for (const raw of pending) {
      const question =
        "unsupported" in raw
          ? raw
          : Schema.decodeUnknownSync(nativeQuestionSchema)(raw);

      if (question.sessionID !== session) {
        continue;
      }

      const job = this.store.jobByInput(this.key, question.inputID);

      if (
        job?.status !== "running" ||
        !this.owner({
          jobID: job.id,
          inputID: question.inputID,
          sessionID: session,
        })
      ) {
        continue;
      }

      const offer = this.store.offerQuestion({
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

      if (
        settings &&
        offer?.state === "offered" &&
        offer.publicationStarted &&
        offer.expires <= Date.now() &&
        !("unsupported" in question)
      ) {
        await this.expire(job, offer, question, signal);
        continue;
      }

      if (
        offer?.state !== "offered" ||
        offer.notified ||
        ((offer.publicationStarted ?? 0) !== 0 && offer.expires <= Date.now())
      ) {
        continue;
      }

      if (
        !(await this.backend.questionBelongsToInput?.(
          session,
          question.id,
          question.inputID,
          question.fingerprint,
          signal,
        ))
      ) {
        continue;
      }

      await this.publishOffer(job, offer, question, signal);
    }

    for (const offer of this.store.questions
      .questionOffers(this.key)
      .filter((o) => o.sessionID === session)) {
      if (pending.some((q) => q.id === offer.formID)) {
        continue;
      }

      // A filtered list is not proof of absence. Only the native form API can
      // Authoritatively report settlement; transient/unsupported forms stay live.
      const state = await this.backend.questionState?.(
        session,
        offer.formID,
        signal,
      );

      if (state !== "resolved" && state !== "missing-session") {
        continue;
      }

      // The form may settle before its reply request returns. Keep the durable
      // Attempt writable until that request records its success/uncertainty.
      // Check after the awaited state read: an answer may start during it.
      if (this.inFlight.has(offer.token)) {
        continue;
      }

      this.store.questions.closeQuestion(offer.token);

      if (state === "missing-session") {
        missingSession = true;

        if (offer.recovering) {
          this.store.failQuestionRecovery(offer);
        }

        continue;
      }

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

    // Commit terminal session caching only after the entire pass succeeds and
    // Every offer/outcome is handled. An in-flight reply or later read failure
    // Must still get another pass, even after an earlier missing-session result.
    if (
      missingSession &&
      pending.length === 0 &&
      !this.store.questions
        .questionOffers(this.key)
        .some((o) => o.sessionID === session)
    ) {
      this.missing.set(session, Date.now() + 60_000);
    }
  }

  private async publishOffer(
    job: Job,
    offer: QuestionOffer,
    question: PendingQuestion,
    signal: AbortSignal,
    prefix = "",
  ) {
    const port = this.port();
    let current = this.store.questions.questionByToken(this.key, offer.token);

    if (
      !port ||
      this.offering.has(offer.token) ||
      current?.state !== "offered" ||
      current.notified ||
      ((current.publicationStarted ?? 0) !== 0 &&
        current.expires <= Date.now()) ||
      port.ready?.(job) === false
    ) {
      return;
    }

    this.offering.add(offer.token);

    try {
      // Start the reply window only when a first publication can be attempted.
      // Persist before sending: an ACK loss must not silently renew a seen token.
      const settings = await port.settings?.();

      if (settings && !settings.enabled) {
        return;
      }

      current = this.store.questions.startQuestionPublication(
        this.key,
        offer.token,
        settings?.timeoutMs,
      );

      if (!current) {
        return;
      }

      if (port.publishQuestion && !("unsupported" in question)) {
        await port.publishQuestion(
          job,
          current,
          question,
          () => !signal.aborted && !!this.owner(offer),
        );
      } else {
        await port.publish(
          job,
          "unsupported" in question
            ? "OpenCode needs clarification, but this form cannot be safely shown or answered on this transport. The original requester must use the native operator interface. No answer or cancellation has been submitted."
            : prefix + questionText(question, port.account, offer.token),
          () => !signal.aborted && !!this.owner(offer),
        );
      }

      this.store.questions.questionNotified(offer.token);
    } finally {
      this.offering.delete(offer.token);
    }
  }

  private async expire(
    job: Job,
    offer: QuestionOffer,
    question: NativeQuestion,
    signal: AbortSignal,
  ) {
    if (
      !(await this.backend.questionBelongsToInput?.(
        offer.sessionID,
        offer.formID,
        offer.inputID,
        offer.fingerprint,
        signal,
      ))
    ) {
      return;
    }

    const settings = await this.port()?.settings?.();
    signal.throwIfAborted();

    if (
      (settings && !settings.enabled) ||
      !this.owner(offer) ||
      !this.store.questions.claimExpiredQuestion(offer.token, Date.now())
    ) {
      return;
    }

    this.inFlight.add(offer.token);

    try {
      await this.backend.replyQuestion?.(question, null, signal);
      this.store.questions.questionOutcome(offer.token, "cancelled");
    } catch {
      this.store.questions.questionOutcome(offer.token, "uncertain");
    } finally {
      this.inFlight.delete(offer.token);
    }

    await this.port()?.publish(
      job,
      "Clarification timed out; cancellation submitted to OpenCode. Check the native form if its outcome is uncertain.",
      () => !signal.aborted && !!this.owner(offer),
    );
    await this.notifyOutcome(
      this.store.questions.questionByToken(this.key, offer.token) ?? offer,
    );
  }

  private async notifyOutcome(offer: QuestionOffer) {
    if (
      !offer.outcome ||
      offer.outcomeNotified ||
      this.lifetime.aborted ||
      this.notifying.has(offer.token)
    ) {
      return;
    }

    const job = this.owner(offer);
    const port = this.port();

    if (!job || !port) {
      // Policy loss is a delivery denial, not permission to retain an unusable
      // Notice in every poll. Preserve the outcome and any native recovery hold.
      this.store.questions.questionOutcomeNotified(offer.token);
      this.noticeFailures.delete(offer.token);

      if (!this.inFlight.has(offer.token)) {
        this.store.questions.retireQuestion(offer.token);
      }

      return;
    }

    if (
      port.ready?.(job) === false ||
      (this.noticeFailures.get(offer.token)?.until ?? 0) > Date.now()
    ) {
      return;
    }

    this.notifying.add(offer.token);

    try {
      await port.publish(
        job,
        offer.outcome === "uncertain"
          ? "Clarification reply outcome is uncertain. This token is consumed; an operator must check OpenCode before another answer is attempted."
          : "Clarification decision recorded. This grants no tool permission.",
        () => !this.lifetime.aborted && !!this.owner(offer),
      );
      this.store.questions.questionOutcomeNotified(offer.token);
      this.noticeFailures.delete(offer.token);
    } catch {
      // A lost ACK may repeat a notice, but never flood each poll or replay the
      // Native answer. Retry delivery with the same bounded session backoff.
      const count = Math.min(
        6,
        (this.noticeFailures.get(offer.token)?.count ?? 0) + 1,
      );

      this.noticeFailures.set(offer.token, {
        count,
        until: Date.now() + Math.min(60_000, 1000 * 2 ** count),
      });
    } finally {
      this.notifying.delete(offer.token);
    }
  }

  public async answer(
    input: Incoming,
    control: QuestionControl,
    signal: AbortSignal,
  ) {
    const settings = await this.port()?.settings?.();

    if (settings && !settings.enabled) {
      return;
    }

    const offer = this.store.questions.questionByToken(this.key, control.token);

    if (
      control.invalid ||
      offer?.state !== "offered" ||
      (!control.renew && offer.expires <= Date.now())
    ) {
      return;
    }

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
      (input.user !== job.user &&
        !(
          (await this.port()?.settings?.())?.answer === "allowed" &&
          (await this.port()?.answerAllowed?.(input.user, job))
        )) ||
      input.channel !== job.channel ||
      (input.replyParent ?? input.thread) !== (job.replyParent ?? job.thread) ||
      !this.port()?.human(input.user)
    ) {
      return;
    }

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
    ) {
      return;
    }

    if (control.renew) {
      if (offer.expires > Date.now()) {
        return;
      }

      const port = this.port();

      if (!port || !this.owner(offer)) {
        return;
      }

      signal.throwIfAborted();

      const fresh = this.store.questions.renewQuestion(
        offer.token,
        randomBytes(16).toString("hex"),
        Date.now(),
      );

      if (!fresh) {
        return;
      }

      await this.publishOffer(
        job,
        fresh,
        question,
        signal,
        "Previous clarification token expired; use this new token.\n",
      );

      return;
    }

    let answer: QuestionAnswer | null;

    try {
      answer =
        control.answer === null
          ? null
          : questionAnswer(
              Schema.decodeUnknownSync(nativeQuestionSchema)(question),
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

    const currentSettings = await this.port()?.settings?.();

    const actorAllowed =
      input.user === job.user ||
      (currentSettings?.answer === "allowed" &&
        (await this.port()?.answerAllowed?.(input.user, job)));

    signal.throwIfAborted();

    if (
      (currentSettings && !currentSettings.enabled) ||
      !actorAllowed ||
      !this.owner(offer) ||
      !this.store.questions.attemptQuestion(offer.token, Date.now())
    ) {
      return;
    }

    this.inFlight.add(offer.token);

    try {
      if (!this.backend.replyQuestion) {
        throw new Error("Question reply unavailable");
      }

      await this.backend.replyQuestion(question, answer, signal);
      this.store.questions.questionOutcome(
        offer.token,
        answer === null ? "cancelled" : "answered",
      );
    } catch {
      this.store.questions.questionOutcome(offer.token, "uncertain");
    } finally {
      this.inFlight.delete(offer.token);
    }

    await this.notifyOutcome(
      this.store.questions.questionByToken(this.key, offer.token) ?? offer,
    );
  }
}
