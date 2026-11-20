import { Result, Schema } from "effect";
import {
  audienceAllowed,
  Destination,
  type NotificationInput,
  physicalKey,
  type Source,
  StoreUnavailable,
  Subscription,
} from "./model";

export const topicMatches = (pattern: string, topic: string) =>
  pattern.endsWith(".*")
    ? topic.startsWith(pattern.slice(0, -1))
    : pattern === topic;

/** Trusted topology is bounded and snapshotted before admission starts. */
export function resolveSubscriptions(
  source: Source,
  input: NotificationInput,
  subscriptions: readonly Subscription[],
  destinations: Readonly<Record<string, Destination>>,
): Destination[] {
  if (subscriptions.length > 512 || Object.keys(destinations).length > 128)
    throw new StoreUnavailable();
  const resolved = new Map<string, Destination>();
  for (const raw of subscriptions) {
    const checked = Schema.decodeUnknownResult(Subscription)(raw);
    if (Result.isFailure(checked)) throw new StoreUnavailable();
    const subscription = checked.success;
    if (
      !topicMatches(subscription.topic, input.topic) ||
      !Object.entries(subscription.tags ?? {}).every(([key, values]) => {
        const tag =
          input.tags && Object.hasOwn(input.tags, key)
            ? input.tags[key]
            : undefined;
        return tag !== undefined && values.includes(tag);
      })
    )
      continue;
    for (const alias of subscription.to) {
      const decoded = Schema.decodeUnknownResult(Destination)(
        Object.hasOwn(destinations, alias) ? destinations[alias] : undefined,
      );
      if (
        Result.isFailure(decoded) ||
        !audienceAllowed(source.audience, decoded.success.audience)
      )
        throw new StoreUnavailable();
      const destination = decoded.success;
      const key = physicalKey(destination);
      const existing = resolved.get(key);
      if (
        existing &&
        (existing.audience !== destination.audience ||
          existing.registrationId !== destination.registrationId)
      )
        throw new StoreUnavailable();
      resolved.set(key, destination);
    }
  }
  return [...resolved.values()];
}
