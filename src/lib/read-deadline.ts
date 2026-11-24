/** Deliver the deadline separately from the lifetime of the underlying read. */
export function readWithDeadline<T>(
  parent: AbortSignal,
  timeout: number | undefined,
  read: (signal: AbortSignal) => Promise<T>,
) {
  const signal =
    timeout === undefined
      ? parent
      : AbortSignal.any([parent, AbortSignal.timeout(timeout)]);

  const aborted = Promise.withResolvers<never>();

  const abort = () => {
    aborted.reject(signal.reason);
  };

  signal.addEventListener("abort", abort, { once: true });

  const reading = Promise.resolve().then(() => {
    signal.throwIfAborted();

    return read(signal);
  });

  const result = Promise.race([reading, aborted.promise])
    .then((value) => {
      signal.throwIfAborted();

      return value;
    })
    .finally(() => {
      signal.removeEventListener("abort", abort);
    });

  const settled = reading.then(
    () => {},
    () => {},
  );

  return { result, settled };
}

/** Share one attempt and allow one retry while an abort-ignoring read drains. */
export function createReadSlot<T>(timeout: number, onIdle?: () => void) {
  type Attempt = {
    result: Promise<T>;
    abandonAt: number;
    onAbandon: (() => void) | undefined;
  };

  let pending: Attempt | undefined;
  let abandoned: Attempt | undefined;

  function abandonPending() {
    if (!pending || abandoned) {
      return;
    }

    abandoned = pending;
    pending = undefined;
    abandoned.onAbandon?.();
  }

  return {
    get pending() {
      // Check on demand so stopped pollers do not leave recovery timers behind.
      if (pending && performance.now() >= pending.abandonAt) {
        abandonPending();
      }

      return pending;
    },
    abandon() {
      if (!pending) {
        return;
      }

      // If the abandoned position is full, retry as soon as it drains.
      pending.abandonAt = Number.NEGATIVE_INFINITY;
      abandonPending();
    },
    start(
      parent: AbortSignal,
      read: (signal: AbortSignal) => Promise<T>,
      options?: { timeout?: number; onAbandon?: () => void },
    ) {
      const { result, settled } = readWithDeadline(
        parent,
        options?.timeout ?? timeout,
        read,
      );

      const attempt = {
        result,
        abandonAt: performance.now() + 3 * timeout,
        onAbandon: options?.onAbandon,
      };

      pending = attempt;
      void settled.then(() => {
        if (pending === attempt) {
          pending = undefined;
        }

        if (abandoned === attempt) {
          abandoned = undefined;
        }

        if (!pending && !abandoned) {
          onIdle?.();
        }
      });

      return attempt;
    },
  };
}
