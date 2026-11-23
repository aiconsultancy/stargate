import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Result, Schema } from "effect";
import {
  type MaintenanceNotice,
  maintenancePlanSchema,
  maintenanceWindowMs,
} from "../../automation/maintenance/maintenance";
import type { CrewCaller } from "../execution/engine";
import { CrewError } from "../execution/state";

const decodePlan = Schema.decodeUnknownResult(maintenancePlanSchema);

type Owner = { sessionID: string; id: string };

type Permit = { status: "window-elapsed"; windowMs: number };

type Turn = Owner & {
  seenAt: number;
  stop: AbortController;
  pending?: {
    notice: MaintenanceNotice;
    deliveredAt?: number;
    release: (result: Permit) => void;
  };
};

interface Authority {
  options: { team: { captain: { id: string } } };
  captain(caller: CrewCaller): Promise<void>;
}

type Options = {
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const leaseMs = 10_000;

/** Turn-scoped, fail-closed gate; never persists permission across restarts. */
export class CrewMaintenance {
  private readonly turns = new Map<string, Turn>();
  private readonly now: () => number;
  private readonly wait: NonNullable<Options["wait"]>;

  public constructor(
    private readonly authority: Authority,
    options: Options = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.wait =
      options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  public async open(owner: Owner, signal: AbortSignal) {
    await this.authority.captain({
      sessionID: owner.sessionID,
      agent: this.authority.options.team.captain.id,
      signal,
    });
    signal.throwIfAborted();

    for (const turn of this.turns.values()) {
      if (this.now() - turn.seenAt > leaseMs) this.close(turn);
    }

    if (this.turns.has(owner.sessionID) || this.turns.size >= 32)
      throw new CrewError("A maintenance gateway turn is already registered.");
    this.turns.set(owner.sessionID, {
      ...owner,
      seenAt: this.now(),
      stop: new AbortController(),
    });

    return true;
  }

  private owned(owner: Owner) {
    const turn = this.turns.get(owner.sessionID);

    if (!turn || turn.id !== owner.id)
      throw new CrewError("Maintenance gateway ownership unavailable.");

    if (this.now() - turn.seenAt > leaseMs) {
      this.close(owner);
      throw new CrewError(
        "Maintenance gateway disconnected; no permission granted.",
      );
    }

    return turn;
  }

  public read(owner: Owner): MaintenanceNotice | null {
    const turn = this.owned(owner);
    turn.seenAt = this.now();
    const pending = turn.pending;

    if (!pending) return null;

    if (
      pending.deliveredAt !== undefined &&
      this.now() - pending.deliveredAt >= maintenanceWindowMs
    ) {
      pending.release({
        status: "window-elapsed",
        windowMs: maintenanceWindowMs,
      });
      delete turn.pending;

      return null;
    }

    return pending.notice;
  }

  public delivered(owner: Owner & { noticeID: string }) {
    const pending = this.owned(owner).pending;

    if (!pending || pending.notice.id !== owner.noticeID)
      throw new CrewError(
        "Maintenance notice changed; delivery not confirmed.",
      );
    pending.deliveredAt ??= this.now();

    return true;
  }

  public async run(raw: unknown, caller: CrewCaller): Promise<Permit> {
    const parsed = decodePlan(raw);

    if (Result.isFailure(parsed))
      throw new CrewError("Invalid maintenance plan.");
    await this.authority.captain(caller);
    caller.signal.throwIfAborted();
    const turn = this.turns.get(caller.sessionID);

    if (!turn)
      throw new CrewError(
        "No live maintenance gateway. Ask the user for explicit approval; do not use a shell sleep.",
      );
    this.owned(turn);

    if (turn.pending)
      throw new CrewError("Another maintenance notice is pending.");
    const permit = Promise.withResolvers<Permit>();
    const stop = new AbortController();

    const signal = AbortSignal.any([
      caller.signal,
      turn.stop.signal,
      stop.signal,
    ]);

    turn.pending = {
      notice: { ...parsed.success, id: randomUUID() },
      release: permit.resolve,
    };

    const connected = (async () => {
      while (true) {
        await this.wait(1000, signal);
        signal.throwIfAborted();
        this.owned(turn);
      }
    })();

    try {
      const result = await Promise.race([permit.promise, connected]);
      signal.throwIfAborted();

      return result;
    } finally {
      stop.abort();
      delete turn.pending;
    }
  }

  public close(owner: Owner) {
    const turn = this.turns.get(owner.sessionID);

    if (!turn) return true;

    if (turn.id !== owner.id) throw new CrewError("Maintenance turn changed.");
    turn.stop.abort();
    this.turns.delete(owner.sessionID);

    return true;
  }

  public dispose() {
    for (const turn of this.turns.values()) this.close(turn);
  }
}
