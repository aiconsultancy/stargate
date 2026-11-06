import { expect, test } from "bun:test";
import { type CompactionEvents, compactAndWait } from "../src/crew/compaction";

test("compact-first waits for its correlated completion, not admission or another session", async () => {
  let requestID: string | undefined;
  let admit = () => {};
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const events: CompactionEvents = {
    async *subscribe() {
      await admitted;
      yield {
        type: "session.compaction.ended",
        data: { sessionID: "ses_other" },
      };
      yield {
        type: "session.compaction.ended",
        data: { sessionID: "ses_worker" },
      };
      yield {
        type: "session.compaction.started",
        data: { sessionID: "ses_worker", inputID: requestID },
      };
      yield {
        type: "session.compaction.ended",
        data: { sessionID: "ses_worker" },
      };
    },
  };
  await compactAndWait(
    {
      async compact(input) {
        requestID = input.id;
        admit();
      },
    },
    events,
    "ses_worker",
    new AbortController().signal,
  );
  expect(requestID).toMatch(/^msg_/);
});

test("compaction failure is not treated as successful compact-first", async () => {
  const events: CompactionEvents = {
    async *subscribe() {
      yield {
        type: "session.compaction.failed",
        data: { sessionID: "ses_worker" },
      };
    },
  };
  await expect(
    compactAndWait(
      { async compact() {} },
      events,
      "ses_worker",
      new AbortController().signal,
    ),
  ).rejects.toThrow("not confirmed");
});

test("already aborted compaction does not admit underlying work", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const events: CompactionEvents = { async *subscribe() {} };
  await expect(
    compactAndWait(
      {
        async compact() {
          called = true;
        },
      },
      events,
      "ses_worker",
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
});
