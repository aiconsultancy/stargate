import type { StoredTurn } from "./activity-view";

type Limits = { turnsPerAgent: number; turns: number; bytes: number };

type Measure = (turn: StoredTurn) => number;

/** Eviction consumes and clears all registered callbacks before calling them. */
export function notifyEviction(turn: StoredTurn, notify: () => void) {
  const existing = turn.evicted;
  turn.evicted = () => {
    existing?.();
    notify();
  };
}

/** A turn's cached size, measured again after a write cleared it. */
function measuredBytes(turn: StoredTurn, measure: Measure) {
  return (turn.bytes ??= measure(turn));
}

/**
 * Evict settled families together so a retained child never loses its
 * parent, then tell each evicted turn's writer: every path evicts here.
 */
export function evict(
  agents: ReadonlyMap<string, { turns: StoredTurn[] }>,
  limits: Limits,
  measure: Measure,
) {
  type Family = {
    owner: { turns: StoredTurn[] };
    turns: StoredTurn[];
    endedAt: number | null;
    bytes: number;
    quotaRoot: boolean;
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
        quotaRoot: true,
      };

      family.turns.push(turn);

      if (turn.unattributedChild) {
        family.quotaRoot = false;
      }

      family.endedAt =
        family.endedAt === null || turn.endedAt === null
          ? null
          : Math.max(family.endedAt, turn.endedAt);
      families.set(turn.root, family);
    }

    let excess =
      [...families.values()].filter((family) => family.quotaRoot).length -
      limits.turnsPerAgent;

    for (const family of families.values()) {
      if (family.endedAt === null) {
        continue;
      }

      // Ambiguous children still spend the global turn and byte budget.
      if (excess <= 0 || !family.quotaRoot) {
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
    const notify = turn.evicted;
    delete turn.evicted;
    notify?.();
  }
}
