// Git's diff output, parsed as the captain's crew diff reader streams it.

/** One changed path in `git diff --raw --numstat -z [-p]` output. */
export type DiffEntry = {
  status: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  path: string;
  /** The bytes Git wrote for `path`, which need not be valid UTF-8. */
  pathBytes: Buffer;
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  /** Bytes of hunks, after the file headers. */
  size: number;
  /** The kept bytes of the hunks, from the planned offset. */
  kept: Buffer[];
  keptBytes: number;
};

/** Bytes of each entry's hunks to keep, by entry index in Git's order. */
export type DiffPlan = Map<number, { from: number; to: number }>;

const rawRecord =
  /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([ACDMRTUX])(\d{0,3})$/;

const numstatRecord = /^(\d+|-)\t(\d+|-)\t/;
const sectionStart = Buffer.from("diff --git ");
const hunkStart = Buffer.from("@@ ");

/**
 * Parse Git's raw, numstat and patch output as it streams, in one pass. Raw
 * and numstat records come first, then a NUL, then one patch section a path;
 * a type change has two. Only the planned hunk bytes are kept.
 */
export class DiffOutputParser {
  public readonly entries: DiffEntry[] = [];
  private header = true;
  private partial: Buffer | undefined;
  private paths:
    | { entry: DiffEntry; left: number; numstat: boolean }
    | undefined;
  private numstat = 0;
  private plan: DiffPlan = new Map();
  private last = -1;
  private current = -1;
  private sectionsLeft = 0;
  private inHunks = false;
  private lineStart = true;
  private stash: Buffer | undefined;
  private stopped = false;

  public constructor(
    private readonly patches: boolean,
    private readonly planner: (entries: DiffEntry[]) => DiffPlan = () =>
      new Map(),
  ) {}

  /** Every planned entry is read and Git was told to stop. */
  public get done() {
    return this.stopped;
  }

  /** False once every planned entry is read: Git may then stop. */
  public feed(chunk: Buffer): boolean {
    let rest = chunk;

    if (this.header) {
      const consumed = this.feedHeader(chunk);

      if (consumed < 0) {
        return true;
      }

      this.header = false;
      this.plan = this.planner(this.entries);
      this.last = Math.max(-1, ...this.plan.keys());
      rest = chunk.subarray(consumed);
    }

    if (!this.stopped) {
      this.feedPatch(rest);
    }

    return !this.stopped;
  }

  /** Check that the output was whole: call when Git exits unstopped. */
  public end() {
    if (this.stopped) {
      return;
    }

    if (this.header) {
      if (this.partial || this.paths) {
        throw new Error("Git diff output ended early");
      }

      if (
        this.numstat !== this.entries.length ||
        (this.patches && this.entries.length > 0)
      ) {
        throw new Error("Git diff output is incomplete");
      }

      return;
    }

    if (this.stash) {
      const stash = this.stash;
      this.stash = undefined;
      this.line(stash, 0, stash.length, false);
    }

    if (this.current !== this.entries.length - 1 || this.sectionsLeft !== 0) {
      throw new Error("Git diff sections do not match its records");
    }
  }

  private feedHeader(chunk: Buffer) {
    let position = 0;

    for (;;) {
      const nul = chunk.indexOf(0, position);

      if (nul === -1) {
        const tail = chunk.subarray(position);

        if (tail.length > 0) {
          this.partial = this.partial
            ? Buffer.concat([this.partial, tail])
            : Buffer.from(tail);
        }

        if ((this.partial?.length ?? 0) > 64 * 1024) {
          throw new Error("Git diff record too long");
        }

        return -1;
      }

      const piece = chunk.subarray(position, nul);
      const token = this.partial ? Buffer.concat([this.partial, piece]) : piece;
      this.partial = undefined;
      position = nul + 1;

      if (this.token(token)) {
        return position;
      }
    }
  }

  /** True at the NUL that ends the records. */
  private token(token: Buffer) {
    const text = token.toString("utf8");

    if (this.paths) {
      const { entry, numstat } = this.paths;
      const left = --this.paths.left;

      if (!text) {
        throw new Error("Empty path in Git diff output");
      }

      if (numstat) {
        if (text !== (left === 1 ? entry.previousPath : entry.path)) {
          throw new Error("Git numstat does not match its raw records");
        }
      } else if (left === 1) {
        entry.previousPath = text;
      } else {
        entry.path = text;
        entry.pathBytes = Buffer.from(token);
      }

      if (left === 0) {
        this.paths = undefined;
      }

      return false;
    }

    if (!text) {
      if (
        !this.patches ||
        this.entries.length === 0 ||
        this.numstat !== this.entries.length
      ) {
        throw new Error("Unexpected Git diff separator");
      }

      return true;
    }

    const raw = rawRecord.exec(text);

    if (raw) {
      const [
        ,
        oldMode = "",
        newMode = "",
        oldOid = "",
        newOid = "",
        status = "",
      ] = raw;

      if (this.numstat > 0) {
        throw new Error("Raw record after numstat in Git diff output");
      }

      const entry: DiffEntry = {
        status,
        oldMode,
        newMode,
        oldOid,
        newOid,
        path: "",
        pathBytes: Buffer.alloc(0),
        previousPath: null,
        additions: null,
        deletions: null,
        size: 0,
        kept: [],
        keptBytes: 0,
      };

      this.entries.push(entry);
      this.paths = {
        entry,
        left: status === "R" || status === "C" ? 2 : 1,
        numstat: false,
      };

      return false;
    }

    const numstat = numstatRecord.exec(text);
    const entry = this.entries[this.numstat++];

    if (!numstat || !entry) {
      throw new Error("Malformed Git diff record");
    }

    const [whole, additions = "", deletions = ""] = numstat;
    entry.additions = additions === "-" ? null : Number(additions);
    entry.deletions = deletions === "-" ? null : Number(deletions);
    const path = text.slice(whole.length);

    if (!path) {
      this.paths = { entry, left: 2, numstat: true };
    } else if (path !== entry.path) {
      throw new Error("Git numstat does not match its raw records");
    }

    return false;
  }

  private feedPatch(chunk: Buffer) {
    let bytes = chunk;

    if (this.stash) {
      bytes = Buffer.concat([this.stash, chunk]);
      this.stash = undefined;
    }

    let position = 0;

    while (position < bytes.length && !this.stopped) {
      const newline = bytes.indexOf(10, position);
      const end = newline === -1 ? bytes.length : newline + 1;

      // Keep a short line start to classify it with the next chunk.
      if (
        this.lineStart &&
        newline === -1 &&
        end - position < sectionStart.length
      ) {
        this.stash = Buffer.from(bytes.subarray(position));

        return;
      }

      this.line(bytes, position, end, newline !== -1);
      position = end;
    }
  }

  private line(bytes: Buffer, start: number, end: number, complete: boolean) {
    if (this.lineStart) {
      if (startsWith(bytes, start, end, sectionStart)) {
        this.section();

        if (this.stopped) {
          return;
        }
      } else if (!this.inHunks && startsWith(bytes, start, end, hunkStart)) {
        this.inHunks = true;
      }
    }

    if (this.inHunks) {
      this.keep(bytes.subarray(start, end));
    }

    this.lineStart = complete;
  }

  private section() {
    if (this.sectionsLeft > 0) {
      this.sectionsLeft--;
    } else {
      this.current++;
      const entry = this.entries[this.current];

      if (!entry) {
        throw new Error("More Git diff sections than records");
      }

      if (this.current > this.last) {
        this.stopped = true;

        return;
      }

      // A type change is a deletion and a creation.
      this.sectionsLeft = entry.status === "T" ? 1 : 0;
    }

    this.inHunks = false;
  }

  private keep(bytes: Buffer) {
    const entry = this.entries[this.current];

    if (!entry) {
      throw new Error("Git diff hunk outside a section");
    }

    const start = entry.size;
    entry.size += bytes.length;
    const window = this.plan.get(this.current);

    if (!window) {
      return;
    }

    const from = Math.max(window.from, start);
    const to = Math.min(window.to, entry.size);

    if (from < to) {
      entry.kept.push(Buffer.from(bytes.subarray(from - start, to - start)));
      entry.keptBytes += to - from;
    }
  }
}

function startsWith(bytes: Buffer, start: number, end: number, prefix: Buffer) {
  return (
    end - start >= prefix.length &&
    bytes.compare(prefix, 0, prefix.length, start, start + prefix.length) === 0
  );
}
