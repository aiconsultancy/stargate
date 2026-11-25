import { randomBytes } from "node:crypto";
import type {
  ActivityItem,
  ActivityOutcome,
  ActivityRequest,
  TurnActivityLog,
  TurnActivityRecorder,
} from "../../../../backends/backend";
import type { ApiV1Config } from "./features";
import type {
  V1ActivityItem,
  V1ActivityItemPage,
  V1ActivityPagedItem,
  V1ActivityTurn,
  V1ActivityTurnSummary,
  V1ActivityUsage,
  V1AgentActivity,
  V1AgentActivityChange,
  V1AgentActivityEvent,
} from "./types";

/** Channel selectors fold ASCII letters only, not Unicode or IRC punctuation. */
const foldActivityChannel = (value: string) =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Items whose JSON is larger are served in pages of at most this size. */
export const activityPageBytes = 64 * 1024;

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

type StoredItem = {
  id: string;
  seq: number;
  startedAt: number;
  updatedAt: number;
  value: ActivityItem;
};

type StoredTurn = {
  id: string;
  agent: string;
  seq: number;
  status: V1ActivityTurn["status"];
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  reconnects: number;
  requests: ActivityRequest[];
  items: Map<string, StoredItem>;
  /** Serialized size, measured once when the turn ends. */
  bytes: number;
};

/** One coalesced change, encoded once for every viewer of its agent. */
export type ActivityFrame = { turnId: string; seq: number; bytes: Uint8Array };

type ActivityWatcher = (frames: readonly ActivityFrame[]) => void;

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
  watchers: Set<ActivityWatcher>;
  pending: Map<string, Pending>;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type Agent = { seq: number; turns: StoredTurn[]; feed?: Feed | undefined };

const encoder = new TextEncoder();

function itemJson(item: StoredItem): V1ActivityItem {
  return {
    id: item.id,
    seq: item.seq,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    ...structuredClone(item.value),
  };
}

function usage(turn: StoredTurn): V1ActivityUsage | null {
  let result: V1ActivityUsage | null = null;

  for (const { value } of turn.items.values()) {
    if (value.kind !== "step" || !value.tokens) {
      continue;
    }

    result ??= {
      steps: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      cost: 0,
    };
    result.steps += 1;
    result.cost += value.cost ?? 0;

    for (const key of Object.keys(
      result.tokens,
    ) as (keyof typeof value.tokens)[]) {
      result.tokens[key] += value.tokens[key];
    }
  }

  return result;
}

/** Splits at code points so every page is valid text of at most `limit` bytes. */
function pages(json: string, limit = activityPageBytes) {
  const result: string[] = [];
  let start = 0;
  let bytes = 0;

  for (let index = 0; index < json.length;) {
    const code = json.codePointAt(index) ?? 0;

    const width =
      code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;

    const units = code > 0xff_ff ? 2 : 1;

    if (bytes + width > limit) {
      result.push(json.slice(start, index));
      start = index;
      bytes = 0;
    }

    bytes += width;
    index += units;
  }

  result.push(json.slice(start));

  return result;
}

/** The item, or its identity and page count when its JSON is over 64 KiB. */
function itemView(stored: StoredItem): V1ActivityItem | V1ActivityPagedItem {
  const item = itemJson(stored);
  const json = JSON.stringify(item);
  const bytes = Buffer.byteLength(json);

  if (bytes <= activityPageBytes) {
    return item;
  }

  return {
    id: item.id,
    seq: item.seq,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    kind: item.kind,
    status: item.status,
    ...(item.kind === "tool" && { callId: item.callId, name: item.name }),
    paged: { pages: pages(json).length, bytes },
  };
}

function turnSummary(turn: StoredTurn): V1ActivityTurnSummary {
  return {
    id: turn.id,
    seq: turn.seq,
    status: turn.status,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    endedAt: turn.endedAt,
    reconnects: turn.reconnects,
    requests: turn.requests.map((request) => ({ ...request })),
    usage: usage(turn),
  };
}

function turnJson(turn: StoredTurn): V1ActivityTurn {
  return {
    ...turnSummary(turn),
    items: [...turn.items.values()].map((stored) => itemView(stored)),
  };
}

function changeOf({ change }: Pending): V1AgentActivityChange {
  return "type" in change ? change : { type: "item", item: itemView(change) };
}

/** Send an agent's coalesced changes to everyone watching it. */
function flush(generation: string, agentId: string, owner: Agent) {
  const feed = owner.feed;

  if (!feed) {
    return;
  }

  feed.timer = undefined;
  const due = [...feed.pending.values()].toSorted((a, b) => a.seq - b.seq);
  feed.pending.clear();
  const frames: ActivityFrame[] = [];

  // An evicted turn still gets the changes marked before, such as its end.
  // Eviction is never announced, so viewers keep their own cap.
  for (const pending of due) {
    try {
      const data: V1AgentActivityEvent = {
        agentId,
        turnId: pending.turn.id,
        generation,
        seq: pending.seq,
        at: pending.at,
        change: changeOf(pending),
      };

      frames.push({
        turnId: pending.turn.id,
        seq: pending.seq,
        bytes: encoder.encode(
          `event: agent-activity\ndata: ${JSON.stringify(data)}\n\n`,
        ),
      });
    } catch {
      /* An unserializable value never stops the stream. */
    }
  }

  for (const watcher of feed.watchers) {
    try {
      watcher(frames);
    } catch {
      /* A viewer never affects the agent or other viewers. */
    }
  }
}

/** Note a change for the next flush; nothing at all when unwatched. */
function mark(
  generation: string,
  agentId: string,
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
      flush(generation, agentId, owner);
    }, activityFlushMs);
    feed.timer.unref?.();
  }
}

/**
 * Bounded in-memory officer turns for the Fleet API. Writers mutate in place
 * and never wait; readers copy. Eviction drops whole ended turns only.
 */
export function createActivityHub(
  options: Partial<Limits> & { now?: () => number } = {},
) {
  const limits = { ...defaults, ...options };
  const now = options.now ?? Date.now;
  /** Turn IDs stay unique across restarts. */
  const generation = `${now().toString(36)}${randomBytes(4).toString("hex")}`;
  const agents = new Map<string, Agent>();
  let turnCount = 0;

  const agent = (id: string) => {
    let result = agents.get(id);

    if (!result) {
      result = { seq: 0, turns: [] };
      agents.set(id, result);
    }

    return result;
  };

  function watch(agentId: string, watcher: ActivityWatcher) {
    const owner = agent(agentId);

    owner.feed ??= {
      watchers: new Set(),
      pending: new Map(),
      timer: undefined,
    };
    const feed = owner.feed;
    feed.watchers.add(watcher);

    return () => {
      feed.watchers.delete(watcher);

      if (feed.watchers.size === 0 && owner.feed === feed) {
        clearTimeout(feed.timer);
        owner.feed = undefined;
      }
    };
  }

  function remove(owner: Agent, turn: StoredTurn) {
    owner.turns.splice(owner.turns.indexOf(turn), 1);
    turnCount -= 1;
  }

  /** Bound memory by count and size only; no turn expires with time. */
  function evict() {
    for (const owner of agents.values()) {
      // Running turns stay; a full agent drops its oldest ended turns.
      for (const turn of owner.turns.filter((turn) => turn.endedAt !== null)) {
        if (owner.turns.length <= limits.turnsPerAgent) {
          break;
        }

        remove(owner, turn);
      }
    }

    const ended = [...agents.values()]
      .flatMap((owner) =>
        owner.turns
          .filter((turn) => turn.endedAt !== null)
          .map((turn) => ({ owner, turn })),
      )
      .toSorted((a, b) => (a.turn.endedAt ?? 0) - (b.turn.endedAt ?? 0));

    let bytes = ended.reduce((sum, { turn }) => sum + turn.bytes, 0);

    for (const { owner, turn } of ended) {
      if (turnCount <= limits.turns && bytes <= limits.bytes) {
        break;
      }

      remove(owner, turn);
      bytes -= turn.bytes;
    }
  }

  function begin(
    agentId: string,
    requests: readonly ActivityRequest[] = [],
  ): TurnActivityLog {
    const owner = agent(agentId);
    const startedAt = now();

    const turn: StoredTurn = {
      id: `${generation}-${(++owner.seq).toString(36)}`,
      agent: agentId,
      seq: owner.seq,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      reconnects: 0,
      requests: requests.map(({ channel, msgid }) => ({ channel, msgid })),
      items: new Map(),
      bytes: 0,
    };

    owner.turns.push(turn);
    turnCount += 1;
    evict();

    mark(generation, agentId, owner, `start:${turn.id}`, () => ({
      seq: turn.seq,
      at: startedAt,
      turn,
      change: { type: "turn-started", turn: turnSummary(turn) },
    }));

    const keys = new Map<string, StoredItem>();

    const touch = (at: number) => {
      turn.seq = ++owner.seq;
      turn.updatedAt = Math.max(turn.updatedAt, at);

      return turn.seq;
    };

    const changed = (at: number) => {
      const seq = touch(at);

      mark(generation, agentId, owner, `turn:${turn.id}`, () => ({
        seq,
        at,
        turn,
        change: {
          type: turn.endedAt === null ? "turn-updated" : "turn-ended",
          turn: turnSummary(turn),
        },
      }));
    };

    return {
      update(key, at, create, change) {
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

          change?.(item.value);
          item.seq = touch(at);
          item.updatedAt = Math.max(item.updatedAt, at);

          const stored = item;

          mark(
            generation,
            agentId,
            owner,
            `item:${turn.id}:${item.id}`,
            () => ({
              seq: stored.seq,
              at,
              turn,
              change: stored,
            }),
          );
        } catch {
          /* Never affects the turn. */
        }
      },
      reconnected() {
        turn.reconnects += 1;
        changed(now());
      },
      end(outcome: ActivityOutcome) {
        if (turn.endedAt !== null) {
          return;
        }

        const at = now();
        turn.status = outcome;
        turn.endedAt = at;
        changed(at);

        try {
          turn.bytes = Buffer.byteLength(
            JSON.stringify({
              requests: turn.requests,
              items: [...turn.items.values()].map((item) => itemJson(item)),
            }),
          );
        } catch {
          turn.bytes = 0;
        }

        evict();
      },
    };
  }

  return {
    generation,
    /**
     * Coalesced changes for one agent, flushed by a timer: writers never
     * wait for a watcher. Returns the call that stops watching.
     */
    watch,
    recorder(agentId: string): TurnActivityRecorder {
      return { begin: (requests) => begin(agentId, requests) };
    },
    hasTurn(agentId: string, turnId: string) {
      return (
        agents.get(agentId)?.turns.some((turn) => turn.id === turnId) ?? false
      );
    },
    /** All retained turns, one by ID, or every turn matching an IRC request. */
    turns(
      agentId: string,
      selector?: string | { msgid: string; channel: string | undefined },
    ) {
      const owner = agents.get(agentId);

      const channelKey =
        typeof selector === "object" && selector.channel !== undefined
          ? foldActivityChannel(selector.channel)
          : undefined;

      const selected = (owner?.turns ?? []).filter((turn) => {
        if (typeof selector === "string") {
          return turn.id === selector;
        }

        return (
          selector === undefined ||
          turn.requests.some(
            ({ channel, msgid }) =>
              msgid === selector.msgid &&
              (channelKey === undefined ||
                foldActivityChannel(channel) === channelKey),
          )
        );
      });

      if (selector !== undefined && selected.length === 0) {
        return;
      }

      return {
        turns: selected.map((turn) => turnJson(turn)),
        cursor: { generation, seq: owner?.seq ?? 0 },
      };
    },
    page(
      agentId: string,
      turnId: string,
      itemId: string,
      page: number,
    ): V1ActivityItemPage | undefined {
      const turn = agents.get(agentId)?.turns.find(({ id }) => id === turnId);
      const stored = turn?.items.get(itemId);

      if (!stored) {
        return;
      }

      const json = JSON.stringify(itemJson(stored));
      const split = pages(json);
      const data = split[page];

      return data === undefined
        ? undefined
        : {
            agent: agentId,
            turn: turnId,
            item: itemId,
            seq: stored.seq,
            page,
            pages: split.length,
            bytes: Buffer.byteLength(json),
            data,
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

/**
 * `GET /api/v1/agents/{id}/activity` with a turn/item/page or IRC request
 * selector. Every parameter is validated; unknown or repeated ones are rejected.
 */
export function readActivity(
  hub: ActivityHub,
  config: ApiV1Config,
  agentId: string,
  query: URLSearchParams,
): ActivityRead {
  const values: Partial<Record<Parameter, string>> = {};

  for (const [key, value] of query) {
    if (!isParameter(key) || key in values || !parameters[key].test(value)) {
      return { status: 400 };
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
    return { status: 400 };
  }

  const agent = registration(config, agentId);

  if (!agent) {
    return { status: 404 };
  }

  if (values.turn !== undefined && values.item !== undefined) {
    const page = hub.page(
      agentId,
      values.turn,
      values.item,
      Number(values.page ?? 0),
    );

    return page ? { status: 200, body: page } : { status: 404 };
  }

  const snapshot = hub.turns(
    agentId,
    values.request === undefined
      ? values.turn
      : { msgid: values.request, channel: values.channel },
  );

  if (!snapshot) {
    return { status: 404 };
  }

  return {
    status: 200,
    body: {
      agent: {
        id: agentId,
        role: agent.role,
        backend: agent.backend,
        collected: agent.backend === "opencode",
      },
      ...snapshot,
    },
  };
}

/** Distinct agents one event stream may follow. */
export const maxActivityAgents = 8;

const agentParameter = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type Watch = (send: (bytes: Uint8Array) => void) => () => void;

export type ActivitySubscribe =
  | { status: 400 | 404 }
  | { status: 200; watch: Watch };

/**
 * `GET /api/v1/events?agent=<id>[&agent=<id>…][&turn=<id>]`. Checked before a
 * viewer place is taken: anything but distinct, well-formed `agent` values
 * (at most eight) and one `turn` with exactly one agent is 400; an agent that
 * is not a registration, or a turn it no longer has, is 404.
 */
export function subscribeActivity(
  hub: ActivityHub,
  config: ApiV1Config,
  query: URLSearchParams,
): ActivitySubscribe {
  const agents: string[] = [];
  let turn: string | undefined;

  for (const [key, value] of query) {
    if (
      key === "agent" &&
      agentParameter.test(value) &&
      !agents.includes(value) &&
      agents.length < maxActivityAgents
    ) {
      agents.push(value);
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
    agents.some((id) => !registration(config, id)) ||
    (turn !== undefined && !hub.hasTurn(first, turn))
  ) {
    return { status: 404 };
  }

  return {
    status: 200,
    watch(send) {
      const stops = agents.map((id) =>
        hub.watch(id, (frames) => {
          const chosen =
            turn === undefined
              ? frames
              : frames.filter((frame) => frame.turnId === turn);

          // One frame at a time, each within the viewer's queue.
          for (const frame of chosen) {
            send(frame.bytes);
          }
        }),
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
  subscribe(query: URLSearchParams): ActivitySubscribe;
};

export function activityApi(
  hub: ActivityHub,
  config: () => ApiV1Config,
): ActivityApi {
  return {
    read: (agentId, query) => readActivity(hub, config(), agentId, query),
    subscribe: (query) => subscribeActivity(hub, config(), query),
  };
}
