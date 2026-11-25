import type { OpenCodeClient } from "@opencode/client";
import { Schema } from "effect";
import {
  type CheckoutDiffInput,
  type CrewGitInput,
  type FleetCrewStatus,
  type FleetCrewStatusInput,
  checkoutDiffSchema,
  crewGitSchema,
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

/** Reads location-scoped crew status and coalesced fleet status probes. */
export class OpenCodeCrewStatus {
  private fleetStatusRetryAt = 0;
  private fleetStatusFailures = 0;
  private fleetStatusProbeMs = 400;
  private readonly fleetStatusRead = createReadSlot<FleetCrewStatus>(
    maxFleetStatusProbeMs,
  );
  private fleetStatusProbe?: {
    member: CrewStatusInput["member"];
    taskText: FleetCrewStatusInput["taskText"];
    result: Promise<FleetCrewStatus | undefined>;
    controller: AbortController;
    waiters: number;
  };

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

  private recordFleetStatusFailure(unsupported = false) {
    if (++this.fleetStatusFailures >= 3 || unsupported) {
      this.fleetStatusRetryAt = performance.now() + 60_000;
      this.fleetStatusFailures = 0;
    }
  }

  /**
   * `taskText` asks for unredacted task text. A plugin older than the field
   * answers with ordinary, redacted status instead, which callers must accept.
   */
  public async fleetCrewStatus(
    input: FleetCrewStatusInput,
    signal: AbortSignal,
  ) {
    for (;;) {
      signal.throwIfAborted();
      const pending = this.fleetStatusRead.pending;
      let probe = pending ? this.fleetStatusProbe : undefined;

      if (!probe) {
        if (performance.now() < this.fleetStatusRetryAt) {
          return;
        }

        probe = this.startFleetStatusProbe(input);
        this.fleetStatusProbe = probe;
      }

      probe.waiters++;

      try {
        const result = await readWithDeadline(
          signal,
          undefined,
          () => probe.result,
        ).result;

        if (
          probe.member === input.member &&
          probe.taskText === input.taskText
        ) {
          return result;
        }

        // A different filter needs its own probe once the slot is free.
        // A timed-out RPC can still hold the slot while it drains.
        if (this.fleetStatusRead.pending === pending) {
          return;
        }
      } finally {
        if (--probe.waiters === 0) {
          probe.controller.abort();
        }
      }
    }
  }

  private async fleetStatusRpc(
    input: FleetCrewStatusInput,
    signal: AbortSignal,
  ) {
    const rpc = this.client.rpc(CrewReporting);
    const options = { location: { directory: this.directory() }, signal };
    const ordinary = input.member === undefined ? {} : { member: input.member };

    const read = async (requested: FleetCrewStatusInput) => {
      const result = Schema.decodeUnknownSync(fleetCrewStatusOutputSchema)(
        await rpc.fleetStatus(requested, options),
      );

      if ("taskText" in result && result.taskText !== requested.taskText) {
        throw new Error(
          "Fleet crew status answered with the wrong task text view.",
        );
      }

      return result;
    };

    if (!input.taskText || performance.now() < this.taskTextRetryAt) {
      return read(ordinary);
    }

    try {
      return await read(input);
    } catch (error) {
      if (!isInvalidInput(error)) {
        throw error;
      }

      // An older plugin rejects the field: ask again without it. Neither
      // Mode is asked for again until an upgrade may have happened.
      this.taskTextRetryAt = performance.now() + 60_000;

      return read(ordinary);
    }
  }

  private startFleetStatusProbe(input: FleetCrewStatusInput) {
    // Start with a short probe and leave time for ordinary crew status.
    const probeMs = this.fleetStatusProbeMs;
    const controller = new AbortController();
    let failureCounted = false;

    const { result: probe } = this.fleetStatusRead.start(
      controller.signal,
      (reading) => this.fleetStatusRpc(input, reading),
      {
        timeout: probeMs,
        onAbandon: () => {
          if (!failureCounted) {
            this.recordFleetStatusFailure();
          }

          failureCounted = true;
        },
      },
    );

    const result = probe
      .then((status): FleetCrewStatus | undefined => {
        if (controller.signal.aborted || failureCounted) {
          return;
        }

        this.fleetStatusFailures = 0;

        return status;
      })
      .catch((error: unknown): undefined => {
        if (controller.signal.aborted || failureCounted) {
          return;
        }

        const timedOut =
          error instanceof DOMException && error.name === "TimeoutError";

        if (timedOut && probeMs < maxFleetStatusProbeMs) {
          this.fleetStatusProbeMs = Math.max(
            this.fleetStatusProbeMs,
            Math.min(probeMs * 2, maxFleetStatusProbeMs),
          );
        } else {
          // Older plugins still serve ordinary status. Probe again after an upgrade.
          this.recordFleetStatusFailure(isMethodNotFound(error));
          failureCounted = true;
        }

        // Ordinary status cannot verify which checkout is provisioned.
        return;
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
