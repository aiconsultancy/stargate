import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import {
  Destination,
  NotificationInput,
  notificationLimits,
  type Source,
  utcMillis,
} from "../src/notifications/ingest/model";
import { signature } from "../src/notifications/ingest/signature";
import {
  resolveSubscriptions,
  topicMatches,
} from "../src/notifications/ingest/subscriptions";

const source: Source = {
  adapter: "http",
  principal: "ci",
  audience: "internal",
  topics: ["release.*"],
};
const input: NotificationInput = {
  schema: 1,
  topic: "release.desktop",
  occurredAt: "2026-11-19T02:00:00Z",
  payload: { title: "Ready" },
};
const destination: Destination = {
  transport: "slack",
  registrationId: "pegasus",
  appId: "AONE",
  workspaceId: "TONE",
  botUserId: "UONE",
  channel: "CONE",
  audience: "internal",
};

test("rejects impossible calendar dates instead of normalizing them", () => {
  const decoded = Schema.decodeUnknownResult(NotificationInput)({
    schema: 1,
    topic: "release.desktop",
    occurredAt: "2026-02-30T12:00:00Z",
    payload: { title: "Ready" },
  });
  expect(Result.isFailure(decoded)).toBe(true);
});

test("calendar, precision and zone boundaries normalize to UTC milliseconds", () => {
  expect(utcMillis("2024-02-29T03:30:00.1+01:30")).toBe(
    "2024-02-29T02:00:00.100Z",
  );
  expect(utcMillis("2000-02-29t02:00:00z")).toBe("2000-02-29T02:00:00.000Z");
  for (const value of [
    "1900-02-29T00:00:00Z",
    "2024-13-01T00:00:00Z",
    "2024-01-00T00:00:00Z",
    "2024-01-01T24:00:00Z",
    "2024-01-01T00:00:60Z",
    "2024-01-01T00:00:00.0001Z",
    "2024-01-01T00:00:00+24:00",
    "2024-01-01T00:00:00+01:60",
    "2024-01-01",
    "2024-01-01T00:00:00",
  ])
    expect(utcMillis(value)).toBeUndefined();
});

test("rejects unknown envelope and nested fields and bounds code points", () => {
  const decode = Schema.decodeUnknownResult(NotificationInput);
  for (const extra of [
    { signature: "supplied" },
    { source: "other" },
    { destination: "COTHER" },
  ])
    expect(Result.isFailure(decode({ ...input, ...extra }))).toBe(true);
  expect(
    Result.isFailure(
      decode({ ...input, payload: { ...input.payload, command: "run" } }),
    ),
  ).toBe(true);
  for (const payload of [
    { title: "😀".repeat(201) },
    { title: "ok", body: "😀".repeat(2801) },
    { title: "ok", url: `https://example.org/${"a".repeat(2048)}` },
  ])
    expect(Result.isFailure(decode({ ...input, payload }))).toBe(true);
  expect(
    Result.isSuccess(
      decode({
        ...input,
        payload: { title: "😀".repeat(200), body: "😀".repeat(2800) },
      }),
    ),
  ).toBe(true);
  for (const tags of [
    Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`k${n}`, "v"])),
    { ["k".repeat(65)]: "v" },
    { key: "v".repeat(257) },
  ])
    expect(Result.isFailure(decode({ ...input, tags }))).toBe(true);
  expect(Result.isFailure(decode({ ...input, topic: "a".repeat(201) }))).toBe(
    true,
  );
});

test("HTTPS URLs reject userinfo, whitespace and controls without fetching", () => {
  const decode = Schema.decodeUnknownResult(NotificationInput);
  for (const url of [
    "http://example.org",
    "https://user:pass@example.org",
    "https://@example.org",
    "https://example.org/a b",
    "https://example.org/\n",
    "https://example.org/\u0000",
  ])
    expect(
      Result.isFailure(decode({ ...input, payload: { title: "ok", url } })),
    ).toBe(true);
  expect(
    Result.isSuccess(
      decode({
        ...input,
        payload: { title: "ok", url: "https://example.org/path?q=1#part" },
      }),
    ),
  ).toBe(true);
});

test("signature deduplicates equivalent occurrences, not next events or sources", () => {
  const first = signature(source, {
    ...input,
    tags: { z: "last", A: "first", a: "middle" },
  });
  expect(first).toBe(
    "v1:f00f2453223945157b71841e40e4424603569a60d3a8f80c2ee2f666805f1872",
  );
  expect(
    signature(source, {
      ...input,
      occurredAt: "2026-11-19T03:00:00.000+01:00",
      tags: { a: "middle", z: "last", A: "first" },
      payload: { body: "", title: "Ready" },
    }),
  ).toBe(first);
  expect(signature(source, input)).toBe(
    signature(source, {
      ...input,
      tags: {},
      payload: { ...input.payload, body: "" },
    }),
  );
  expect(
    signature(source, { ...input, occurredAt: "2026-11-20T02:00:00Z" }),
  ).not.toBe(signature(source, input));
  expect(signature({ ...source, principal: "other" }, input)).not.toBe(
    signature(source, input),
  );
  expect(signature({ ...source, adapter: "poller" }, input)).not.toBe(
    signature(source, input),
  );
});

test("matching uses final-star and AND tags, deduplicates physical aliases", () => {
  expect(topicMatches("release.*", "release")).toBe(false);
  expect(topicMatches("release.*", "release.desktop.stable")).toBe(true);
  expect(topicMatches("release.desktop", "release.desktop.stable")).toBe(false);
  const destinations = {
    primary: destination,
    alias: { ...destination },
    other: { ...destination, channel: "CTWO" },
  };
  expect(
    resolveSubscriptions(
      source,
      { ...input, tags: { stage: "stable", project: "desktop" } },
      [
        {
          topic: "release.*",
          tags: { stage: ["stable"], project: ["desktop"] },
          to: ["primary", "alias"],
        },
        { topic: "release.desktop", to: ["alias"] },
        { topic: "release.*", tags: { stage: ["preview"] }, to: ["other"] },
      ],
      destinations,
    ),
  ).toEqual([destination]);
  expect(() =>
    resolveSubscriptions(
      source,
      input,
      [{ topic: "release.*", to: ["primary", "missing"] }],
      destinations,
    ),
  ).toThrow();
  expect(() =>
    resolveSubscriptions(
      source,
      input,
      [{ topic: "release.*", to: ["primary", "public"] }],
      {
        ...destinations,
        public: { ...destination, channel: "CPUBLIC", audience: "public" },
      },
    ),
  ).toThrow();
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(Destination)({
        ...destination,
        channel: "DONE",
      }),
    ),
  ).toBe(true);
});

test("numeric limits are positive finite and attempts cannot outlive leases", () => {
  for (const admissionQueue of [0, -1, Infinity, NaN, 1.5])
    expect(() => notificationLimits({ admissionQueue })).toThrow();
  expect(() => notificationLimits({ attemptTimeoutMs: 60000 })).toThrow();
  expect(() => notificationLimits({ concurrency: 5 })).toThrow();
  expect(() => notificationLimits({ sendAttempts: 4 })).toThrow();
});
