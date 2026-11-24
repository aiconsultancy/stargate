import { appendFileSync } from "node:fs";
import type {
  Destination,
  NotificationInput,
  Source,
} from "../src/notifications/ingest/model";
import type { NotificationSink } from "../src/notifications/ingest/sink";
import { NotifyStore } from "../src/notifications/ingest/store";

const path = process.argv[2];
const point = process.argv[3];

if (!path || !point) {
  throw new Error("Missing crash fixture arguments");
}

const store = new NotifyStore(
  path,
  {},
  point === "before-commit" ? hold : undefined,
);

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

function hold(): never {
  console.log("ready");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("Crash fixture unexpectedly resumed");
}

store.admit(source, input, () => [destination], 1000);

if (point === "after-commit") {
  hold();
}

const claim = store.claim(1000);

if (!claim) {
  throw new Error("Missing crash fixture claim");
}

if (point === "after-claim") {
  hold();
}

if (point !== "after-acceptance") {
  throw new Error("Unknown crash fixture point");
}

// Fake provider acceptance. The Promise never settles, so the real claimed
// Row remains leased when the parent kills this process.
const sink: NotificationSink = {
  allowed: () => true,
  send: async () => {
    appendFileSync(`${path}.sent`, "accepted\n");
    hold();
  },
};

await sink.send(claim.destination, claim.payload, new AbortController().signal);
