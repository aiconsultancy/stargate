import type { Destination, DisplayPayload, Source } from "./model";

export interface DeliveryDestination extends Destination {
  readonly sourceAudience: Source["audience"];
}
export type SinkOutcome =
  | { readonly state: "sent" }
  | {
      readonly state: "refused";
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
    }
  | { readonly state: "unknown" };

/** Implementations must abort underlying I/O and settle, not just stop waiting. */
export interface NotificationSink {
  allowed(destination: DeliveryDestination): boolean;
  send(
    destination: DeliveryDestination,
    payload: DisplayPayload,
    signal: AbortSignal,
  ): Promise<SinkOutcome>;
}
