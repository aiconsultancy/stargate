import type { OpenCodeClient } from "@opencode/client";
import { Schema } from "effect";
import {
  type CheckoutDiffInput,
  type CrewGitInput,
  type FleetCrewStatusInput,
  type FleetCrewStatusRead,
  checkoutDiffSchema,
  crewGitSchema,
  fleetCrewStatusInputSchema,
  fleetCrewStatusOutputSchema,
} from "../../coordination/crew/reporting/fleet-status";
import { CrewReporting } from "../../coordination/crew/reporting/report-rpc";
import { createReadSlot, readWithDeadline } from "../../lib/read-deadline";
import {
  type CrewStatusInput,
  crewStatusSchema,
} from "../../shared/crew-status";

const maxFleetStatusProbeMs = 6400;
const crewGitTimeoutMs = 6000;

/** An older crew plugin that lacks the called RPC method. */
const isMethodNotFound = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "type" in error &&
  error.type === "rpc.method_not_found";

/** An older crew plugin that rejects an input field it does not know. */
const isInvalidInput = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "type" in error &&
  error.type === "rpc.invalid_input";

/** A deadline, as opposed to a caller that went away. */
const isTimeout = (reason: unknown) =>
  reason instanceof DOMException && reason.name === "TimeoutError";

/** The plugin's own input check, made before anything is asked of it. */
const validFleetInput = Schema.is(fleetCrewStatusInputSchema);

type FleetStatusProbe = {
  member: CrewStatusInput["member"];
  taskText: FleetCrewStatusInput["taskText"];
  result: Promise<FleetCrewStatusRead>;
  controller: AbortController;
  waiters: number;
};

/**
 * Ordinary or task-text fleet status reads: one current probe plus at most
 * one abandoned, abort-ignoring read still draining. A further timeout starts
 * nothing in this lane until its abandoned read drains. Failure counts and
 * backoff are also per lane.
 */
type FleetStatusLane = {
  read: ReturnType<typeof createReadSlot<FleetCrewStatusRead>>;
  probe?: FleetStatusProbe;
  failures: number;
  backoff?: {
    until: number;
    kind: "unavailable" | "unsupported";
  };
};

const fleetStatusLane = (): FleetStatusLane => ({
  read: createReadSlot<FleetCrewStatusRead>(maxFleetStatusProbeMs),
  failures: 0,
});

/** Reads location-scoped crew status and coalesced fleet status probes. */
export class OpenCodeCrewStatus {
  /** The two lanes never wait for, or read unavailable behind, each other. */
  private readonly lanes = {
    ordinary: fleetStatusLane(),
    taskText: fleetStatusLane(),
  };
  /** The ordinary lane's adaptive deadline. */
  private fleetStatusProbeMs = 400;

  private crewGitRetryAt = 0;
  private checkoutDiffRetryAt = 0;
  private taskTextRetryAt = 0;

  public constructor(
    private readonly client: OpenCodeClient,
    private readonly directory: () => string,
  ) {}

  public async crewStatus(input: CrewStatusInput, signal: AbortSignal) {
    try {
      signal.throwIfAborted();

      const result = Schema.decodeUnknownSync(crewStatusSchema)(
        await this.client.rpc(CrewReporting).status(input, {
          location: { directory: this.directory() },
          signal,
        }),
      );

      signal.throwIfAborted();

      return result;
    } catch {
      throw new Error(
        "Crew status unavailable; check the captain location and crew plugin.",
      );
    }
  }

  /**
   * Git state read by the crew plugin as the captain. Undefined when the
   * plugin is older, unreachable or slow; the caller then reads locally.
   */
  public async crewGit(input: CrewGitInput, signal: AbortSignal) {
    signal.throwIfAborted();

    if (performance.now() < this.crewGitRetryAt) {
      return;
    }

    try {
      const result = await readWithDeadline(
        signal,
        crewGitTimeoutMs,
        (reading) =>
          this.client.rpc(CrewReporting).crewGit(input, {
            location: { directory: this.directory() },
            signal: reading,
          }),
      ).result;

      return Schema.decodeUnknownSync(crewGitSchema)(result);
    } catch (error) {
      signal.throwIfAborted();

      // Older plugins lack the method. Probe again after an upgrade.
      if (isMethodNotFound(error)) {
        this.crewGitRetryAt = performance.now() + 60_000;
      }

      return;
    }
  }

  /**
   * A crew diff computed by the crew plugin as the captain. Undefined when
   * the plugin is older; any other failure throws. The caller bounds time.
   */
  public async checkoutDiff(input: CheckoutDiffInput, signal: AbortSignal) {
    signal.throwIfAborted();

    if (performance.now() < this.checkoutDiffRetryAt) {
      return;
    }

    try {
      const result = await this.client.rpc(CrewReporting).checkoutDiff(input, {
        location: { directory: this.directory() },
        signal,
      });

      signal.throwIfAborted();

      return Schema.decodeUnknownSync(checkoutDiffSchema)(result);
    } catch (error) {
      signal.throwIfAborted();

      // Older plugins lack the method. Probe again after an upgrade.
      if (isMethodNotFound(error)) {
        this.checkoutDiffRetryAt = performance.now() + 60_000;

        return;
      }

      throw new Error("Crew diff unavailable; raw details withheld.");
    }
  }

  private recordFleetStatusFailure(lane: FleetStatusLane, unsupported = false) {
    const until = performance.now() + 60_000;

    // A missing method is the plugin's own, so it pauses both lanes.
    if (unsupported) {
      for (const each of Object.values(this.lanes)) {
        each.backoff = { until, kind: "unsupported" };
        each.failures = 0;
      }

      return;
    }

    if (++lane.failures >= 3) {
      lane.backoff = { until, kind: "unavailable" };
      lane.failures = 0;
    }
  }

  /**
   * `taskText` asks for unredacted task text. Only an unsupported RPC or
   * input field allows callers to show ordinary status instead. Ordinary
   * and task-text reads have no shared limiter: neither lane waits behind
   * the other. A backend has at most two RPCs in flight in steady state and
   * four at worst, when each lane has a current probe and a draining read.
   */
  public async fleetCrewStatus(
    input: FleetCrewStatusInput,
    signal: AbortSignal,
  ): Promise<FleetCrewStatusRead> {
    // A member the plugin would reject is never sent: nothing to probe.
    if (!validFleetInput(input)) {
      signal.throwIfAborted();

      return { kind: "unavailable" };
    }

    const lane = input.taskText ? this.lanes.taskText : this.lanes.ordinary;

    for (;;) {
      signal.throwIfAborted();
      const pending = lane.read.pending;
      let probe = pending ? lane.probe : undefined;

      if (!probe) {
        const backoff = lane.backoff;

        if (backoff && performance.now() < backoff.until) {
          return { kind: backoff.kind };
        }

        probe = this.startFleetStatusProbe(lane, input);
        lane.probe = probe;
      }

      const sameView =
        probe.member === input.member && probe.taskText === input.taskText;

      // A timed-out request may still occupy the slot. Task-text readers
      // Wait for the actual read to settle, not for its expired result.
      if (
        pending &&
        input.taskText &&
        (!sameView || probe.controller.signal.aborted)
      ) {
        try {
          await readWithDeadline(signal, undefined, () =>
            Promise.all([pending.settled, probe.result]),
          ).result;
        } catch {
          signal.throwIfAborted();

          return { kind: "unavailable" };
        }

        continue;
      }

      probe.waiters++;

      try {
        const result = await readWithDeadline(
          signal,
          undefined,
          () => probe.result,
        ).result;

        if (sameView) {
          return result;
        }

        // A different filter needs its own probe once the slot is free.
        // A timed-out RPC can still hold the slot while it drains.
        if (lane.read.pending === pending) {
          return { kind: "unavailable" };
        }
      } finally {
        // The last waiter's reason tells a deadline from a disconnect.
        if (--probe.waiters === 0) {
          probe.controller.abort(signal.aborted ? signal.reason : undefined);
        }
      }
    }
  }

  private async fleetStatusRpc(
    input: FleetCrewStatusInput,
    signal: AbortSignal,
  ): Promise<FleetCrewStatusRead> {
    const rpc = this.client.rpc(CrewReporting);
    const options = { location: { directory: this.directory() }, signal };
    const ordinary = input.member === undefined ? {} : { member: input.member };

    const read = async (requested: FleetCrewStatusInput) => {
      const result = Schema.decodeUnknownSync(fleetCrewStatusOutputSchema)(
        await rpc.fleetStatus(requested, options),
      );

      const mode = "taskText" in result ? result.taskText : undefined;

      if (mode !== requested.taskText) {
        throw new Error(
          "Fleet crew status answered with the wrong task text view.",
        );
      }

      return result;
    };

    if (!input.taskText) {
      return { kind: "answer", answer: await read(ordinary) };
    }

    if (performance.now() < this.taskTextRetryAt) {
      return { kind: "unsupported", answer: await read(ordinary) };
    }

    try {
      return { kind: "answer", answer: await read(input) };
    } catch (error) {
      signal.throwIfAborted();

      if (!isInvalidInput(error)) {
        throw error;
      }

      // Only a successful re-ask establishes that the field is unsupported.
      // A failed re-ask is ordinary, even if it reports a missing method.
      const answer = await read(ordinary).catch(() => {
        throw new Error("Fleet crew status re-ask failed.");
      });

      // A reply after the probe ended reaches no caller: cache nothing.
      signal.throwIfAborted();
      this.taskTextRetryAt = performance.now() + 60_000;

      return { kind: "unsupported", answer };
    }
  }

  private startFleetStatusProbe(
    lane: FleetStatusLane,
    input: FleetCrewStatusInput,
  ): FleetStatusProbe {
    // Ordinary reads leave time for fallback. Task-text readers own the
    // Deadline and cancel the shared attempt only when the last one leaves.
    const probeMs = this.fleetStatusProbeMs;
    const controller = new AbortController();
    let failureCounted = false;

    const { result: probe } = lane.read.start(
      controller.signal,
      (reading) => this.fleetStatusRpc(input, reading),
      {
        timeout: input.taskText ? false : probeMs,
        onAbandon: () => {
          if (
            !failureCounted &&
            (!input.taskText || isTimeout(controller.signal.reason))
          ) {
            this.recordFleetStatusFailure(lane);
            failureCounted = true;
          }
        },
      },
    );

    // A last-waiter deadline counts as one task text failure in either phase.
    // A disconnect counts nothing.
    const ended = (): FleetCrewStatusRead => {
      if (
        input.taskText &&
        !failureCounted &&
        isTimeout(controller.signal.reason)
      ) {
        this.recordFleetStatusFailure(lane);
        failureCounted = true;
      }

      return { kind: "unavailable" };
    };

    const result = probe
      .then((status): FleetCrewStatusRead => {
        if (controller.signal.aborted || failureCounted) {
          return ended();
        }

        lane.failures = 0;

        return status;
      })
      .catch((error: unknown): FleetCrewStatusRead => {
        if (controller.signal.aborted || failureCounted) {
          return ended();
        }

        const timedOut = isTimeout(error);

        if (!input.taskText && timedOut && probeMs < maxFleetStatusProbeMs) {
          this.fleetStatusProbeMs = Math.max(
            this.fleetStatusProbeMs,
            Math.min(probeMs * 2, maxFleetStatusProbeMs),
          );
        } else {
          const unsupported = isMethodNotFound(error);
          this.recordFleetStatusFailure(lane, unsupported);
          failureCounted = true;

          if (unsupported) {
            return { kind: "unsupported" };
          }
        }

        // Ordinary status cannot verify which checkout is provisioned.
        return { kind: "unavailable" };
      });

    return {
      member: input.member,
      taskText: input.taskText,
      result,
      controller,
      waiters: 0,
    };
  }
}
