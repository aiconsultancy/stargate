import { expect, test } from "bun:test";
import { Context, Deferred, Effect } from "effect";
import { nativeWait } from "../src/coordination/crew/execution/native-wait";

function fixture() {
  const idle = Effect.runSync(Deferred.make<void>());
  const started = Promise.withResolvers<void>();
  let observers = 0;

  const wait = nativeWait(
    () =>
      Effect.gen(function* () {
        observers++;
        started.resolve();
        yield* Deferred.await(idle);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            observers--;
          }),
        ),
      ),
    Context.empty(),
  );

  return {
    wait,
    started: started.promise,
    observers: () => observers,
    idle: () => Deferred.isDone(idle).pipe(Effect.runSync),
    finish: () => Deferred.succeed(idle, undefined).pipe(Effect.runSync),
  };
}

test("conversation eval: aborting an observation frees its waiter, not the busy worker", async () => {
  const f = fixture();
  const stop = new AbortController();

  const observation = f
    .wait({ sessionID: "ses_worker" }, { signal: stop.signal })
    .then(
      () => "idle",
      () => "cancelled",
    );

  try {
    await f.started;
    stop.abort();
    // No wall-clock score: all already-enqueued interruption work can run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.observers()).toBe(0);
    expect(f.idle()).toBe(false);
    expect(await observation).toBe("cancelled");
  } finally {
    f.finish();
    await observation;
  }
});

test("conversation eval: already-cancelled requests do not start a native observation", async () => {
  const f = fixture();

  const observation = f
    .wait({ sessionID: "ses_worker" }, { signal: AbortSignal.abort() })
    .then(
      () => "idle",
      () => "cancelled",
    );

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.observers()).toBe(0);
    expect(await observation).toBe("cancelled");
  } finally {
    f.finish();
    await observation;
  }
});
