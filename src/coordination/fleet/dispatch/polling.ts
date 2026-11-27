import type { Logger } from "pino";
import {
  type DecisionOutcome,
  type DispatchApi,
  DispatchApiError,
  type DispatchIssue,
  type FleetRoster,
} from "./api";
import type { AssignmentWalk, DispatchLedger, TrackedIssue } from "./ledger";
import type {
  CaptainRef,
  DispatchOutcome,
  IssueLabel,
  WithdrawReason,
} from "./protocol";

export type { CaptainRef } from "./protocol";

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
  public constructor(message: string) {
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
  /** A fixed decision outcome sent privately to the recording captain. */
  decisionOutcome?(
    captain: CaptainRef,
    outcome: DecisionOutcome,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** A status line for people. Best effort; it never wakes an agent. */
  announce(event: DispatchEvent, signal: AbortSignal): Promise<void>;
}

export type DispatchSettings = {
  /** Fleet slug or UUID in the Subspace API. */
  fleet: string;
  pollIntervalMs: number;
  answerTimeoutMs: number;
  decisionOutcomeDms: boolean;
  offersEnabled: boolean;
  recheckIdentity: boolean;
  /** Waits between rounds; one more round than entries, then give up. */
  retryLadderMs: readonly number[];
  /** IRC (or other transport) account for an API agent name. */
  captainAccount(name: string): string;
  /** Only enrolled fleet agent accounts are ever addressed. */
  enrolled(account: string): boolean;
  sameAccount?(a: string, b: string): boolean;
};

export interface AssignedWorkPoller {
  start(captains: readonly CaptainRef[], signal: AbortSignal): void;
  drain(): Promise<void> | void;
}

export type AssignmentMode =
  | { kind: "off" }
  | { kind: "legacy" }
  | { kind: "requests"; work: AssignedWorkPoller };

export type AgentDispatcherOptions = {
  settings: DispatchSettings;
  api: DispatchApi;
  decisionApi?: Pick<
    DispatchApi,
    "me" | "decisionOutcomes" | "acknowledgeDecisionOutcome"
  >;
  messenger: DispatchMessenger;
  ledger: DispatchLedger;
  assignmentMode: AssignmentMode;
  /** Injectable clock (ms since the epoch). */
  now?: () => number;
  /**
   * Injectable pause between cycles. It must resolve early when `signal`
   * aborts, which happens on shutdown and when an answer arrives.
   */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  log: Logger;
};

/** Fields added to a warning log line; never bodies or secrets. */
type LogDetail = Readonly<Record<string, unknown>>;

type Captain = CaptainRef & {
  available: boolean;
  reachable: boolean;
  registeredAccount?: string;
};

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

function earlierUpdate(hold: string | undefined, updated: string) {
  return hold === undefined || Date.parse(updated) < Date.parse(hold)
    ? updated
    : hold;
}

function errorStatus(error: unknown) {
  return error instanceof DispatchApiError ? error.status : undefined;
}

type PollingPort = {
  readonly options: AgentDispatcherOptions;
  readonly now: () => number;
  readonly finish: (
    tracked: TrackedIssue,
    reason: WithdrawReason,
    version: number | undefined,
    signal: AbortSignal,
  ) => Promise<void>;
};

export class DispatchPolling {
  public roster: Roster | undefined;
  /** Fleet project membership and when it was read; see `fleetProjects`. */
  private membership: Membership | undefined;
  private readySupported: boolean | undefined;
  /** Where the next poll goes on with a ready list longer than one poll reads. */
  private readyCursor: string | undefined;
  private decisionOutcomeCursor: string | undefined;
  /**
   * The fleet's API ID once this process has confirmed that its credential
   * is that fleet's rear admiral. Nothing is written to the API before.
   */
  private verifiedFleet: string | undefined;
  private verifiedUser: string | undefined;
  private readonly warned = new Set<string>();
  private readonly options: PollingPort["options"];
  private readonly now: PollingPort["now"];
  private readonly finish: PollingPort["finish"];
  private readonly pollAssignmentMode: (
    signal: AbortSignal,
  ) => Promise<void> | void;
  private assignmentIdentity = new AbortController();

  public constructor({ options, now, finish }: PollingPort) {
    this.options = options;
    this.now = now;
    this.finish = finish;

    const mode = options.assignmentMode;

    switch (mode.kind) {
      case "off":
        this.pollAssignmentMode = () => {};

        break;
      case "legacy":
        this.pollAssignmentMode = this.pollAssigned.bind(this);

        break;
      case "requests":
        this.pollAssignmentMode = (signal) => {
          mode.work.start(
            this.eligibleCaptains(),
            AbortSignal.any([signal, this.assignmentIdentity.signal]),
          );
        };

        break;
    }
  }

  public async drainAssignments() {
    const mode = this.options.assignmentMode;

    if (mode.kind === "requests") {
      await mode.work.drain();
    }
  }

  private get settings() {
    return this.options.settings;
  }

  public get offersEnabled() {
    return this.settings.offersEnabled;
  }

  private invalidateRoster() {
    this.roster = undefined;
    this.assignmentIdentity.abort();
    this.assignmentIdentity = new AbortController();
  }

  /** Log a problem once until it clears; never logs bodies or secrets. */
  public warnOnce(key: string, message: string, detail: LogDetail = {}) {
    if (this.warned.has(key)) {
      return;
    }

    this.warned.add(key);
    this.options.log.warn(detail, message);
  }

  public cleared(key: string) {
    this.warned.delete(key);
  }

  /**
   * Log a failed API call once until that step succeeds again. A refused
   * credential (401 or 403) gets one plain line of its own: it needs an
   * operator, and every later poll tries again at the usual interval.
   * Only the HTTP status is logged, never a header, token or body.
   */
  public apiFailed(
    key: string,
    message: string,
    error: unknown,
    detail: LogDetail = {},
  ) {
    const status = errorStatus(error);

    if (status === 401 || status === 403) {
      this.warnOnce(
        "credential",
        "Agent dispatch: the Subspace API refused the rear admiral's credential; check the configured rear admiral identity. Retrying at each poll",
        { status },
      );

      return;
    }

    this.warnOnce(key, message, { ...detail, status });
  }

  /** Behaviour 2 is unavailable when the API does not return the flag. */
  public get readyForAgentsAvailable() {
    return this.readySupported !== false;
  }

  public async poll(signal: AbortSignal) {
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

    if (!(await this.checkIdentity(roster.id, signal))) {
      return;
    }

    this.roster = this.captainsOf(roster, readAt);

    try {
      await this.pollAssignmentMode(signal);

      this.cleared("assigned");
    } catch (error) {
      signal.throwIfAborted();
      this.apiFailed(
        "assigned",
        "Agent dispatch could not read assignments",
        error,
      );
    }

    if (this.offersEnabled) {
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
    }

    if (this.settings.decisionOutcomeDms) {
      try {
        await this.pollDecisionOutcomes(roster.id, signal);
        this.cleared("decision-outcomes");
      } catch (error) {
        signal.throwIfAborted();
        this.decisionOutcomeCursor = undefined;
        this.apiFailed(
          "decision-outcomes",
          "Agent dispatch could not deliver decision outcomes",
          error,
        );
      }
    }

    this.options.ledger.prune(this.now());
  }

  private eligibleCaptain(captain: Captain) {
    const account = captain.registeredAccount;

    return (
      captain.available &&
      captain.reachable &&
      (!account ||
        (this.settings.sameAccount?.(account, captain.account) ??
          account === captain.account))
    );
  }

  private eligibleCaptains() {
    return [...(this.roster?.captains.values() ?? [])].filter((captain) =>
      this.eligibleCaptain(captain),
    );
  }

  private async pollDecisionOutcomes(fleetId: string, signal: AbortSignal) {
    const { decisionApi, ledger, messenger } = this.options;
    const api = decisionApi ?? this.options.api;

    if (
      !api.decisionOutcomes ||
      !api.acknowledgeDecisionOutcome ||
      !messenger.decisionOutcome
    ) {
      throw new Error("Decision outcome delivery is not available");
    }

    await this.checkDecisionRelay(fleetId, signal);

    const page = await api.decisionOutcomes(
      fleetId,
      this.decisionOutcomeCursor,
      signal,
    );

    let failed = false;

    for (const outcome of page.items) {
      try {
        if (!ledger.decisionOutcomeSent(outcome.id)) {
          const captain = this.roster?.captains.get(outcome.recordedByUserId);

          if (
            !captain?.registeredAccount ||
            !this.eligibleCaptain(captain) ||
            !(await messenger.decisionOutcome(captain, outcome, signal))
          ) {
            continue;
          }

          ledger.recordDecisionOutcomeSent(outcome.id);
        }

        if (!(await this.identityConfirmed(signal))) {
          return;
        }

        await this.checkDecisionRelay(fleetId, signal);
        await api.acknowledgeDecisionOutcome(fleetId, outcome.id, signal);
        ledger.clearDecisionOutcomeSent(outcome.id);
      } catch (error) {
        signal.throwIfAborted();
        failed = true;
        this.apiFailed(
          "decision-outcome-send",
          "Agent dispatch will retry a decision outcome",
          error,
        );
      }
    }

    if (!failed) {
      this.cleared("decision-outcome-send");
    }

    this.decisionOutcomeCursor = page.next;
  }

  private async checkDecisionRelay(fleetId: string, signal: AbortSignal) {
    const { decisionApi } = this.options;

    if (!decisionApi) {
      return;
    }

    const identity = await decisionApi.me(signal);

    if (
      identity.kind !== "agent" ||
      identity.agentRank !== "rearAdmiral" ||
      identity.fleetId !== fleetId ||
      identity.userId !== this.verifiedUser
    ) {
      throw new Error(
        "Decision relay identity does not match the confirmed rear admiral",
      );
    }
  }

  /** Captains are the roster's agents of rank captain, with their chat accounts. */
  private captainsOf(roster: FleetRoster, at: number): Roster {
    const captains = new Map<string, Captain>();

    for (const agent of roster.agents) {
      if (agent.rank !== "captain") {
        continue;
      }

      const account = this.settings.captainAccount(agent.name);
      const reachable = this.settings.enrolled(account);

      if (!reachable) {
        this.warnOnce(
          `enrolled:${agent.userId}`,
          "Agent dispatch skips a captain whose chat account is not an enrolled fleet agent",
          { captain: agent.name },
        );
      }

      captains.set(agent.userId, {
        userId: agent.userId,
        name: agent.name,
        account,
        available: agent.available,
        reachable,
        ...(agent.ircNick && { registeredAccount: agent.ircNick }),
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
  public async freshRoster(signal: AbortSignal) {
    const cached = this.roster;
    const age = cached ? this.now() - cached.at : undefined;

    if (
      cached &&
      age !== undefined &&
      age >= 0 &&
      age < this.settings.pollIntervalMs
    ) {
      return cached;
    }

    const roster = await this.options.api.fleet(this.settings.fleet, signal);

    if (this.verifiedFleet === undefined || roster.id !== this.verifiedFleet) {
      throw new Error("Agent dispatch roster is not the confirmed fleet's");
    }

    this.roster = this.captainsOf(roster, this.now());

    return this.roster;
  }

  /**
   * Assignments and comments must be the rear admiral's own, in this fleet:
   * the identity's fleet ID must be the roster's, never absent.
   */
  private async checkIdentity(fleet: string, signal: AbortSignal) {
    if (this.verifiedFleet !== undefined && !this.settings.recheckIdentity) {
      if (this.verifiedFleet === fleet) {
        return true;
      }

      this.invalidateRoster();

      return false;
    }

    try {
      const me = await this.options.api.me(signal);

      if (
        me.kind !== "agent" ||
        me.agentRank !== "rearAdmiral" ||
        me.fleetId !== fleet ||
        (this.verifiedUser !== undefined && me.userId !== this.verifiedUser)
      ) {
        this.invalidateRoster();
        this.warnOnce(
          "identity",
          "Agent dispatch is idle: the API token is not this fleet's rear admiral agent (GET /api/v1/me). Retrying at each poll",
        );

        return false;
      }

      this.verifiedFleet = fleet;
      this.verifiedUser = me.userId;
      this.cleared("identity");

      return true;
    } catch (error) {
      signal.throwIfAborted();
      this.invalidateRoster();
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
  public async identityConfirmed(signal: AbortSignal) {
    if (this.verifiedFleet !== undefined) {
      return this.checkIdentity(this.verifiedFleet, signal);
    }

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

    return this.checkIdentity(roster.id, signal);
  }

  /**
   * The fleet's projects, read within the last poll interval: read again
   * when unknown (as after a restart) or older. A failed read throws, so the
   * offer or write that needed it waits; unknown membership never permits.
   */
  private async fleetProjects(signal: AbortSignal) {
    const fleetId = this.verifiedFleet;

    if (fleetId === undefined) {
      throw new Error("Agent dispatch identity is not confirmed");
    }

    const cached = this.membership;
    const age = cached ? this.now() - cached.at : undefined;

    if (
      cached?.fleetId === fleetId &&
      age !== undefined &&
      age >= 0 &&
      age < this.settings.pollIntervalMs
    ) {
      return cached.projects;
    }

    const projects = await this.options.api.fleetProjects(fleetId, signal);
    this.membership = { fleetId, projects, at: this.now() };

    return projects;
  }

  private noteReadyField(issues: readonly DispatchIssue[]) {
    if (issues.some((issue) => issue.readyForAgents === undefined)) {
      this.markReadyUnsupported();
    } else if (issues.length > 0 && this.readySupported === undefined) {
      this.readySupported = true;
    }
  }

  private markReadyUnsupported() {
    if (this.readySupported === false) {
      return;
    }

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

    if (!roster) {
      return;
    }

    const { ledger } = this.options;
    const ids = [...roster.captains.keys()].toSorted();
    const first = !ledger.initialised;

    // First start ends with the first read of captains' assignments: a fleet
    // That gains its first captain later still records before it notifies.
    if (ids.length === 0) {
      return;
    }

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
      if (resumed && errorStatus(error) === 400) {
        ledger.assignmentWalk = undefined;
      }

      throw error;
    }

    const issues = part.items;
    this.noteReadyField(issues);
    let newest = walk.newest;
    let hold = walk.hold;

    const ordered = [...issues].toSorted(
      (a, b) =>
        Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
        a.id.localeCompare(b.id),
    );

    for (const issue of ordered) {
      if (
        Number.isFinite(Date.parse(issue.updatedAt)) &&
        (newest === undefined ||
          Date.parse(issue.updatedAt) > Date.parse(newest))
      ) {
        newest = issue.updatedAt;
      }

      const assignee = issue.assignee;

      if (assignee?.kind !== "agent") {
        continue;
      }

      const captain = roster.captains.get(assignee.userId);

      if (!captain) {
        continue;
      }

      if (ledger.notified(issue.id, captain.userId)) {
        continue;
      }

      // An acceptance whose assignment answer was lost: the offer flow
      // Confirms it in chat; an assignment notice would repeat it.
      const offered = ledger.tracked(issue.id);

      if (
        this.offersEnabled &&
        offered?.state === "accepting" &&
        offered.offer?.captain === captain.userId
      ) {
        hold = earlierUpdate(hold, issue.updatedAt);
        continue;
      }

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

      if (captain.reachable) {
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
        hold = earlierUpdate(hold, issue.updatedAt);
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
      if (!resumed) {
        this.options.log.info(
          "Agent dispatch reads a long assignment list over several polls",
        );
      }

      ledger.assignmentWalk = { ...walk, cursor: part.next, newest, hold };

      return;
    }

    // Never past the listing's start: an issue changed while a long listing
    // Was read, on a page already passed, is read again by the next one.
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

    if (first) {
      ledger.markInitialised();
    }
  }

  /**
   * Why an issue no longer qualifies for offers, or undefined. Fleet
   * membership must be known and current (see `fleetProjects`); when it
   * cannot be read this throws, so the caller waits instead of permitting.
   */
  public async unqualified(
    issue: DispatchIssue | undefined,
    signal: AbortSignal,
  ): Promise<WithdrawReason | undefined> {
    if (!issue) {
      return "missing";
    }

    if (issue.assignee) {
      return "assigned";
    }

    if (issue.archived) {
      return "archived";
    }

    if (closedStates.has(issue.stateType)) {
      return "closed";
    }

    if (issue.readyForAgents !== true) {
      return "unflagged";
    }

    const projects = await this.fleetProjects(signal);

    if (!projects.has(issue.projectId)) {
      return "moved";
    }

    return;
  }

  private async pollReady(signal: AbortSignal) {
    const roster = this.roster;

    if (!roster) {
      return;
    }

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
        if (errorStatus(error) !== 400) {
          throw error;
        }

        // A refused cursor starts the list again; only a refused first
        // Page means an API without the filter.
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
      // Fails this part of the poll rather than tracking on stale data.
      await this.fleetProjects(signal);

      for (const issue of issues) {
        if (await this.unqualified(issue, signal)) {
          continue;
        }

        readyIDs.add(issue.id);
        const tracked = ledger.tracked(issue.id);

        if (tracked && tracked.state !== "done") {
          if (
            tracked.title !== issue.title ||
            tracked.identifier !== issue.identifier
          ) {
            ledger.save({
              ...tracked,
              title: issue.title,
              identifier: issue.identifier,
            });
          }

          continue;
        }

        // A finished issue starts again only after someone flags it anew.
        if (tracked && issue.version <= (tracked.doneVersion ?? -1)) {
          continue;
        }

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
    // With an API that lost the flag this withdraws open offers at once.
    for (const tracked of ledger.active()) {
      if (readyIDs.has(tracked.issue)) {
        continue;
      }

      if (tracked.state !== "asking" && tracked.state !== "waiting") {
        continue;
      }

      let current: DispatchIssue | undefined;

      try {
        current = await this.options.api.issue(tracked.issue, signal);
      } catch {
        signal.throwIfAborted();
        continue;
      }

      const reason = await this.unqualified(current, signal);

      if (reason) {
        await this.finish(tracked, reason, current?.version, signal);
      }
    }
  }
}
