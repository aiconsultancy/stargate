import { fold } from "../../../transports/irc/protocol";
import type { TrackedIssue } from "./ledger";
import {
  type AgentDispatcherOptions,
  type DispatchEvent,
  DispatchPolling,
  UndeliverableIssue,
} from "./polling";
import {
  type DispatchAnswer,
  type RefusedReason,
  type WithdrawReason,
  dispatchText,
  newOfferID,
} from "./protocol";

export {
  type AgentDispatcherOptions,
  type CaptainRef,
  type DispatchEvent,
  type DispatchMessenger,
  type DispatchSettings,
  UndeliverableIssue,
} from "./polling";

export type DispatchAnswerInput = {
  /** Server-authenticated account of the sender. */
  account: string;
  offerID: string;
  answer: DispatchAnswer;
  /** The message ID the answer replies to. */
  replyTo: string | undefined;
  /** Server time of the answer, else the receive time (ms). */
  at: number;
};

/** Resolves after `ms`, or as soon as `signal` aborts; never rejects. */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const maxEditAttempts = 3;

/**
 * Deterministic agent dispatch on the rear admiral's gateway. Every poll,
 * timer and answer runs in one serial queue, against a durable ledger. No
 * model decides whether to act.
 */
export class AgentDispatcher {
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly polling: DispatchPolling;
  /** Issue → earliest retry after a failed step, so a failing API is not hammered. */
  private readonly retryAt = new Map<string, number>();
  private kick: (() => void) | undefined;
  private runSignal: AbortSignal | undefined;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;

  public constructor(private readonly options: AgentDispatcherOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? pause;
    this.polling = new DispatchPolling({
      options,
      now: this.now.bind(this),
      finish: this.finish.bind(this),
    });
  }

  private get settings() {
    return this.options.settings;
  }

  private same(a: string, b: string) {
    return this.settings.sameAccount
      ? this.settings.sameAccount(a, b)
      : fold(a) === fold(b);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});

    return next;
  }

  /** Behaviour 2 is unavailable when the API does not return the flag. */
  public get readyForAgentsAvailable() {
    return this.polling.readyForAgentsAvailable;
  }

  /** One poll followed by due timers; tests drive this with a fake clock. */
  public step(signal: AbortSignal) {
    return this.serial(async () => {
      await this.polling.poll(signal);
      await this.timers(signal);
    });
  }

  /** Due timers only: deadlines, next rounds and pending writes. */
  public tick(signal: AbortSignal) {
    return this.serial(() => this.timers(signal));
  }

  /** A captain's answer from the transport; untrusted until checked here. */
  public answer(input: DispatchAnswerInput, signal?: AbortSignal) {
    const stop = signal ?? this.runSignal ?? new AbortController().signal;

    return this.serial(() => this.handleAnswer(input, stop)).finally(() =>
      this.kick?.(),
    );
  }

  /** When a tracked issue's next step is due, after any failure back-off. */
  private dueAt(tracked: TrackedIssue): number | undefined {
    const offer = tracked.offer;

    // The last branch is a pending write: every timer run retries it, so
    // Never spin for it.
    let at: number | undefined;

    switch (tracked.state) {
      case "asking":
        at =
          offer && tracked.closedOffer === offer.id
            ? this.now()
            : offer?.deadline;
        break;
      case "waiting":
        at = tracked.nextRoundAt ?? this.now();
        break;
      case "done":
        at = undefined;
        break;
      default:
        at = this.now() + this.settings.pollIntervalMs;
    }

    const retry = this.retryAt.get(tracked.issue);

    return at === undefined || retry === undefined ? at : Math.max(at, retry);
  }

  /** Earliest time any timer is due, if any. */
  private nextDue(): number | undefined {
    if (this.settings.issueDispatch === false) {
      return;
    }

    let due: number | undefined;

    for (const tracked of this.options.ledger.active()) {
      const at = this.dueAt(tracked);

      if (at !== undefined && (due === undefined || at < due)) {
        due = at;
      }
    }

    return due;
  }

  /**
   * Polls every `pollIntervalMs` and runs timers as they fall due, until the
   * signal aborts. A failed poll or step is logged once and tried again at
   * the next interval, never sooner: errors are never thrown from here.
   */
  public async run(signal: AbortSignal) {
    this.runSignal = signal;
    let nextPoll = this.now();

    while (!signal.aborted) {
      let due = nextPoll;

      try {
        if (this.now() >= nextPoll) {
          // Scheduled before the poll: a failure waits a whole interval.
          nextPoll = this.now() + this.settings.pollIntervalMs;
          await this.serial(() => this.polling.poll(signal));
        }

        await this.serial(() => this.timers(signal));
        due = Math.min(nextPoll, this.nextDue() ?? nextPoll);
        this.polling.cleared("cycle");
      } catch {
        if (signal.aborted) {
          return;
        }

        due = nextPoll;
        this.polling.warnOnce(
          "cycle",
          "Agent dispatch cycle failed; retrying later",
        );
      }

      if (signal.aborted) {
        return;
      }

      const wait = Math.min(
        Math.max(1000, due - this.now()),
        this.settings.pollIntervalMs,
      );

      // An answer wakes the loop early so its follow-up timer is not late.
      const wake = new AbortController();
      this.kick = () => {
        wake.abort();
      };

      try {
        await this.wait(wait, AbortSignal.any([signal, wake.signal]));
      } catch {
        // A pause never fails the dispatcher; the loop re-checks the signal.
      } finally {
        this.kick = undefined;
      }
    }
  }

  /** Stop tracking; say so in chat when an offer was open. */
  private async finish(
    tracked: TrackedIssue,
    reason: WithdrawReason,
    version: number | undefined,
    signal: AbortSignal,
  ) {
    const open = tracked.state === "asking" ? tracked.offer : undefined;
    this.options.ledger.save({
      ...tracked,
      state: "done",
      offer: undefined,
      outcome: `withdrawn:${reason}`,
      ...(version !== undefined && { doneVersion: version }),
      updatedAt: this.now(),
    });

    if (open) {
      await this.announce(
        {
          kind: "withdrawn",
          offerID: open.id,
          issue: tracked.identifier,
          text: dispatchText.withdrawn(open.id, tracked, reason),
          replyTo: open.messageID,
        },
        signal,
      );
    }
  }

  private async announce(event: DispatchEvent, signal: AbortSignal) {
    try {
      await this.options.messenger.announce(event, signal);
    } catch {
      signal.throwIfAborted();
      this.options.log.warn(
        { kind: event.kind },
        "Agent dispatch status line was not delivered",
      );
    }
  }

  private async timers(signal: AbortSignal) {
    // Nothing moves until this process has read the roster: at a poll, or
    // Before an acceptance write as a confirmed identity.
    if (this.settings.issueDispatch === false || !this.polling.roster) {
      return;
    }

    for (const tracked of this.options.ledger.active()) {
      signal.throwIfAborted();
      const retry = this.retryAt.get(tracked.issue);

      if (retry !== undefined && this.now() < retry) {
        continue;
      }

      try {
        await this.due(tracked, signal);
        this.retryAt.delete(tracked.issue);
        this.polling.cleared(`timer:${tracked.issue}`);
      } catch (error) {
        signal.throwIfAborted();
        // The ledger still holds the last completed step; try again later.
        this.retryAt.set(
          tracked.issue,
          this.now() + this.settings.pollIntervalMs,
        );
        this.polling.apiFailed(
          `timer:${tracked.issue}`,
          "Agent dispatch step failed; retrying at the next poll",
          error,
          { issue: tracked.identifier },
        );
      }
    }
  }

  private async due(tracked: TrackedIssue, signal: AbortSignal) {
    const now = this.now();

    if (tracked.state === "asking") {
      const offer = tracked.offer;

      if (!offer) {
        return;
      }

      // Declined, timed out or never delivered: move on without waiting.
      if (tracked.closedOffer === offer.id) {
        await this.askNext(
          tracked,
          tracked.resume ?? tracked.position + 1,
          signal,
        );

        return;
      }

      if (now < offer.deadline) {
        return;
      }

      const closed: TrackedIssue = { ...tracked, closedOffer: offer.id };
      this.options.ledger.save(closed);
      await this.announce(
        {
          kind: "timeout",
          offerID: offer.id,
          issue: tracked.identifier,
          text: dispatchText.timeout(
            offer.account,
            offer.id,
            tracked,
            this.settings.answerTimeoutMs / 1000,
          ),
          replyTo: offer.messageID,
        },
        signal,
      );
      await this.askNext(closed, closed.position + 1, signal);
    } else if (tracked.state === "waiting") {
      if (tracked.nextRoundAt !== undefined && now < tracked.nextRoundAt) {
        return;
      }

      await this.startRound(tracked, signal);
    } else if (tracked.state === "accepting") {
      await this.assignAccepted(tracked, signal);
    } else if (tracked.state === "clearing") {
      await this.giveUp(tracked, signal);
    }
  }

  /**
   * Re-read the issue and current fleet membership before any new offer;
   * stop when it no longer qualifies. A failed read throws: the offer waits.
   * The issue as read when it still qualifies; undefined once finished.
   */
  private async stillReady(tracked: TrackedIssue, signal: AbortSignal) {
    const current = await this.options.api.issue(tracked.issue, signal);
    const reason = await this.polling.unqualified(current, signal);

    if (reason || !current) {
      await this.finish(tracked, reason ?? "missing", current?.version, signal);

      return;
    }

    return current;
  }

  private async startRound(tracked: TrackedIssue, signal: AbortSignal) {
    const roster = this.polling.roster;

    if (!roster) {
      return;
    }

    const current = await this.stillReady(tracked, signal);

    if (!current) {
      return;
    }

    const ids = [...roster.captains.keys()].toSorted();
    const shift = ids.length > 0 ? tracked.start % ids.length : 0;
    const order = [...ids.slice(shift), ...ids.slice(0, shift)];

    const next: TrackedIssue = {
      ...tracked,
      round: tracked.round + 1,
      order,
      position: 0,
      offer: undefined,
      nextRoundAt: undefined,
      updatedAt: this.now(),
    };

    this.options.ledger.save(next);
    await this.askNext(next, 0, signal, current.version);
  }

  /**
   * Ask the next available captain from `position`, or end the round.
   * `checked` is the issue's version when the caller has just re-read it.
   */
  private async askNext(
    tracked: TrackedIssue,
    position: number,
    signal: AbortSignal,
    checked?: number,
  ) {
    const roster = this.polling.roster;

    if (!roster) {
      return;
    }

    let version = checked;

    if (version === undefined && position < tracked.order.length) {
      const current = await this.stillReady(tracked, signal);

      if (!current) {
        return;
      }

      version = current.version;
    }

    for (let index = position; index < tracked.order.length; index++) {
      const captain = roster.captains.get(tracked.order[index] ?? "");

      if (!captain?.available || !captain.reachable) {
        continue;
      }

      const now = this.now();

      const asking: TrackedIssue = {
        ...tracked,
        state: "asking",
        position: index,
        resume: undefined,
        offer: {
          id: newOfferID(),
          captain: captain.userId,
          account: captain.account,
          askedAt: now,
          deadline: now + this.settings.answerTimeoutMs,
        },
        updatedAt: now,
      };

      const offer = asking.offer;

      if (!offer) {
        continue;
      }

      // Recorded before it is sent: a restart keeps waiting for this offer.
      this.options.ledger.save(asking);
      let sent: { messageID: string | undefined } | undefined;

      try {
        sent = await this.options.messenger.offer(
          captain,
          {
            id: offer.id,
            issue: tracked,
            timeoutSeconds: this.settings.answerTimeoutMs / 1000,
          },
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();

        // No captain could ever be sent this issue: stop tracking it until
        // Someone changes it, without holding the poll or other issues.
        if (error instanceof UndeliverableIssue) {
          this.options.ledger.save({
            ...tracked,
            state: "done",
            offer: undefined,
            resume: undefined,
            outcome: "undeliverable",
            ...(version !== undefined && { doneVersion: version }),
            updatedAt: now,
          });
          this.options.log.warn(
            { issue: tracked.issue },
            "Agent dispatch skipped a ready issue whose identifier cannot be sent in chat; it is offered again only after the issue changes",
          );

          return;
        }

        // Our own chat connection failed, not the captain: close this
        // Undelivered offer and ask the same captain again later, so an
        // Outage never uses up a round or skips anyone.
        this.options.ledger.save({
          ...asking,
          closedOffer: offer.id,
          resume: index,
        });
        throw error;
      }

      // The captain is not online under its account now: like unavailable.
      if (!sent) {
        continue;
      }

      if (sent.messageID === undefined) {
        this.polling.warnOnce(
          "message-id",
          "Agent dispatch offer has no server message ID; answers to it cannot be matched",
        );
      }

      this.options.ledger.save({
        ...asking,
        offer: {
          ...offer,
          ...(sent.messageID !== undefined && { messageID: sent.messageID }),
        },
      });
      this.options.log.info(
        {
          issue: tracked.identifier,
          captain: captain.name,
          round: tracked.round,
        },
        "Agent dispatch offered a ready issue",
      );

      return;
    }

    await this.endRound(tracked, signal);
  }

  private async endRound(tracked: TrackedIssue, signal: AbortSignal) {
    const ladder = this.settings.retryLadderMs;
    const now = this.now();

    if (tracked.round > ladder.length) {
      const clearing: TrackedIssue = {
        ...tracked,
        state: "clearing",
        offer: undefined,
        updatedAt: now,
      };

      this.options.ledger.save(clearing);
      await this.giveUp(clearing, signal);

      return;
    }

    this.options.ledger.save({
      ...tracked,
      state: "waiting",
      offer: undefined,
      nextRoundAt: now + (ladder[tracked.round - 1] ?? 0),
      updatedAt: now,
    });
  }

  private async giveUp(tracked: TrackedIssue, signal: AbortSignal) {
    const { api, ledger } = this.options;

    // Never write as an identity this process has not confirmed.
    if (!(await this.polling.identityConfirmed(signal))) {
      return;
    }

    let state = tracked;

    for (let attempt = 0; attempt < maxEditAttempts; attempt++) {
      const current = await api.issue(state.issue, signal);
      const reason = await this.polling.unqualified(current, signal);

      // After the comment, a cleared flag is most likely our own write whose
      // Answer was lost: finish the give-up and still say so in chat.
      if (reason === "unflagged" && state.commented && current) {
        await this.gaveUp(state, current.version, signal);

        return;
      }

      if (reason || !current) {
        await this.finish(state, reason ?? "missing", current?.version, signal);

        return;
      }

      if (!state.commented) {
        await api.comment(
          state.issue,
          `No captain in this fleet could take this issue after ${state.round === 1 ? "1 round" : `${state.round} rounds`} of offers. Ready for agents is now cleared; flag the issue again to offer it once more.`,
          signal,
        );
        state = { ...state, commented: true, updatedAt: this.now() };
        ledger.save(state);
      }

      const result = await api.clearReady(state.issue, current.version, signal);

      if (result.conflict) {
        continue;
      }

      await this.gaveUp(state, result.version ?? current.version + 1, signal);

      return;
    }
  }

  private async gaveUp(
    state: TrackedIssue,
    version: number,
    signal: AbortSignal,
  ) {
    this.options.ledger.save({
      ...state,
      state: "done",
      outcome: "gave-up",
      doneVersion: version,
      updatedAt: this.now(),
    });
    await this.announce(
      {
        kind: "gave-up",
        offerID: undefined,
        issue: state.identifier,
        text: dispatchText.gaveUp(state, state.round),
        replyTo: undefined,
      },
      signal,
    );
    this.options.log.info(
      { issue: state.identifier, rounds: state.round },
      "Agent dispatch gave up on a ready issue",
    );
  }

  private async handleAnswer(input: DispatchAnswerInput, signal: AbortSignal) {
    const tracked = this.options.ledger.byOffer(input.offerID);
    const offer = tracked?.offer;

    if (
      !tracked ||
      !offer ||
      tracked.state !== "asking" ||
      offer.id !== input.offerID ||
      tracked.closedOffer === offer.id ||
      !this.same(input.account, offer.account) ||
      offer.messageID === undefined ||
      input.replyTo !== offer.messageID ||
      input.at > offer.deadline
    ) {
      this.options.log.debug("Agent dispatch ignored an uncorrelated answer");

      return;
    }

    if (input.answer === "decline") {
      this.options.log.info(
        { issue: tracked.identifier, captain: offer.account },
        "Agent dispatch offer declined",
      );
      // The captain's own reply says so in chat: no timeout line follows.
      const declined: TrackedIssue = { ...tracked, closedOffer: offer.id };
      this.options.ledger.save(declined);
      await this.askNext(declined, declined.position + 1, signal);

      return;
    }

    // The acceptance is recorded first: when this process has not yet
    // Confirmed its API identity (after a restart, say) and cannot now, the
    // Write waits in the ledger for a poll that confirms it.
    const accepting: TrackedIssue = {
      ...tracked,
      state: "accepting",
      updatedAt: this.now(),
    };

    this.options.ledger.save(accepting);
    await this.assignAccepted(accepting, signal);
  }

  /**
   * Versioned assignment to the accepting captain, retried after a race.
   * Only as a confirmed identity, only while the issue still qualifies
   * against current fleet membership, and only while the offer's user is
   * still a captain of this fleet whose chat account is the one that
   * answered, by a roster no older than one poll interval.
   */
  private async assignAccepted(tracked: TrackedIssue, signal: AbortSignal) {
    const offer = tracked.offer;

    if (!offer) {
      return;
    }

    if (!(await this.polling.identityConfirmed(signal))) {
      this.polling.warnOnce(
        "unconfirmed-write",
        "Agent dispatch holds an accepted offer until its API identity is confirmed",
        { issue: tracked.identifier },
      );

      return;
    }

    this.polling.cleared("unconfirmed-write");
    const { api, ledger } = this.options;
    let refused: RefusedReason | undefined;

    try {
      for (let attempt = 0; attempt < maxEditAttempts; attempt++) {
        const current = await api.issue(tracked.issue, signal);

        if (current?.assignee) {
          const mine = current.assignee.userId === offer.captain;

          if (mine) {
            ledger.recordNotified(
              tracked.issue,
              offer.captain,
              tracked.identifier,
              this.now(),
              false,
            );
          }

          ledger.save({
            ...tracked,
            state: "done",
            outcome: mine ? "accepted" : "taken",
            doneVersion: current.version,
            updatedAt: this.now(),
          });
          await this.announce(
            {
              kind: mine ? "accepted" : "taken",
              offerID: offer.id,
              issue: tracked.identifier,
              text: mine
                ? dispatchText.accepted(offer.account, offer.id, tracked)
                : dispatchText.taken(offer.account, offer.id, tracked),
              replyTo: offer.messageID,
            },
            signal,
          );

          return;
        }

        const reason = await this.polling.unqualified(current, signal);

        if (reason) {
          await this.finish(
            { ...tracked, state: "asking" },
            reason,
            current?.version,
            signal,
          );

          return;
        }

        if (!current) {
          return;
        }

        // The offer's stored user ID is not proof: the captain may have left
        // The fleet, been demoted or been renamed to another chat account.
        const captain = (await this.polling.freshRoster(signal)).captains.get(
          offer.captain,
        );

        if (!captain || !this.same(captain.account, offer.account)) {
          refused = captain ? "account" : "captain";
          break;
        }

        const result = await api.assign(
          tracked.issue,
          current.version,
          offer.captain,
          signal,
        );

        if (result.conflict) {
          continue;
        }

        // The captain accepted: no separate assignment notice follows.
        ledger.recordNotified(
          tracked.issue,
          offer.captain,
          tracked.identifier,
          this.now(),
          false,
        );
        ledger.save({
          ...tracked,
          state: "done",
          outcome: "accepted",
          doneVersion: result.version ?? current.version + 1,
          updatedAt: this.now(),
        });
        await this.announce(
          {
            kind: "accepted",
            offerID: offer.id,
            issue: tracked.identifier,
            text: dispatchText.accepted(offer.account, offer.id, tracked),
            replyTo: offer.messageID,
          },
          signal,
        );
        this.options.log.info(
          { issue: tracked.identifier, captain: offer.account },
          "Agent dispatch assigned an accepted offer",
        );

        return;
      }
    } catch (error) {
      signal.throwIfAborted();

      if (tracked.outcome !== "retrying") {
        ledger.save({ ...tracked, outcome: "retrying", updatedAt: this.now() });
        await this.announce(
          {
            kind: "retrying",
            offerID: offer.id,
            issue: tracked.identifier,
            text: dispatchText.retrying(offer.account, offer.id, tracked),
            replyTo: offer.messageID,
          },
          signal,
        );
      }

      throw error;
    }

    if (refused) {
      await this.refuseAcceptance(tracked, refused, signal);
    }
  }

  /**
   * An acceptance that must not be written: close the offer as declined,
   * say why, and ask the next captain in this round.
   */
  private async refuseAcceptance(
    tracked: TrackedIssue,
    reason: RefusedReason,
    signal: AbortSignal,
  ) {
    const offer = tracked.offer;

    if (!offer) {
      return;
    }

    const declined: TrackedIssue = {
      ...tracked,
      state: "asking",
      closedOffer: offer.id,
      resume: undefined,
      outcome: undefined,
      updatedAt: this.now(),
    };

    // Recorded first: a restart or a failed next offer moves on from here.
    this.options.ledger.save(declined);
    this.options.log.info(
      { issue: tracked.identifier, captain: offer.account, reason },
      "Agent dispatch refused an acceptance: the user is no longer this fleet's captain under the answering account",
    );
    await this.announce(
      {
        kind: "withdrawn",
        offerID: offer.id,
        issue: tracked.identifier,
        text: dispatchText.refused(offer.account, offer.id, tracked, reason),
        replyTo: offer.messageID,
      },
      signal,
    );
    await this.askNext(declined, declined.position + 1, signal);
  }
}
