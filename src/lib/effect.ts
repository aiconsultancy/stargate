import { Effect, Exit, Scope } from "effect";

/**
 * Run a signal-aware Promise as an Effect. Interruption aborts its signal and
 * then waits until the Promise settles. `Effect.promise` alone resumes
 * interruption immediately, so agent cleanup, interrupts and SQLite writes
 * could otherwise outlive the scope that closes their resources.
 *
 * Without `onError`, a rejection is a defect. With it, the mapped value is a
 * typed failure.
 */
export function abortable<A>(
  run: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A>;
export function abortable<A, E>(
  run: (signal: AbortSignal) => PromiseLike<A>,
  onError: (error: unknown) => E,
): Effect.Effect<A, E>;
export function abortable<A, E>(
  run: (signal: AbortSignal) => PromiseLike<A>,
  onError?: (error: unknown) => E,
): Effect.Effect<A, E> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      const controller = new AbortController();
      let promise: Promise<A>;

      try {
        promise = Promise.resolve(run(controller.signal));
      } catch (error) {
        promise = Promise.reject(error);
      }

      const settled = promise.then(
        () => {},
        () => {},
      );

      const wait = onError
        ? Effect.tryPromise({ try: () => promise, catch: onError })
        : Effect.promise(() => promise);

      return restore(wait).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            controller.abort();
          }).pipe(Effect.andThen(Effect.promise(() => settled))),
        ),
      );
    }),
  );
}

/**
 * Promise boundary for callers that still own an `AbortSignal`. An abort
 * interrupts the program, which then runs its finalizers before rejecting.
 */
export function runAbortable<A, E>(
  program: Effect.Effect<A, E>,
  signal: AbortSignal,
): Promise<A> {
  return Effect.runPromise(program, { signal });
}

/**
 * A Promise-facing scope for hosts that accept one cleanup callback, such as
 * OpenCode plugin setup. `close` runs every release in reverse acquisition
 * order, continues after a failed release, rejects afterwards, and is
 * idempotent.
 */
export function resourceScope() {
  const scope = Effect.runSync(Scope.make());

  return {
    own<A>(
      acquire: () => Promise<A>,
      release: (value: A) => unknown,
    ): Promise<A> {
      return Effect.runPromise(
        Effect.acquireRelease(Effect.promise(acquire), (value) =>
          Effect.promise(async () => {
            await release(value);
          }),
        ).pipe(Scope.provide(scope)),
      );
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
