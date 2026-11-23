import { Schema } from "effect";
import {
  fleetJobSchema,
  nativeMakerSchema,
} from "../coordination/fleet/protocol";
import { notificationContextSchema } from "../notifications/preferences/notifications";
import { inboundReactionSchema } from "../shared/reactions";
import type { Job } from "./store-types";

export type StoredJob = Omit<
  Job,
  "deferDelivery" | "fleet" | "makers" | "notification" | "slackReaction"
> & {
  deferDelivery: number;
  fleet_context: string | null;
  makers: string | null;
  fleet_exported: number;
  notification_context: string | null;
  notification_held: number;
  slack_reaction: string | null;
};

export function decodeStoredJob(row: StoredJob): Job {
  const {
    fleet_context,
    makers,
    fleet_exported: _exported,
    notification_context,
    notification_held: _notificationHeld,
    slack_reaction,
    ...job
  } = row;

  return {
    ...job,
    deferDelivery: row.deferDelivery === 1,
    ...(slack_reaction && {
      slackReaction: Schema.decodeUnknownSync(inboundReactionSchema)(
        JSON.parse(slack_reaction),
      ),
    }),
    ...(notification_context && {
      notification: Schema.decodeUnknownSync(notificationContextSchema)(
        JSON.parse(notification_context),
      ),
    }),
    ...(fleet_context && {
      fleet: Schema.decodeUnknownSync(fleetJobSchema)(
        JSON.parse(fleet_context),
      ),
    }),
    ...(makers && {
      makers: Schema.decodeUnknownSync(
        Schema.mutable(Schema.Array(nativeMakerSchema)),
      )(JSON.parse(makers)),
    }),
  };
}

export function decodeJob(row: StoredJob | null): Job | null {
  return row && decodeStoredJob(row);
}
