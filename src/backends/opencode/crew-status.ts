import type { OpenCodeClient } from "@opencode/client";
import { Schema } from "effect";
import {
  type FleetCrewStatus,
  fleetCrewStatusSchema,
} from "../../coordination/crew/reporting/fleet-status";
import { CrewReporting } from "../../coordination/crew/reporting/report-rpc";
import { createReadSlot, readWithDeadline } from "../../lib/read-deadline";
import {
  type CrewStatusInput,
  crewStatusSchema,
} from "../../shared/crew-status";

const maxFleetStatusProbeMs = 6400;

/** Reads location-scoped crew status and coalesced fleet status probes. */
export class OpenCodeCrewStatus {
  private fleetStatusRetryAt = 0;
  private fleetStatusFailures = 0;
  private fleetStatusProbeMs = 400;
  private readonly fleetStatusRead = createReadSlot<unknown>(
    maxFleetStatusProbeMs,
  );
  private fleetStatusProbe?: {
    member: CrewStatusInput["member"];
    result: Promise<FleetCrewStatus | undefined>;
    controller: AbortController;
    waiters: number;
  };

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

  private recordFleetStatusFailure(unsupported = false) {
    if (++this.fleetStatusFailures >= 3 || unsupported) {
      this.fleetStatusRetryAt = performance.now() + 60_000;
      this.fleetStatusFailures = 0;
    }
  }

  public async fleetCrewStatus(input: CrewStatusInput, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      const pending = this.fleetStatusRead.pending;
      let probe = pending ? this.fleetStatusProbe : undefined;

      if (!probe) {
        if (performance.now() < this.fleetStatusRetryAt) return;
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

        if (probe.member === input.member) return result;

        // A different filter needs its own probe once the slot is free.
        // A timed-out RPC can still hold the slot while it drains.
        if (this.fleetStatusRead.pending === pending) return;
      } finally {
        if (--probe.waiters === 0) probe.controller.abort();
      }
    }
  }

  private startFleetStatusProbe(input: CrewStatusInput) {
    // Start with a short probe and leave time for ordinary crew status.
    const probeMs = this.fleetStatusProbeMs;
    const controller = new AbortController();
    let failureCounted = false;

    const { result: probe } = this.fleetStatusRead.start(
      controller.signal,
      (reading) =>
        this.client.rpc(CrewReporting).fleetStatus(input, {
          location: { directory: this.directory() },
          signal: reading,
        }),
      {
        timeout: probeMs,
        onAbandon: () => {
          if (!failureCounted) this.recordFleetStatusFailure();
          failureCounted = true;
        },
      },
    );

    const result = probe
      .then((status): FleetCrewStatus | undefined => {
        if (controller.signal.aborted || failureCounted) return;
        const result = Schema.decodeUnknownSync(fleetCrewStatusSchema)(status);
        this.fleetStatusFailures = 0;

        return result;
      })
      .catch((error: unknown): undefined => {
        if (controller.signal.aborted || failureCounted) return;

        const timedOut =
          error instanceof DOMException && error.name === "TimeoutError";

        if (timedOut && probeMs < maxFleetStatusProbeMs) {
          this.fleetStatusProbeMs = Math.max(
            this.fleetStatusProbeMs,
            Math.min(probeMs * 2, maxFleetStatusProbeMs),
          );
        } else {
          // Older plugins still serve ordinary status. Probe again after an upgrade.
          const unsupported =
            error !== null &&
            typeof error === "object" &&
            "type" in error &&
            error.type === "rpc.method_not_found";

          this.recordFleetStatusFailure(unsupported);
          failureCounted = true;
        }

        // Ordinary status cannot verify which checkout is provisioned.
        return;
      });

    return { member: input.member, result, controller, waiters: 0 };
  }
}
