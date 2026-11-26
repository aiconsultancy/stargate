import type {
  ActivityItem,
  ActivityRequest,
  ActivityUsage,
} from "../../../../backends/backend";
import type {
  V1ActivityItem,
  V1ActivityPagedItem,
  V1ActivityTurn,
  V1ActivityTurnSummary,
  V1ActivityUsage,
} from "./types";

/** Items whose JSON is larger are served in pages of at most this size. */
export const activityPageBytes = 64 * 1024;

export type StoredItem = {
  id: string;
  seq: number;
  startedAt: number;
  updatedAt: number;
  value: ActivityItem;
};

export type StoredTurn = {
  id: string;
  root: string;
  agent: string;
  seq: number;
  status: V1ActivityTurn["status"];
  lost?: true;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  reconnects: number;
  requests: ActivityRequest[];
  session?: V1ActivityTurn["session"];
  usage?: ActivityUsage;
  items: Map<string, StoredItem>;
  /** Cached serialized size; a write invalidates it. */
  bytes?: number;
};

export function itemJson(item: StoredItem): V1ActivityItem {
  return {
    id: item.id,
    seq: item.seq,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    ...structuredClone(item.value),
  };
}

export function usage(turn: StoredTurn): V1ActivityUsage | null {
  if (turn.usage) {
    return structuredClone(turn.usage);
  }

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
export function pages(json: string, limit = activityPageBytes) {
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
export function itemView(
  stored: StoredItem,
): V1ActivityItem | V1ActivityPagedItem {
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
    ...(item.unavailable && { unavailable: item.unavailable }),
    ...(item.kind === "tool" && { callId: item.callId, name: item.name }),
    paged: { pages: pages(json).length, bytes },
  };
}

export function turnSummary(turn: StoredTurn): V1ActivityTurnSummary {
  return {
    id: turn.id,
    seq: turn.seq,
    status: turn.status,
    ...(turn.lost && { lost: turn.lost }),
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    endedAt: turn.endedAt,
    reconnects: turn.reconnects,
    requests: turn.requests.map((request) => ({ ...request })),
    ...(turn.session && { session: structuredClone(turn.session) }),
    usage: usage(turn),
  };
}

export function turnJson(turn: StoredTurn): V1ActivityTurn {
  return {
    ...turnSummary(turn),
    items: [...turn.items.values()].map((stored) => itemView(stored)),
  };
}
