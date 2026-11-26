import { randomBytes } from "node:crypto";
import type {
  ActivityOutcome,
  ActivityRequest,
  CrewTurnActivityLog,
  CrewTurnStart,
  TurnActivityRecorder,
} from "../../../../backends/backend";
import {
  type StoredItem,
  type StoredTurn,
  itemJson,
  itemView,
  pages,
  turnJson,
  turnSummary,
  usage,
} from "./activity-view";
import { crewRecorder } from "./crew-recorder";
import { remeasurer } from "./remeasure";
import type { ApiV1Config } from "./features";
import type {
  V1ActivityItemPage,
  V1AgentActivity,
  V1AgentActivityChange,
  V1AgentActivityEvent,
} from "./types";

/** Channel selectors fold ASCII letters only, not Unicode or IRC punctuation. */
const foldActivityChannel = (value: string) =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export { activityPageBytes } from "./activity-view";

/**
 * Streamed changes are coalesced per agent over this window, keeping each
 * item's latest value: at most about seven frames a second per agent.
 */
export const activityFlushMs = 150;

const defaults = {
  turnsPerAgent: 16,
  /** Across every agent; whole ended turns go first, oldest first. */
  turns: 256,
  /** Settled turn JSON across every agent. */
  bytes: 64 * 1024 * 1024,
};

type Limits = typeof defaults;

/** One coalesced change, encoded once for every viewer of its agent. */
export type ActivityFrame = {
  turnId: string;
  root: string;
  seq: number;
  bytes: Uint8Array;
};

type ActivityWatcher = (frames: readonly ActivityFrame[]) => void;

type Watcher = { turn: string | undefined; notify: ActivityWatcher };

type Lifecycle = Exclude<V1AgentActivityChange, { type: "item" }>;

/**
 * A change waiting for the flush. A lifecycle change carries the summary
 * recorded when it happened, so its payload matches its `seq`; an item's
 * latest value is read when the flush runs.
 */
type Pending = {
  seq: number;
  at: number;
  turn: StoredTurn;
  change: Lifecycle | StoredItem;
};

/** Only while someone watches the agent; otherwise changes cost nothing. */
type Feed = {
  watchers: Map<symbol, Watcher>;
  pending: Map<string, Pending>;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * An officer, or a crew member under its captain: crew subjects have their own
 * `seq` and per-subject turn limit, and share the global limits.
 */
type Agent = {
  agentId: string;
  member: string | undefined;
  seq: number;
  turns: StoredTurn[];
  feed?: Feed | undefined;
};

/**
 * A hub subject key: an officer's registration ID, or `<ship>/<member>`.
 * Neither ID can hold a slash.
 */
export const crewSubject = (ship: string, member: string) =>
  `${ship}/${member}`;

const encoder = new TextEncoder();

function changeOf({ change }: Pending): V1AgentActivityChange {
  return "type" in change ? change : { type: "item", item: itemView(change) };
}

type TurnSelector = string | { msgid: string; channel: string | undefined };

/**
 * All turns, one by ID, or the families whose root matches an IRC request:
 * the matching roots and their descendants, in retained order.
 */
function selectTurns(turns: readonly StoredTurn[], selector?: TurnSelector) {
  if (selector === undefined) {
    return turns;
  }

  if (typeof selector === "string") {
    return turns.filter((turn) => turn.id === selector);
  }

  const channelKey =
    selector.channel === undefined
      ? undefined
      : foldActivityChannel(selector.channel);

  const matches = (turn: StoredTurn) =>
    turn.id === turn.root &&
    turn.requests.some(
      ({ channel, msgid }) =>
        msgid === selector.msgid &&
        (channelKey === undefined ||
          foldActivityChannel(channel) === channelKey),
    );

  const roots = new Set(
    turns.flatMap((turn) => (matches(turn) ? [turn.id] : [])),
  );

  return turns.filter((turn) => roots.has(turn.root));
}

/** Send an agent's coalesced changes to everyone watching it. */
function flush(generation: string, owner: Agent) {
  const feed = owner.feed;

  if (!feed) {
    return;
  }

  feed.timer = undefined;
  const due = [...feed.pending.values()].toSorted((a, b) => a.seq - b.seq);
  feed.pending.clear();
  const frames: ActivityFrame[] = [];
  let audiences: Map<string, ReadonlySet<symbol>> | undefined;

  // An evicted turn still gets the changes marked before, such as its end.
  // Eviction is never announced, so viewers keep their own cap.
  for (const pending of due) {
    try {
      const data: V1AgentActivityEvent = {
        agentId: owner.agentId,
        ...(owner.member !== undefined && { member: owner.member }),
        turnId: pending.turn.id,
        generation,
        seq: pending.seq,
        at: pending.at,
        change: changeOf(pending),
      };

      frames.push({
        turnId: pending.turn.id,
        root: pending.turn.root,
        seq: pending.seq,
        bytes: encoder.encode(
          `event: agent-activity\ndata: ${JSON.stringify(data)}\n\n`,
        ),
      });

      if (pending.turn.audience) {
        (audiences ??= new Map()).set(pending.turn.id, pending.turn.audience);
      }
    } catch {
      /* An unserializable value never stops the stream. */
    }
  }

  for (const [id, { turn, notify }] of feed.watchers) {
    try {
      notify(
        turn === undefined
          ? frames
          : frames.filter(
              (frame) =>
                frame.turnId === turn ||
                frame.root === turn ||
                audiences?.get(frame.turnId)?.has(id),
            ),
      );
    } catch {
      /* A viewer never affects the agent or other viewers. */
    }
  }
}

/** Register a watch with the agent's live feed until it closes. */
function watchAgent(owner: Agent, watcher: Watcher, idle: () => void) {
  owner.feed ??= {
    watchers: new Map(),
    pending: new Map(),
    timer: undefined,
  };
  const feed = owner.feed;
  // An inherited audience never keeps the viewer or its send closure alive.
  const id = Symbol("activity watch");
  feed.watchers.set(id, watcher);

  return () => {
    feed.watchers.delete(id);

    if (feed.watchers.size === 0 && owner.feed === feed) {
      clearTimeout(feed.timer);
      owner.feed = undefined;
      idle();
    }
  };
}

/** Note a change for the next flush; nothing at all when unwatched. */
function mark(
  generation: string,
  owner: Agent,
  key: string,
  pending: () => Pending,
) {
  const feed = owner.feed;

  if (!feed) {
    return;
  }

  feed.pending.set(key, pending());

  if (feed.timer === undefined) {
    feed.timer = setTimeout(() => {
      flush(generation, owner);
    }, activityFlushMs);
    feed.timer.unref?.();
  }
}

/** A turn's cached size, measured again after a write cleared it. */
function measuredBytes(turn: StoredTurn, measure: typeof settledBytes) {
  return (turn.bytes ??= measure(turn));
}

/**
 * Evict settled families together so a retained child never loses its
 * parent, then tell each evicted turn's writer: every path evicts here.
 */
function evict(
  agents: ReadonlyMap<string, Agent>,
  limits: Limits,
  measure: typeof settledBytes,
) {
  type Family = {
    owner: Agent;
    turns: StoredTurn[];
    endedAt: number | null;
    bytes: number;
  };

  const ended: Family[] = [];
  const removed: StoredTurn[] = [];

  function remove(family: Family) {
    for (const turn of family.turns) {
      family.owner.turns.splice(family.owner.turns.indexOf(turn), 1);
      removed.push(turn);
    }
  }

  for (const owner of agents.values()) {
    const families = new Map<string, Family>();

    for (const turn of owner.turns) {
      const family = families.get(turn.root) ?? {
        owner,
        turns: [],
        endedAt: 0,
        bytes: 0,
      };

      family.turns.push(turn);
      family.endedAt =
        family.endedAt === null || turn.endedAt === null
          ? null
          : Math.max(family.endedAt, turn.endedAt);
      families.set(turn.root, family);
    }

    let excess = families.size - limits.turnsPerAgent;

    for (const family of families.values()) {
      if (family.endedAt === null) {
        continue;
      }

      if (excess <= 0) {
        family.bytes = family.turns.reduce(
          (bytes, turn) => bytes + measuredBytes(turn, measure),
          0,
        );
        ended.push(family);

        continue;
      }

      remove(family);
      excess -= 1;
    }
  }

  // Drop a family over a global limit on its own before older families.
  const fitting = ended.filter((family) => {
    if (family.turns.length <= limits.turns && family.bytes <= limits.bytes) {
      return true;
    }

    remove(family);

    return false;
  });

  let bytes = fitting.reduce((sum, family) => sum + family.bytes, 0);
  // In-flight families do not spend the settled-turn budget.
  let turnCount = fitting.reduce((sum, family) => sum + family.turns.length, 0);
  fitting.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));

  for (const family of fitting) {
    if (turnCount <= limits.turns && bytes <= limits.bytes) {
      break;
    }

    remove(family);
    turnCount -= family.turns.length;
    bytes -= family.bytes;
  }

  for (const turn of removed) {
    turn.evicted?.();
  }
}

type TurnStart =
  | {
      kind: "root";
      requests: readonly ActivityRequest[];
      sessionId: string | undefined;
    }
  | {
      kind: "crew";
      session: CrewTurnStart["session"];
      task: CrewTurnStart["task"];
      startedAt: number | undefined;
      evicted: (() => void) | undefined;
    }
  | {
      kind: "child";
      parent: StoredTurn;
      callId: string | null;
      sessionId: string;
      requests: readonly ActivityRequest[];
    };

/** Keep only live inherited watches and the parent root's current watches. */
function unlinkedAudience(owner: Agent, parent: StoredTurn) {
  if (!owner.feed) {
    return;
  }

  const audience = new Set<symbol>();

  for (const [id, { turn }] of owner.feed.watchers) {
    if (turn === parent.root || parent.audience?.has(id)) {
      audience.add(id);
    }
  }

  return audience.size > 0 ? audience : undefined;
}

/**
 * How a turn begins: a child under its parent, or, if the drain before it
 * evicted that parent, unlinked: a root of its own that copies its family's
 * requests and keeps its live audience. A linked child shares the audience.
 */
function turnStart(owner: Agent, id: string, source: TurnStart) {
  if (source.kind === "root") {
    return {
      requests: source.requests,
      session: source.sessionId
        ? { id: source.sessionId, parent: null }
        : undefined,
      root: id,
    };
  }

  if (source.kind === "crew") {
    return { requests: [], session: source.session, root: id };
  }

  const { parent, callId, sessionId } = source;

  return owner.turns.includes(parent)
    ? {
        requests: [],
        session: { id: sessionId, parent: { turnId: parent.id, callId } },
        root: parent.root,
        audience: parent.audience,
      }
    : {
        requests: source.requests,
        session: { id: sessionId, parent: null },
        root: id,
        audience: unlinkedAudience(owner, parent),
      };
}

/** A settled turn's size, measured when it ends and after later changes. */
export function settledBytes(turn: StoredTurn) {
  try {
    return Buffer.byteLength(
      JSON.stringify({
        requests: turn.requests,
        session: turn.session,
        usage: usage(turn),
        task: turn.task,
        items: [...turn.items.values()].map((item) => itemJson(item)),
      }),
    );
  } catch {
    // Unmeasurable data cannot be retained inside a bounded settled family.
    return Infinity;
  }
}

/** A change that an evicted turn ignores. */
function live<A extends unknown[]>(
  gone: () => boolean,
  change: (...args: A) => void,
) {
  return (...args: A) => {
    if (!gone()) {
      change(...args);
    }
  };
}

/** One page of a retained item's JSON. */
function itemPage(
  owner: Agent | undefined,
  turnId: string,
  itemId: string,
  page: number,
): V1ActivityItemPage | undefined {
  const turn = owner?.turns.find(({ id }) => id === turnId);
  const stored = turn?.items.get(itemId);

  if (!owner || !stored) {
    return;
  }

  const json = JSON.stringify(itemJson(stored));
  const split = pages(json);
  const data = split[page];

  return data === undefined
    ? undefined
    : {
        agent: owner.agentId,
        ...(owner.member !== undefined && { member: owner.member }),
        turn: turnId,
        item: itemId,
        seq: stored.seq,
        page,
        pages: split.length,
        bytes: Buffer.byteLength(json),
        data,
      };
}

/**
 * Bounded in-memory officer turns for the Fleet API. Writers mutate in place
 * and never wait; readers copy. Eviction drops whole ended families only.
 */
export function createActivityHub(
  options: Partial<Limits> & {
    now?: () => number;
    /** A settled turn's size; tests count its calls. */
    measure?: typeof settledBytes;
  } = {},
) {
  const limits = { ...defaults, ...options };
  const now = options.now ?? Date.now;
  const measure = options.measure ?? settledBytes;
  /** Turn IDs stay unique across restarts. */
  const generation = `${now().toString(36)}${randomBytes(4).toString("hex")}`;
  /**
   * Only subjects with turns or watchers: one left with neither is
   * reclaimed, and one that reappears continues after `reclaimedSeq`.
   */
  const agents = new Map<string, Agent>();
  let reclaimedSeq = 0;
  /** Turn IDs are unique within a generation, across reclaimed subjects. */
  let turnIds = 0;
  /** Each ship's crew members with a peer session, while its plugin reports. */
  const crews = new Map<string, ReadonlySet<string>>();
  /** Each ship's newest recorder that wrote; older ones are fenced. */
  const owners = new Map<string, number>();
  const uncollected = new Map<string, ReadonlySet<string>>();
  let recorders = 0;

  const agent = (id: string) => {
    let result = agents.get(id);

    if (!result) {
      const [agentId = id, member] = id.split("/");
      result = { agentId, member, seq: reclaimedSeq, turns: [] };
      agents.set(id, result);
    }

    return result;
  };

  function reclaim() {
    for (const [id, owner] of agents) {
      if (owner.turns.length === 0 && !owner.feed) {
        reclaimedSeq = Math.max(reclaimedSeq, owner.seq);
        agents.delete(id);
      }
    }
  }

  /** Enforce retention against the current turns. */
  function retain() {
    evict(agents, limits, measure);
    reclaim();
  }

  const remeasure = remeasurer(retain, activityFlushMs);

  function begin(agentId: string, source: TurnStart): CrewTurnActivityLog {
    remeasure.drain();
    const owner = agent(agentId);
    const id = `${generation}-${(++turnIds).toString(36)}`;
    const start = turnStart(owner, id, source);
    const crew = source.kind === "crew" ? source : undefined;
    const family = source.kind === "crew" ? [] : source.requests;
    const startedAt = Math.min(crew?.startedAt ?? Infinity, now());

    owner.seq += 1;

    const turn: StoredTurn = {
      id,
      root: start.root,
      agent: agentId,
      seq: owner.seq,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      reconnects: 0,
      requests: start.requests.map(({ channel, msgid }) => ({
        channel,
        msgid,
      })),
      ...(start.session && { session: structuredClone(start.session) }),
      ...(crew && { task: structuredClone(crew.task) }),
      items: new Map(),
      ...(crew?.evicted && { evicted: crew.evicted }),
      ...(start.audience && { audience: start.audience }),
    };

    owner.turns.push(turn);
    retain();

    mark(generation, owner, `start:${turn.id}`, () => ({
      seq: turn.seq,
      at: startedAt,
      turn,
      change: { type: "turn-started", turn: turnSummary(turn) },
    }));

    const keys = new Map<string, StoredItem>();

    const touch = (at: number) => {
      delete turn.bytes;
      turn.seq = ++owner.seq;
      turn.updatedAt = Math.max(turn.updatedAt, at);

      return turn.seq;
    };

    const changed = (at: number) => {
      const seq = touch(at);

      mark(generation, owner, `turn:${turn.id}`, () => ({
        seq,
        at,
        turn,
        change: {
          type: turn.endedAt === null ? "turn-updated" : "turn-ended",
          turn: turnSummary(turn),
        },
      }));
    };

    /** A change after the end has the settled turn measured again, whole. */
    const resize = () => {
      remeasure(turn);
    };

    /** Evicted: it accepts no change and emits no event. */
    const gone = () => turn.endedAt !== null && !owner.turns.includes(turn);

    return {
      update: live(gone, (key, at, create, change) => {
        // Frames proven after the end still belong to the turn.

        try {
          let item = keys.get(key);

          if (!item) {
            item = {
              id: `i${keys.size + 1}`,
              seq: 0,
              startedAt: at,
              updatedAt: at,
              value: create(),
            };
            keys.set(key, item);
            turn.items.set(item.id, item);
          }

          delete turn.bytes;
          change?.(item.value);
          item.seq = touch(at);
          item.updatedAt = Math.max(item.updatedAt, at);

          const stored = item;

          mark(generation, owner, `item:${turn.id}:${item.id}`, () => ({
            seq: stored.seq,
            at,
            turn,
            change: stored,
          }));
        } catch {
          /* Never affects the turn. */
        }

        resize();
      }),
      reconnected: live(gone, () => {
        turn.reconnects += 1;
        changed(now());
        resize();
      }),
      setUsage: live(gone, (usage) => {
        turn.usage = usage;
        changed(now());
        resize();
      }),
      child(callId, sessionId) {
        return begin(agentId, {
          kind: "child",
          parent: turn,
          callId,
          sessionId,
          requests: family,
        });
      },
      attribute(task) {
        // Crew turns only, and once: a late task lookup succeeded.
        if (turn.task !== null || gone()) {
          return;
        }

        turn.task = structuredClone(task);
        const at = now();
        const seq = touch(at);

        // Its own upsert: it never replaces an end in the same flush, and
        // After the end it is still an update, not another end.
        mark(generation, owner, `task:${turn.id}`, () => ({
          seq,
          at,
          turn,
          change: { type: "turn-updated", turn: turnSummary(turn) },
        }));
        resize();
      },
      end(outcome: ActivityOutcome, lost?: true) {
        if (turn.endedAt !== null) {
          return;
        }

        remeasure.drain();
        const at = now();
        turn.status = outcome;

        if (outcome === "cancelled" && lost) {
          turn.lost = true;
        }

        turn.endedAt = at;
        changed(at);
        retain();
      },
      retained: () => owner.turns.includes(turn),
    };
  }

  return {
    generation,
    /**
     * Coalesced changes for one agent, flushed by a timer: writers never
     * wait for a watcher. Returns the call that stops watching.
     */
    watch(agentId: string, notify: ActivityWatcher, turn?: string) {
      return watchAgent(agent(agentId), { turn, notify }, reclaim);
    },
    recorder(agentId: string): TurnActivityRecorder {
      return {
        begin: (requests, sessionId) =>
          begin(agentId, { kind: "root", requests: requests ?? [], sessionId }),
      };
    },
    /** One captain registration's crew turns, each under its member. */
    crewRecorder: (ship: string) =>
      crewRecorder(
        ship,
        ++recorders,
        { owners, crews, uncollected },
        (start, startedAt, evicted) =>
          begin(crewSubject(ship, start.member), {
            kind: "crew",
            session: start.session,
            task: start.task,
            startedAt,
            evicted,
          }),
      ),
    /** A ship's reporting crew members; undefined while not collected. */
    crew(ship: string) {
      return crews.get(ship);
    },
    /** A ship's known crew members whose turns are not collected. */
    uncollected: (ship: string) => uncollected.get(ship),
    /** Whether a subject retains any turn. */
    retains(agentId: string) {
      return (agents.get(agentId)?.turns.length ?? 0) > 0;
    },
    /** Subjects held: each has retained turns or a watcher. */
    get subjects() {
      return agents.size;
    },
    hasTurn(agentId: string, turnId: string) {
      return (
        agents.get(agentId)?.turns.some((turn) => turn.id === turnId) ?? false
      );
    },
    page: (agentId: string, turnId: string, itemId: string, page: number) =>
      itemPage(agents.get(agentId), turnId, itemId, page),
    /** All retained turns, one by ID, or families matching an IRC request. */
    turns(agentId: string, selector?: TurnSelector) {
      const owner = agents.get(agentId);
      const selected = selectTurns(owner?.turns ?? [], selector);

      if (selector !== undefined && selected.length === 0) {
        return;
      }

      return {
        turns: selected.map((turn) => turnJson(turn)),
        cursor: { generation, seq: owner?.seq ?? reclaimedSeq },
      };
    },
  };
}

export type ActivityHub = ReturnType<typeof createActivityHub>;

function registration(config: ApiV1Config, id: string) {
  const bot = config.bots.find((entry) => entry.id === id);

  if (bot) {
    return { role: "captain" as const, backend: bot.backend.type };
  }

  const other =
    config.irc?.find((entry) => entry.id === id) ??
    config.teams?.find((entry) => entry.id === id);

  return (
    other && {
      role:
        other.fleetPolicy?.role === "rear_admiral"
          ? ("rear_admiral" as const)
          : ("captain" as const),
      backend: other.backend.type,
    }
  );
}

const parameters = {
  turn: /^[a-z0-9]{1,40}-[a-z0-9]{1,16}$/,
  item: /^i[1-9][0-9]{0,8}$/,
  page: /^(?:0|[1-9][0-9]{0,8})$/,
  /** Same printable wire msgid bounds as IRC intake. */
  request: /^[!-~]{1,128}$/,
  /** Intentionally unanchored: require at least one character of any kind. */
  channel: /[\s\S]/,
} as const;

type Parameter = keyof typeof parameters;

const isParameter = (key: string): key is Parameter =>
  Object.hasOwn(parameters, key);

export type ActivityRead =
  | { status: 400 | 404 }
  | { status: 200; body: V1AgentActivity | V1ActivityItemPage };

type ActivityQuery = Partial<Record<Parameter, string>>;

/** Every parameter is validated; unknown or repeated ones are rejected. */
function activityQuery(query: URLSearchParams): ActivityQuery | undefined {
  const values: ActivityQuery = {};

  for (const [key, value] of query) {
    if (!isParameter(key) || key in values || !parameters[key].test(value)) {
      return;
    }

    values[key] = value;
  }

  if (
    (values.item !== undefined && values.turn === undefined) ||
    (values.page !== undefined && values.item === undefined) ||
    (values.channel !== undefined &&
      (values.request === undefined ||
        Buffer.byteLength(values.channel) > 512)) ||
    (values.request !== undefined && values.turn !== undefined)
  ) {
    return;
  }

  return values;
}

/** One subject's snapshot, turn, request match or item page. */
function readSubject(
  hub: ActivityHub,
  subject: string,
  agent: V1AgentActivity["agent"],
  values: ActivityQuery,
): ActivityRead {
  if (values.turn !== undefined && values.item !== undefined) {
    const page = hub.page(
      subject,
      values.turn,
      values.item,
      Number(values.page ?? 0),
    );

    return page ? { status: 200, body: page } : { status: 404 };
  }

  const snapshot = hub.turns(
    subject,
    values.request === undefined
      ? values.turn
      : { msgid: values.request, channel: values.channel },
  );

  return snapshot
    ? { status: 200, body: { agent, ...snapshot } }
    : { status: 404 };
}

/**
 * `GET /api/v1/agents/{id}/activity` with a turn/item/page or IRC request
 * selector.
 */
export function readActivity(
  hub: ActivityHub,
  config: ApiV1Config,
  agentId: string,
  query: URLSearchParams,
): ActivityRead {
  const values = activityQuery(query);

  if (!values) {
    return { status: 400 };
  }

  const agent = registration(config, agentId);

  if (!agent) {
    return { status: 404 };
  }

  return readSubject(
    hub,
    agentId,
    {
      id: agentId,
      role: agent.role,
      backend: agent.backend,
      collected: agent.backend === "opencode" || agent.backend === "claude",
      ...(agent.backend === "claude" && {
        unavailable: ["step.cost", "step.tokens.reasoning"],
      }),
    },
    values,
  );
}

const agentParameter = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A crew member of a captain registration. While its crew plugin reports,
 * `collected` follows the member's current configured backend: a configured
 * OpenCode member is collected, with or without a peer session, and a member
 * now on another backend, such as Pi, is not, though its retained turns stay
 * readable. Only a member that is neither configured, a peer nor retained
 * answers 404. Before the plugin answers, or for an older plugin, any member
 * reads as not collected.
 */
function crewMember(
  hub: ActivityHub,
  config: ApiV1Config,
  ship: string,
  member: string,
) {
  const captain = registration(config, ship);
  const roster = hub.crew(ship);

  // A rear admiral has no crew of its own.
  if (captain?.role !== "captain" || !agentParameter.test(member)) {
    return;
  }

  if (!roster) {
    return { captain, collected: false };
  }

  // The current configured backend wins over retained turns.
  if (hub.uncollected(ship)?.has(member)) {
    return { captain, collected: false };
  }

  return roster.has(member) || hub.retains(crewSubject(ship, member))
    ? { captain, collected: true }
    : undefined;
}

/**
 * `GET /api/v1/ships/{ship}/crew/{member}/activity`: the officer route's
 * parameters and errors, for one crew member's worker turns.
 */
export function readCrewActivity(
  hub: ActivityHub,
  config: ApiV1Config,
  ship: string,
  member: string,
  query: URLSearchParams,
): ActivityRead {
  const values = activityQuery(query);

  if (!values) {
    return { status: 400 };
  }

  const crew = crewMember(hub, config, ship, member);

  if (!crew) {
    return { status: 404 };
  }

  return readSubject(
    hub,
    crewSubject(ship, member),
    {
      id: ship,
      role: crew.captain.role,
      backend: crew.captain.backend,
      collected: crew.collected,
      member,
    },
    values,
  );
}

/** Distinct subjects, officers and crew members, one event stream may follow. */
export const maxActivityAgents = 8;

const crewParameter =
  /^([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9_-]{0,63})$/;

type Watch = (send: (bytes: Uint8Array) => void) => () => void;

export type ActivitySubscribe =
  | { status: 400 | 404 }
  | { status: 200; watch: Watch };

/**
 * `GET /api/v1/events?agent=<id>&crew=<ship>/<member>…[&turn=<id>]`. Checked
 * before a viewer place is taken: anything but distinct, well-formed `agent`
 * and `crew` values (at most eight together) and one `turn` with exactly one
 * subject is 400; an agent that is not a registration, a crew member the
 * route would not serve, or a turn its subject no longer has, is 404. A
 * scoped watch follows the turn, its family if it is a root, and children
 * admitted unlinked from that family while the watch stays open.
 */
export function subscribeActivity(
  hub: ActivityHub,
  config: ApiV1Config,
  query: URLSearchParams,
): ActivitySubscribe {
  const agents: string[] = [];
  const crews: { ship: string; member: string }[] = [];
  let turn: string | undefined;

  for (const [key, value] of query) {
    const crew = key === "crew" ? crewParameter.exec(value) : null;

    const subject =
      key === "agent" && agentParameter.test(value)
        ? value
        : crew?.[1] !== undefined && crew[2] !== undefined
          ? crewSubject(crew[1], crew[2])
          : undefined;

    if (
      subject !== undefined &&
      !agents.includes(subject) &&
      agents.length < maxActivityAgents
    ) {
      agents.push(subject);

      if (crew?.[1] !== undefined && crew[2] !== undefined) {
        crews.push({ ship: crew[1], member: crew[2] });
      }
    } else if (
      key === "turn" &&
      turn === undefined &&
      parameters.turn.test(value)
    ) {
      turn = value;
    } else {
      return { status: 400 };
    }
  }

  const [first] = agents;

  if (first === undefined || (turn !== undefined && agents.length !== 1)) {
    return { status: 400 };
  }

  if (
    agents.some((id) => !id.includes("/") && !registration(config, id)) ||
    crews.some(({ ship, member }) => !crewMember(hub, config, ship, member)) ||
    (turn !== undefined && !hub.hasTurn(first, turn))
  ) {
    return { status: 404 };
  }

  return {
    status: 200,
    watch(send) {
      const stops = agents.map((id) =>
        hub.watch(
          id,
          (frames) => {
            // One frame at a time, each within the viewer's queue.
            for (const frame of frames) {
              send(frame.bytes);
            }
          },
          turn,
        ),
      );

      return () => {
        for (const stop of stops) {
          stop();
        }
      };
    },
  };
}

/** The Fleet API's view of the hub: snapshot reads and stream subscriptions. */
export type ActivityApi = {
  read(agentId: string, query: URLSearchParams): ActivityRead;
  /** Absent, the crew route answers 404. */
  readCrew?(ship: string, member: string, query: URLSearchParams): ActivityRead;
  subscribe(query: URLSearchParams): ActivitySubscribe;
};

export function activityApi(
  hub: ActivityHub,
  config: () => ApiV1Config,
): ActivityApi {
  return {
    read: (agentId, query) => readActivity(hub, config(), agentId, query),
    readCrew: (ship, member, query) =>
      readCrewActivity(hub, config(), ship, member, query),
    subscribe: (query) => subscribeActivity(hub, config(), query),
  };
}
