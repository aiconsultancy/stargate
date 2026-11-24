import { Schema } from "effect";
import { settingsStruct } from "../../config/settings-schema";

const bounded = (max: number) =>
  Schema.String.check(Schema.isMaxCodePoints(max));

export const Id = bounded(64).check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);

export const Topic = bounded(200).check(
  Schema.isPattern(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/),
);

export const TopicPattern = bounded(200).check(
  Schema.isPattern(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\.\*)?$/),
);

export const topicMatches = (pattern: string, topic: string) =>
  pattern.endsWith(".*")
    ? topic.startsWith(pattern.slice(0, -1))
    : pattern === topic;

export const Audience = Schema.Literals(["internal", "public"]);

/** RFC 3339 without leap seconds or precision that cannot survive milliseconds. */
export function utcMillis(value: string): string | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(
      value,
    );

  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = days[month - 1];
  const zone = match[8];

  if (
    maxDay === undefined ||
    day < 1 ||
    day > maxDay ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    !zone ||
    (zone.length > 1 &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  ) {
    return undefined;
  }

  const time = Date.parse(value);

  if (!Number.isFinite(time)) {
    return undefined;
  }

  const canonical = new Date(time).toISOString();

  return canonical.length === 24 ? canonical : undefined;
}

export const OccurredAt = Schema.String.check(
  Schema.makeFilter((value) => utcMillis(value) !== undefined),
);

const TagKey = bounded(64).check(Schema.isMinLength(1));

const Tags = Schema.Record(Schema.String, bounded(256)).check(
  Schema.isPropertyNames(TagKey),
  Schema.makeFilter((value) => Object.keys(value).length <= 16),
);

const HttpsUrl = bounded(2048).check(
  Schema.makeFilter((value) => {
    if (/[\s\p{Cc}]/u.test(value) || !/^https:\/\//i.test(value)) {
      return false;
    }

    try {
      const url = new URL(value);

      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !value.slice(8).split(/[/?#]/, 1)[0]?.includes("@")
      );
    } catch {
      return false;
    }
  }),
);

export const DisplayPayload = settingsStruct({
  title: bounded(200),
  body: Schema.optional(bounded(2800)),
  url: Schema.optional(HttpsUrl),
});

export type DisplayPayload = typeof DisplayPayload.Type;

export const NotificationInput = settingsStruct({
  schema: Schema.Literal(1),
  topic: Topic,
  occurredAt: OccurredAt,
  tags: Schema.optional(Tags),
  payload: DisplayPayload,
});

export type NotificationInput = typeof NotificationInput.Type;

export const Source = settingsStruct({
  adapter: Id,
  principal: Id,
  audience: Audience,
  topics: Schema.Array(TopicPattern).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
});

export type Source = typeof Source.Type;

export const sourceScope = (source: Source) =>
  JSON.stringify([source.adapter, source.principal]);

export const Destination = settingsStruct({
  transport: Schema.Literal("slack"),
  registrationId: Id,
  appId: bounded(64).check(Schema.isPattern(/^A[A-Z0-9]+$/)),
  workspaceId: bounded(64).check(Schema.isPattern(/^T[A-Z0-9]+$/)),
  botUserId: bounded(64).check(Schema.isPattern(/^[UW][A-Z0-9]+$/)),
  channel: bounded(64).check(Schema.isPattern(/^[CG][A-Z0-9]+$/)),
  audience: Audience,
});

export type Destination = typeof Destination.Type;

export const physicalKey = (destination: Destination) =>
  JSON.stringify([
    destination.appId,
    destination.workspaceId,
    destination.botUserId,
    destination.channel,
  ]);

export const audienceAllowed = (
  source: Source["audience"],
  destination: Destination["audience"],
) => source === "public" || destination === "internal";

export const Subscription = settingsStruct({
  topic: TopicPattern,
  tags: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Array(bounded(256)).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(16),
      ),
    ).check(
      Schema.isPropertyNames(TagKey),
      Schema.makeFilter((value) => Object.keys(value).length <= 16),
    ),
  ),
  to: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

export type Subscription = typeof Subscription.Type;

export interface Accepted {
  readonly signature: string;
  readonly duplicate: boolean;
}

export class InvalidNotification extends Schema.TaggedError<InvalidNotification>()(
  "InvalidNotification",
  {},
) {}

export class TopicNotGranted extends Schema.TaggedError<TopicNotGranted>()(
  "TopicNotGranted",
  {},
) {}

export class QueueFull extends Schema.TaggedError<QueueFull>()(
  "QueueFull",
  {},
) {}

export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  "StoreUnavailable",
  {},
) {}

export class ShuttingDown extends Schema.TaggedError<ShuttingDown>()(
  "ShuttingDown",
  {},
) {}

export type PublishError =
  | InvalidNotification
  | TopicNotGranted
  | QueueFull
  | StoreUnavailable
  | ShuttingDown;

export const defaultLimits = {
  admissionQueue: 1000,
  outboxRows: 10_000,
  perDestination: 500,
  maxAgeMs: 24 * 60 * 60 * 1000,
  sendAttempts: 3,
  leaseMs: 60_000,
  spacingMs: 1000,
  concurrency: 4,
  dedupMs: 7 * 24 * 60 * 60 * 1000,
  dedupRecords: 100_000,
  attemptTimeoutMs: 20_000,
  shutdownGraceMs: 25_000,
};

export type Limits = typeof defaultLimits;

export function notificationLimits(overrides: Partial<Limits> = {}): Limits {
  const limits = { ...defaultLimits, ...overrides };

  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    limits.attemptTimeoutMs >= limits.leaseMs ||
    limits.concurrency > 4 ||
    limits.sendAttempts > 3
  ) {
    throw new StoreUnavailable();
  }

  return limits;
}
