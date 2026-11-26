import type {
  CrewTurnActivityLog,
  CrewTurnRecorder,
  CrewTurnStart,
} from "../../../../backends/backend";

/** What a fenced recorder begins: it writes nothing. */
const fencedLog: CrewTurnActivityLog = {
  update() {
    /* Fenced. */
  },
  reconnected() {
    /* Fenced. */
  },
  end() {
    /* Fenced. */
  },
  attribute() {
    /* Fenced. */
  },
  retained: () => false,
};

/** Every ship's crew recorders: the newest that wrote, and current rosters. */
export type CrewRecorders = {
  owners: Map<string, number>;
  crews: Map<string, ReadonlySet<string>>;
  /** Known members whose turns are not collected, such as Pi workers. */
  uncollected: Map<string, ReadonlySet<string>>;
};

/**
 * One captain backend's crew recorder. It owns the ship's crew subjects from
 * its first write until a newer recorder (a replacement backend) writes;
 * fenced, it begins nothing and leaves the roster alone, and the turns it
 * began still settle.
 */
export function crewRecorder(
  ship: string,
  token: number,
  recorders: CrewRecorders,
  begin: (
    start: CrewTurnStart,
    startedAt?: number,
    evicted?: () => void,
  ) => CrewTurnActivityLog,
): CrewTurnRecorder {
  const owns = () => {
    if (token < (recorders.owners.get(ship) ?? 0)) {
      return false;
    }

    recorders.owners.set(ship, token);

    return true;
  };

  return {
    begin: (start, startedAt, evicted) =>
      owns() ? begin(start, startedAt, evicted) : fencedLog,
    roster(members, uncollected = []) {
      if (!owns()) {
        return;
      }

      if (members) {
        recorders.crews.set(ship, new Set(members));
        recorders.uncollected.set(ship, new Set(uncollected));
      } else {
        recorders.crews.delete(ship);
        recorders.uncollected.delete(ship);
      }
    },
  };
}
