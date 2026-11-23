import { expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import { abortable, resourceScope, runAbortable } from "../src/lib/effect";

test("interruption aborts the Promise and waits until it settles", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        abortable(
          (signal) =>
            new Promise<void>((resolve) =>
              signal.addEventListener("abort", () =>
                setTimeout(() => {
                  events.push("cleanup finished");
                  resolve();
                }, 20),
              ),
            ),
        ),
      );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      events.push("interrupt returned");
    }),
  );
  expect(events).toEqual(["cleanup finished", "interrupt returned"]);
});

test("rejections are typed only when mapped", async () => {
  class Failed extends Error {}

  const typed = await Effect.runPromiseExit(
    abortable(
      async () => {
        throw new Error("raw details");
      },
      () => new Failed("safe"),
    ),
  );

  expect(Exit.isFailure(typed) && Exit.hasFails(typed)).toBe(true);

  const defect = await Effect.runPromiseExit(
    abortable(() => {
      throw new Error("synchronous");
    }),
  );

  expect(Exit.isFailure(defect) && Exit.hasDies(defect)).toBe(true);
});

test("an aborted caller signal interrupts and finalizes the program", async () => {
  const controller = new AbortController();
  const events: string[] = [];

  const run = runAbortable(
    Effect.never.pipe(
      Effect.ensuring(Effect.sync(() => events.push("finalized"))),
    ),
    controller.signal,
  );

  controller.abort();
  await expect(run).rejects.toThrow();
  expect(events).toEqual(["finalized"]);
});

test("a resource scope releases everything in reverse order once", async () => {
  const events: string[] = [];
  const scope = resourceScope();
  await scope.own(
    async () => "engine",
    (name) => events.push(name),
  );
  await scope.own(
    async () => "registration A",
    async (name) => {
      events.push(name);
      throw new Error("dispose failed");
    },
  );
  await scope.own(
    async () => "registration B",
    (name) => events.push(name),
  );
  await expect(
    scope.own(
      async () => {
        throw new Error("not acquired");
      },
      () => events.push("never released"),
    ),
  ).rejects.toThrow("not acquired");
  await expect(scope.close()).rejects.toThrow("dispose failed");
  await scope.close();
  expect(events).toEqual(["registration B", "registration A", "engine"]);
});
