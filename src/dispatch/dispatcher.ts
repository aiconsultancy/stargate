import type { Logger } from "pino";
import { fold } from "../irc/protocol";
import {
  type DispatchApi,
  DispatchApiError,
  type DispatchIssue,
  type FleetRoster,
} from "./api";
import type { AssignmentWalk, DispatchLedger, TrackedIssue } from "./ledger";
import {
  type DispatchAnswer,
  type DispatchOutcome,
  dispatchText,
  type IssueLabel,
  newOfferID,
  type RefusedReason,
  type WithdrawReason,
} from "./protocol";

export type CaptainRef = { userId: string; name: string; account: string };

export type DispatchEvent = {
  kind: DispatchOutcome | "gave-up";
  /** The offer this line is about; absent only for `gave-up`. */
  offerID: string | undefined;
  /** Issue identifier, for markers that name the issue. */
  issue: string;
  text: string;
  /** Message ID of the offer this status line is about, when known. */
  replyTo: string | undefined;
};

/**
 * Thrown by a messenger for an issue it can never carry, such as an
 * identifier its markers cannot hold. Nothing was sent, and retrying cannot
 * help: the dispatcher skips that notice or offer instead of holding it.
 */
export class UndeliverableIssue extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndeliverableIssue";
  }
}

/**
 * The chat side, independent of the transport. IRC is the only
 * implementation today; another transport supplies the same three calls.
 * Either request throws `UndeliverableIssue` for an issue it can never
 * carry; any other failure is this side's own outage and is retried. The
 * issue title is user-editable: a request never puts it in a message that
 * can start a captain's turn, only in a separate line for people.
 */
export interface DispatchMessenger {
  /** Behaviour 1 notice. False when the captain cannot be reached now. */
  assigned(
    captain: CaptainRef,
    issue: IssueLabel,
    signal: AbortSignal,
  ): Promise<boolean>;
  /**
   * Behaviour 2 offer. Undefined when the captain cannot be reached now;
   * otherwise the transport's message ID of the offer, when it has one.
   */
  offer(
    captain: CaptainRef,
    offer: { id: string; issue: IssueLabel; timeoutSeconds: number },
    signal: AbortSignal,
  ): Promise<{ messageID: string | undefined } | undefined>;
  /** A status line for people. Best effort; it never wakes an agent. */
  announce(event: DispatchEvent, signal: AbortSignal): Promise<void>;
}

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

export type DispatchSettings = {
  /** Fleet slug or UUID in the Subspace API. */
  fleet: string;
  pollIntervalMs: number;
  answerTimeoutMs: number;
  /** Waits between rounds; one more round than entries, then give up. */
  retryLadderMs: readonly number[];
  /** IRC (or other transport) account for an API agent name. */
  captainAccount(name: string): string;
  /** Only enrolled fleet agent accounts are ever addressed. */
  enrolled(account: string): boolean;
  sameAccount?(a: string, b: string): boolean;
};

export type AgentDispatcherOptions = {
  settings: DispatchSettings;
  api: DispatchApi;
  messenger: DispatchMessenger;
  ledger: DispatchLedger;
  /** Injectable clock (ms since the epoch). */
  now?: () => number;
  /**
   * Injectable pause between cycles. It must resolve early when `signal`
   * aborts, which happens on shutdown and when an answer arrives.
   */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  log: Logger;
};

/** Resolves after `ms`, or as soon as `signal` aborts; never rejects. */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type Captain = CaptainRef & { available: boolean; reachable: boolean };
/** The fleet's captains, by user ID, and when the roster was read (ms). */
type Roster = { captains: Map<string, Captain>; at: number };
type Membership = {
  fleetId: string;
  projects: ReadonlySet<string>;
  at: number;
};

const closedStates = new Set(["completed", "canceled", "duplicate"]);
/** Re-read assignments a little before the cursor: dedupe makes it safe. */
const cursorOverlapMs = 5 * 60_000;
/** A behaviour 1 notice for an unreachable captain is retried this long. */
const noticeRetryMs = 24 * 3_600_000;
const maxEditAttempts = 3;

function errorStatus(error: unknown) {
  return error instanceof DispatchApiError ? error.status : undefined;
}

/**
 * Deterministic agent dispatch on the rear admiral's gateway. Every poll,
 * timer and answer runs in one serial queue, against a durable ledger. No
 * model decides whether to act.
 */
export class AgentDispatcher {
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private roster: Roster | undefined;
  /** Fleet project membership and when it was read; see `fleetProjects`. */
  private membership: Membership | undefined;
  private readySupported: boolean | undefined;
  /** Where the next poll goes on with a ready list longer than one poll reads. */
  private readyCursor: string | undefined;
  /**
   * The fleet's API ID once this process has confirmed that its credential
   * is that fleet's rear admiral. Nothing is written to the API before.
   */
  private verifiedFleet: string | undefined;
  private readonly warned = new Set<string>();
  /** Issue → earliest retry after a failed step, so a failing API is not hammered. */
  private readonly retryAt = new Map<string, number>();
  private kick: (() => void) | undefined;
  private runSignal: AbortSignal | undefined;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: AgentDispatcherOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? pause;
  }

  private get settings() {
    return this.options.settings;
  }

  private same(a: string, b: string) {
    return this.settings.sameAccount
      ? this.settings.sameAccount(a, b)
      : fold(a) === fold(b);
  }

  /** Log a problem once until it clears; never logs bodies or secrets. */
  private warnOnce(key: string, message: string, detail: object = {}) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.log.warn(detail, message);
  }

  private cleared(key: string) {
    this.warned.delete(key);
  }

  /**
   * Log a failed API call once until that step succeeds again. A refused
   * credential (401 or 403) gets one plain line of its own: it needs an
   * operator, and every later poll tries again at the usual interval.
   * Only the HTTP status is logged, never a header, token or body.
   */
  private apiFailed(
    key: string,
    message: string,
    error: unknown,
    detail: object = {},
  ) {
    const status = errorStatus(error);
    if (status === 401 || status === 403) {
      this.warnOnce(
        "credential",
        "Agent dispatch: the Subspace API refused the rear admiral's credential; provision a valid bearer token in agentDispatch.api.tokenEnv. Retrying at each poll",
        { status },
      );
      return;
    }
    this.warnOnce(key, message, { ...detail, status });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Behaviour 2 is unavailable when the API does not return the flag. */
  get readyForAgentsAvailable() {
    return this.readySupported !== false;
  }

  /** One poll followed by due timers; tests drive this with a fake clock. */
  step(signal: AbortSignal) {
    return this.serial(async () => {
      await this.poll(signal);
      await this.timers(signal);
    });
  }

  /** Due timers only: deadlines, next rounds and pending writes. */
  tick(signal: AbortSignal) {
    return this.serial(() => this.timers(signal));
  }

  /** A captain's answer from the transport; untrusted until checked here. */
  answer(input: DispatchAnswerInput, signal?: AbortSignal) {
    const stop = signal ?? this.runSignal ?? new AbortController().signal;
    return this.serial(() => this.handleAnswer(input, stop)).finally(() =>
      this.kick?.(),
    );
  }

  /** When a tracked issue's next step is due, after any failure back-off. */
  private dueAt(tracked: TrackedIssue): number | undefined {
    const offer = tracked.offer;
    const at =
      tracked.state === "asking"
        ? offer && tracked.closedOffer === offer.id
          ? this.now()
          : offer?.deadline
        : tracked.state === "waiting"
          ? (tracked.nextRoundAt ?? this.now())
          : tracked.state === "done"
            ? undefined
            : // A pending write is retried by every timer run; never spin for it.
              this.now() + this.settings.pollIntervalMs;
    const retry = this.retryAt.get(tracked.issue);
    return at === undefined || retry === undefined ? at : Math.max(at, retry);
  }

  /** Earliest time any timer is due, if any. */
  private nextDue(): number | undefined {
    let due: number | undefined;
    for (const tracked of this.options.ledger.active()) {
      const at = this.dueAt(tracked);
      if (at !== undefined && (due === undefined || at < due)) due = at;
    }
    return due;
  }

  /**
   * Polls every `pollIntervalMs` and runs timers as they fall due, until the
   * signal aborts. A failed poll or step is logged once and tried again at
   * the next interval, never sooner: errors are never thrown from here.
   */
  async run(signal: AbortSignal) {
    this.runSignal = signal;
    let nextPoll = this.now();
    while (!signal.aborted) {
      let due = nextPoll;
      try {
        if (this.now() >= nextPoll) {
          // Scheduled before the poll: a failure waits a whole interval.
          nextPoll = this.now() + this.settings.pollIntervalMs;
          await this.serial(() => this.poll(signal));
        }
        await this.serial(() => this.timers(signal));
        due = Math.min(nextPoll, this.nextDue() ?? nextPoll);
        this.cleared("cycle");
      } catch {
        if (signal.aborted) return;
        due = nextPoll;
        this.warnOnce("cycle", "Agent dispatch cycle failed; retrying later");
      }
      if (signal.aborted) return;
      const wait = Math.min(
        Math.max(1000, due - this.now()),
        this.settings.pollIntervalMs,
      );
      // An answer wakes the loop early so its follow-up timer is not late.
      const wake = new AbortController();
      this.kick = () => wake.abort();
      try {
        await this.wait(wait, AbortSignal.any([signal, wake.signal]));
      } catch {
        // A pause never fails the dispatcher; the loop re-checks the signal.
      } finally {
        this.kick = undefined;
      }
    }
  }

  private async poll(signal: AbortSignal) {
    let roster: FleetRoster;
    let readAt: number;
    try {
      roster = await this.options.api.fleet(this.settings.fleet, signal);
      readAt = this.now();
      this.cleared("fleet");
      this.cleared("credential");
    } catch (error) {
      signal.throwIfAborted();
      this.apiFailed(
        "fleet",
        "Agent dispatch cannot read the fleet roster",
        error,
      );
      return;
    }
    if (!(await this.checkIdentity(roster, signal))) return;
    this.roster = this.captainsOf(roster, readAt);
    try {
      await this.pollAssigned(signal);
      this.cleared("assigned");
    } catch (error) {
      signal.throwIfAborted();
      this.apiFailed(
        "assigned",
        "Agent dispatch could not read assignments",
        error,
      );
    }
    try {
      await this.pollReady(signal);
      this.cleared("ready");
    } catch (error) {
      signal.throwIfAborted();
      this.apiFailed(
        "ready",
        "Agent dispatch could not read ready issues",
        error,
      );
    }
    this.options.ledger.prune(this.now());
  }

  /** Captains are the roster's agents of rank captain, with their chat accounts. */
  private captainsOf(roster: FleetRoster, at: number): Roster {
    const captains = new Map<string, Captain>();
    for (const agent of roster.agents) {
      if (agent.rank !== "captain") continue;
      const account = this.settings.captainAccount(agent.name);
      const reachable = this.settings.enrolled(account);
      if (!reachable)
        this.warnOnce(
          `enrolled:${agent.userId}`,
          "Agent dispatch skips a captain whose chat account is not an enrolled fleet agent",
          { captain: agent.name },
        );
      captains.set(agent.userId, {
        userId: agent.userId,
        name: agent.name,
        account,
        available: agent.available,
        reachable,
      });
    }
    return { captains, at };
  }

  /**
   * The fleet roster, read within the last poll interval: read again when
   * older or not yet read, as for fleet membership. A failed read, or a
   * roster of another fleet than the confirmed identity's, throws, so the
   * write that needed it waits.
   */
  private async freshRoster(signal: AbortSignal) {
    const cached = this.roster;
    const age = cached ? this.now() - cached.at : undefined;
    if (
      cached &&
      age !== undefined &&
      age >= 0 &&
      age < this.settings.pollIntervalMs
    )
      return cached;
    const roster = await this.options.api.fleet(this.settings.fleet, signal);
    if (this.verifiedFleet === undefined || roster.id !== this.verifiedFleet)
      throw new Error("Agent dispatch roster is not the confirmed fleet's");
    this.roster = this.captainsOf(roster, this.now());
    return this.roster;
  }

  /**
   * Assignments and comments must be the rear admiral's own, in this fleet:
   * the identity's fleet ID must be the roster's, never absent.
   */
  private async checkIdentity(roster: FleetRoster, signal: AbortSignal) {
    if (this.verifiedFleet !== undefined)
      return this.verifiedFleet === roster.id;
    try {
      const me = await this.options.api.me(signal);
      if (
        me.kind !== "agent" ||
        me.agentRank !== "rearAdmiral" ||
        me.fleetId !== roster.id
      ) {
        this.warnOnce(
          "identity",
          "Agent dispatch is idle: the API token is not this fleet's rear admiral agent (GET /api/v1/me). Retrying at each poll",
        );
        return false;
      }
      this.verifiedFleet = roster.id;
      this.cleared("identity");
      return true;
    } catch (error) {
      signal.throwIfAborted();
      this.apiFailed(
        "me",
        "Agent dispatch cannot confirm its API identity",
        error,
      );
      return false;
    }
  }

  /**
   * Whether this process has confirmed its API identity, confirming it now
   * when no poll has yet. Every API write waits for this: a ledger left by
   * an earlier process says nothing about the credential this one holds.
   */
  private async identityConfirmed(signal: AbortSignal) {
    if (this.verifiedFleet !== undefined) return true;
    let roster: FleetRoster;
    try {
      roster = await this.options.api.fleet(this.settings.fleet, signal);
    } catch (error) {
      signal.throwIfAborted();
      this.apiFailed(
        "fleet",
        "Agent dispatch cannot read the fleet roster",
        error,
      );
      return false;
    }
    return this.checkIdentity(roster, signal);
  }

  /**
   * The fleet's projects, read within the last poll interval: read again
   * when unknown (as after a restart) or older. A failed read throws, so the
   * offer or write that needed it waits; unknown membership never permits.
   */
  private async fleetProjects(signal: AbortSignal) {
    const fleetId = this.verifiedFleet;
    if (fleetId === undefined)
      throw new Error("Agent dispatch identity is not confirmed");
    const cached = this.membership;
    const age = cached ? this.now() - cached.at : undefined;
    if (
      cached?.fleetId === fleetId &&
      age !== undefined &&
      age >= 0 &&
      age < this.settings.pollIntervalMs
    )
      return cached.projects;
    const projects = await this.options.api.fleetProjects(fleetId, signal);
    this.membership = { fleetId, projects, at: this.now() };
    return projects;
  }

  private noteReadyField(issues: readonly DispatchIssue[]) {
    if (issues.some((issue) => issue.readyForAgents === undefined))
      this.markReadyUnsupported();
    else if (issues.length && this.readySupported === undefined)
      this.readySupported = true;
  }

  private markReadyUnsupported() {
    if (this.readySupported === false) return;
    this.readySupported = false;
    this.options.log.warn(
      "Agent dispatch: this Subspace API does not support readyForAgents; round robin offers of ready issues are unavailable and only direct assignments are notified",
    );
  }

  /**
   * Behaviour 1. A listing longer than one poll's page budget is read over
   * several polls from a cursor kept in the ledger, so its size never blocks
   * a poll: the first start's full read records existing assignments a part
   * at a time and initialises the ledger when it ends.
   */
  private async pollAssigned(signal: AbortSignal) {
    const roster = this.roster;
    if (!roster) return;
    const { ledger } = this.options;
    const ids = [...roster.captains.keys()].sort();
    const first = !ledger.initialised;
    // First start ends with the first read of captains' assignments: a fleet
    // that gains its first captain later still records before it notifies.
    if (!ids.length) return;
    const saved = ledger.assignmentWalk;
    // The API cursor is bound to the filter: a changed roster starts again.
    const resumed =
      saved &&
      saved.assignees.length === ids.length &&
      saved.assignees.every((id, index) => id === ids[index])
        ? saved
        : undefined;
    const cursor = ledger.cursor;
    const walk: Omit<AssignmentWalk, "cursor"> = resumed ?? {
      assignees: ids,
      since:
        first || cursor === undefined || !Number.isFinite(Date.parse(cursor))
          ? undefined
          : new Date(Date.parse(cursor) - cursorOverlapMs).toISOString(),
      startedAt: this.now(),
      newest: first ? undefined : cursor,
      hold: undefined,
    };
    let part: Awaited<ReturnType<DispatchApi["assignedIssues"]>>;
    try {
      part = await this.options.api.assignedIssues(
        ids,
        walk.since,
        resumed?.cursor,
        signal,
      );
    } catch (error) {
      // A cursor the API no longer accepts starts the listing again.
      if (resumed && errorStatus(error) === 400)
        ledger.assignmentWalk = undefined;
      throw error;
    }
    const issues = part.items;
    this.noteReadyField(issues);
    let newest = walk.newest;
    let hold = walk.hold;
    const ordered = [...issues].sort(
      (a, b) =>
        Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
        a.id.localeCompare(b.id),
    );
    for (const issue of ordered) {
      if (
        Number.isFinite(Date.parse(issue.updatedAt)) &&
        (newest === undefined ||
          Date.parse(issue.updatedAt) > Date.parse(newest))
      )
        newest = issue.updatedAt;
      const assignee = issue.assignee;
      if (assignee?.kind !== "agent") continue;
      const captain = roster.captains.get(assignee.userId);
      if (!captain) continue;
      if (ledger.notified(issue.id, captain.userId)) continue;
      // An acceptance whose assignment answer was lost: the offer flow
      // confirms it in chat; an assignment notice would repeat it.
      const offered = ledger.tracked(issue.id);
      if (
        offered?.state === "accepting" &&
        offered.offer?.captain === captain.userId
      )
        continue;
      const now = this.now();
      if (first || issue.archived || closedStates.has(issue.stateType)) {
        ledger.recordNotified(
          issue.id,
          captain.userId,
          issue.identifier,
          now,
          false,
        );
        continue;
      }
      const fresh = now - Date.parse(issue.updatedAt) < noticeRetryMs;
      let sent = false;
      if (captain.reachable)
        try {
          sent = await this.options.messenger.assigned(captain, issue, signal);
        } catch (error) {
          signal.throwIfAborted();
          // Never sendable: skip this notice rather than hold the cursor.
          if (error instanceof UndeliverableIssue) {
            ledger.recordNotified(
              issue.id,
              captain.userId,
              issue.identifier,
              now,
              false,
            );
            this.options.log.warn(
              { issue: issue.id, captain: captain.name },
              "Agent dispatch skipped an assignment notice whose issue identifier cannot be sent in chat",
            );
            continue;
          }
        }
      if (sent) {
        ledger.recordNotified(
          issue.id,
          captain.userId,
          issue.identifier,
          now,
          true,
        );
        this.options.log.info(
          { issue: issue.identifier, captain: captain.name },
          "Agent dispatch notified a captain of an assignment",
        );
      } else if (fresh) {
        if (
          hold === undefined ||
          Date.parse(issue.updatedAt) < Date.parse(hold)
        )
          hold = issue.updatedAt;
      } else {
        ledger.recordNotified(
          issue.id,
          captain.userId,
          issue.identifier,
          now,
          false,
        );
        this.options.log.warn(
          { issue: issue.identifier, captain: captain.name },
          "Agent dispatch gave up notifying an unreachable captain of an assignment",
        );
      }
    }
    if (part.next !== undefined) {
      if (!resumed)
        this.options.log.info(
          "Agent dispatch reads a long assignment list over several polls",
        );
      ledger.assignmentWalk = { ...walk, cursor: part.next, newest, hold };
      return;
    }
    // Never past the listing's start: an issue changed while a long listing
    // was read, on a page already passed, is read again by the next one.
    const started = new Date(walk.startedAt).toISOString();
    const reached =
      newest === undefined || Date.parse(newest) > walk.startedAt
        ? started
        : newest;
    ledger.cursor =
      hold !== undefined && Date.parse(hold) < Date.parse(reached)
        ? hold
        : reached;
    ledger.assignmentWalk = undefined;
    if (first) ledger.markInitialised();
  }

  /**
   * Why an issue no longer qualifies for offers, or undefined. Fleet
   * membership must be known and current (see `fleetProjects`); when it
   * cannot be read this throws, so the caller waits instead of permitting.
   */
  private async unqualified(
    issue: DispatchIssue | undefined,
    signal: AbortSignal,
  ): Promise<WithdrawReason | undefined> {
    if (!issue) return "missing";
    if (issue.assignee) return "assigned";
    if (issue.archived) return "archived";
    if (closedStates.has(issue.stateType)) return "closed";
    if (issue.readyForAgents !== true) return "unflagged";
    const projects = await this.fleetProjects(signal);
    if (!projects.has(issue.projectId)) return "moved";
    return;
  }

  private async pollReady(signal: AbortSignal) {
    const roster = this.roster;
    if (!roster) return;
    let issues: DispatchIssue[] = [];
    if (this.readySupported !== false) {
      const from = this.readyCursor;
      try {
        const part = await this.options.api.readyIssues(from, signal);
        issues = part.items;
        // A longer list goes on at the next poll, then starts again.
        this.readyCursor = part.next;
        this.noteReadyField(issues);
      } catch (error) {
        if (errorStatus(error) !== 400) throw error;
        // A refused cursor starts the list again; only a refused first
        // page means an API without the filter.
        if (from !== undefined) {
          this.readyCursor = undefined;
          throw error;
        }
        this.markReadyUnsupported();
      }
    }
    const { ledger } = this.options;
    const readyIDs = new Set<string>();
    if (this.readyForAgentsAvailable) {
      // Current membership, read before any issue is tracked: a failure
      // fails this part of the poll rather than tracking on stale data.
      await this.fleetProjects(signal);
      for (const issue of issues) {
        if (await this.unqualified(issue, signal)) continue;
        readyIDs.add(issue.id);
        const tracked = ledger.tracked(issue.id);
        if (tracked && tracked.state !== "done") {
          if (
            tracked.title !== issue.title ||
            tracked.identifier !== issue.identifier
          )
            ledger.save({
              ...tracked,
              title: issue.title,
              identifier: issue.identifier,
            });
          continue;
        }
        // A finished issue starts again only after someone flags it anew.
        if (tracked && issue.version <= (tracked.doneVersion ?? -1)) continue;
        const now = this.now();
        ledger.save({
          issue: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          state: "waiting",
          round: 0,
          start: ledger.nextRotation(),
          order: [],
          position: 0,
          nextRoundAt: now,
          updatedAt: now,
        });
      }
    }
    // Anything tracked that the list no longer shows is read on its own;
    // with an API that lost the flag this withdraws open offers at once.
    for (const tracked of ledger.active()) {
      if (readyIDs.has(tracked.issue)) continue;
      if (tracked.state !== "asking" && tracked.state !== "waiting") continue;
      let current: DispatchIssue | undefined;
      try {
        current = await this.options.api.issue(tracked.issue, signal);
      } catch {
        signal.throwIfAborted();
        continue;
      }
      const reason = await this.unqualified(current, signal);
      if (reason) await this.finish(tracked, reason, current?.version, signal);
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
      ...(version === undefined ? {} : { doneVersion: version }),
      updatedAt: this.now(),
    });
    if (open)
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
    // before an acceptance write as a confirmed identity.
    if (!this.roster) return;
    for (const tracked of this.options.ledger.active()) {
      signal.throwIfAborted();
      const retry = this.retryAt.get(tracked.issue);
      if (retry !== undefined && this.now() < retry) continue;
      try {
        await this.due(tracked, signal);
        this.retryAt.delete(tracked.issue);
        this.cleared(`timer:${tracked.issue}`);
      } catch (error) {
        signal.throwIfAborted();
        // The ledger still holds the last completed step; try again later.
        this.retryAt.set(
          tracked.issue,
          this.now() + this.settings.pollIntervalMs,
        );
        this.apiFailed(
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
      if (!offer) return;
      // Declined, timed out or never delivered: move on without waiting.
      if (tracked.closedOffer === offer.id) {
        await this.askNext(
          tracked,
          tracked.resume ?? tracked.position + 1,
          signal,
        );
        return;
      }
      if (now < offer.deadline) return;
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
      if (tracked.nextRoundAt !== undefined && now < tracked.nextRoundAt)
        return;
      await this.startRound(tracked, signal);
    } else if (tracked.state === "accepting")
      await this.assignAccepted(tracked, signal);
    else if (tracked.state === "clearing") await this.giveUp(tracked, signal);
  }

  /**
   * Re-read the issue and current fleet membership before any new offer;
   * stop when it no longer qualifies. A failed read throws: the offer waits.
   * The issue as read when it still qualifies; undefined once finished.
   */
  private async stillReady(tracked: TrackedIssue, signal: AbortSignal) {
    const current = await this.options.api.issue(tracked.issue, signal);
    const reason = await this.unqualified(current, signal);
    if (reason || !current) {
      await this.finish(tracked, reason ?? "missing", current?.version, signal);
      return;
    }
    return current;
  }

  private async startRound(tracked: TrackedIssue, signal: AbortSignal) {
    const roster = this.roster;
    if (!roster) return;
    const current = await this.stillReady(tracked, signal);
    if (!current) return;
    const ids = [...roster.captains.keys()].sort();
    const shift = ids.length ? tracked.start % ids.length : 0;
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
    const roster = this.roster;
    if (!roster) return;
    let version = checked;
    if (version === undefined && position < tracked.order.length) {
      const current = await this.stillReady(tracked, signal);
      if (!current) return;
      version = current.version;
    }
    for (let index = position; index < tracked.order.length; index++) {
      const captain = roster.captains.get(tracked.order[index] ?? "");
      if (!captain?.available || !captain.reachable) continue;
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
      if (!offer) continue;
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
        // someone changes it, without holding the poll or other issues.
        if (error instanceof UndeliverableIssue) {
          this.options.ledger.save({
            ...tracked,
            state: "done",
            offer: undefined,
            resume: undefined,
            outcome: "undeliverable",
            ...(version === undefined ? {} : { doneVersion: version }),
            updatedAt: now,
          });
          this.options.log.warn(
            { issue: tracked.issue },
            "Agent dispatch skipped a ready issue whose identifier cannot be sent in chat; it is offered again only after the issue changes",
          );
          return;
        }
        // Our own chat connection failed, not the captain: close this
        // undelivered offer and ask the same captain again later, so an
        // outage never uses up a round or skips anyone.
        this.options.ledger.save({
          ...asking,
          closedOffer: offer.id,
          resume: index,
        });
        throw error;
      }
      // The captain is not online under its account now: like unavailable.
      if (!sent) continue;
      if (sent.messageID === undefined)
        this.warnOnce(
          "message-id",
          "Agent dispatch offer has no server message ID; answers to it cannot be matched",
        );
      this.options.ledger.save({
        ...asking,
        offer: {
          ...offer,
          ...(sent.messageID === undefined
            ? {}
            : { messageID: sent.messageID }),
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
    if (!(await this.identityConfirmed(signal))) return;
    let state = tracked;
    for (let attempt = 0; attempt < maxEditAttempts; attempt++) {
      const current = await api.issue(state.issue, signal);
      const reason = await this.unqualified(current, signal);
      // After the comment, a cleared flag is most likely our own write whose
      // answer was lost: finish the give-up and still say so in chat.
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
      if (result.conflict) continue;
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
    // confirmed its API identity (after a restart, say) and cannot now, the
    // write waits in the ledger for a poll that confirms it.
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
    if (!offer) return;
    if (!(await this.identityConfirmed(signal))) {
      this.warnOnce(
        "unconfirmed-write",
        "Agent dispatch holds an accepted offer until its API identity is confirmed",
        { issue: tracked.identifier },
      );
      return;
    }
    this.cleared("unconfirmed-write");
    const { api, ledger } = this.options;
    let refused: RefusedReason | undefined;
    try {
      for (let attempt = 0; attempt < maxEditAttempts; attempt++) {
        const current = await api.issue(tracked.issue, signal);
        if (current?.assignee) {
          const mine = current.assignee.userId === offer.captain;
          if (mine)
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
        const reason = await this.unqualified(current, signal);
        if (reason) {
          await this.finish(
            { ...tracked, state: "asking" },
            reason,
            current?.version,
            signal,
          );
          return;
        }
        if (!current) return;
        // The offer's stored user ID is not proof: the captain may have left
        // the fleet, been demoted or been renamed to another chat account.
        const captain = (await this.freshRoster(signal)).captains.get(
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
        if (result.conflict) continue;
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
    if (refused) await this.refuseAcceptance(tracked, refused, signal);
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
    if (!offer) return;
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
