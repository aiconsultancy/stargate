import { randomBytes } from "node:crypto";
import type {
  ActivityItem,
  ActivityOutcome,
  TurnActivityLog,
  TurnActivityRecorder,
} from "../../../../backends/backend";
import type { ApiV1Config } from "./features";
import type {
  V1ActivityItem,
  V1ActivityItemPage,
  V1ActivityPagedItem,
  V1ActivityTurn,
  V1ActivityUsage,
  V1AgentActivity,
} from "./types";

/** Items whose JSON is larger are served in pages of at most this size. */
export const activityPageBytes = 64 * 1024;

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
  items: Map<string, StoredItem>;
  /** Serialized size, measured once when the turn ends. */
  bytes: number;
};

type Agent = { seq: number; turns: StoredTurn[] };

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

function turnJson(turn: StoredTurn): V1ActivityTurn {
  return {
    id: turn.id,
    seq: turn.seq,
    status: turn.status,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    endedAt: turn.endedAt,
    reconnects: turn.reconnects,
    usage: usage(turn),
    items: [...turn.items.values()].map((stored) => {
      const item = itemJson(stored);
      const json = JSON.stringify(item);
      const bytes = Buffer.byteLength(json);

      if (bytes <= activityPageBytes) {
        return item;
      }

      const paged: V1ActivityPagedItem = {
        id: item.id,
        seq: item.seq,
        startedAt: item.startedAt,
        updatedAt: item.updatedAt,
        kind: item.kind,
        status: item.status,
        ...(item.kind === "tool" && { callId: item.callId, name: item.name }),
        paged: { pages: pages(json).length, bytes },
      };

      return paged;
    }),
  };
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

  function begin(agentId: string): TurnActivityLog {
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
      items: new Map(),
      bytes: 0,
    };

    owner.turns.push(turn);
    turnCount += 1;
    evict();
    const keys = new Map<string, StoredItem>();

    const touch = (at: number) => {
      turn.seq = ++owner.seq;
      turn.updatedAt = Math.max(turn.updatedAt, at);

      return turn.seq;
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
        } catch {
          /* Never affects the turn. */
        }
      },
      reconnected() {
        turn.reconnects += 1;
        touch(now());
      },
      end(outcome: ActivityOutcome) {
        if (turn.endedAt !== null) {
          return;
        }

        const at = now();
        turn.status = outcome;
        turn.endedAt = at;
        touch(at);

        try {
          turn.bytes = Buffer.byteLength(
            JSON.stringify(
              [...turn.items.values()].map((item) => itemJson(item)),
            ),
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
    recorder(agentId: string): TurnActivityRecorder {
      return { begin: () => begin(agentId) };
    },
    /** Every retained turn, or one; undefined when that turn is gone. */
    turns(agentId: string, turnId?: string) {
      const owner = agents.get(agentId);

      const selected = (owner?.turns ?? []).filter(
        (turn) => turnId === undefined || turn.id === turnId,
      );

      if (turnId !== undefined && selected.length === 0) {
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
} as const;

type Parameter = keyof typeof parameters;

const isParameter = (key: string): key is Parameter =>
  Object.hasOwn(parameters, key);

export type ActivityRead =
  | { status: 400 | 404 }
  | { status: 200; body: V1AgentActivity | V1ActivityItemPage };

/**
 * `GET /api/v1/agents/{id}/activity[?turn=[&item=[&page=]]]`. Every query
 * parameter is validated; unknown or repeated ones are rejected.
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
    (values.page !== undefined && values.item === undefined)
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

  const snapshot = hub.turns(agentId, values.turn);

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
