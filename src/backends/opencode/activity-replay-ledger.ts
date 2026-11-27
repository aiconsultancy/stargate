const maxSequenceRuns = 8192;
const maxActiveDeltas = 8192;
const maxLateDeltas = 64;
const maxDeltaIDLength = 1024;

const canonicalUUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** IDs too costly to keep still project; only exact retained IDs suppress output. */
export class ActivityDeltaWindow {
  private readonly keys = new Set<string | bigint>();

  public constructor(private readonly late = false) {}

  public duplicate(id: string) {
    if (id.length > maxDeltaIDLength) {
      return false;
    }

    const key =
      id.length === 36 && canonicalUUID.test(id)
        ? BigInt(`0x${id.replaceAll("-", "")}`)
        : id;

    if (this.keys.has(key)) {
      return true;
    }

    if (this.keys.size === (this.late ? maxLateDeltas : maxActiveDeltas)) {
      const oldest = this.keys.values().next().value;

      if (oldest !== undefined) {
        this.keys.delete(oldest);
      }
    }

    this.keys.add(key);

    return false;
  }

  public settled() {
    const late = new ActivityDeltaWindow(true);

    for (const key of this.keys
      .values()
      .drop(Math.max(0, this.keys.size - maxLateDeltas))) {
      late.keys.add(key);
    }

    return late;
  }
}

/** Exact replay detection for an execution, independent of its owner. */
export class ActivitySequenceWindow {
  // Sorted inclusive runs. Gaps may correspond to events we never receive.
  private readonly runs: [start: number, end: number][] = [];

  public constructor(private readonly floor: number) {}

  public record(seq: number) {
    if (seq <= this.floor) {
      return "duplicate" as const;
    }

    // Find the first run that starts strictly after seq.
    let lo = 0;
    let hi = this.runs.length;

    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const run = this.runs[mid];

      if (run && run[0] <= seq) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const left = this.runs[lo - 1];
    const right = this.runs[lo];

    if (left && seq <= left[1]) {
      return "duplicate" as const;
    }

    if (left && seq === left[1] + 1) {
      if (right && seq === right[0] - 1) {
        left[1] = right[1];
        this.runs.splice(lo, 1);
      } else {
        left[1] = seq;
      }
    } else if (right && seq === right[0] - 1) {
      right[0] = seq;
    } else if (this.runs.length < maxSequenceRuns) {
      this.runs.splice(lo, 0, [seq, seq]);
    } else {
      return "untracked" as const;
    }

    return "new" as const;
  }
}
