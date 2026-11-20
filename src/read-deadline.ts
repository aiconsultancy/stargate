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
  const abort = () => aborted.reject(signal.reason);
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
    .finally(() => signal.removeEventListener("abort", abort));
  const settled = reading.then(
    () => undefined,
    () => undefined,
  );
  return { result, settled };
}

/** Share one attempt and allow one retry while an abort-ignoring read drains. */
export function createReadSlot<T>(timeout: number, onIdle?: () => void) {
  type Attempt = { result: Promise<T>; abandonAt: number };
  let pending: Attempt | undefined;
  let abandoned: Attempt | undefined;
  return {
    get pending() {
      // Check on demand so stopped pollers do not leave recovery timers behind.
      if (pending && !abandoned && performance.now() >= pending.abandonAt) {
        abandoned = pending;
        pending = undefined;
      }
      return pending;
    },
    start(parent: AbortSignal, read: (signal: AbortSignal) => Promise<T>) {
      const { result, settled } = readWithDeadline(parent, timeout, read);
      const attempt = { result, abandonAt: performance.now() + 3 * timeout };
      pending = attempt;
      void settled.then(() => {
        if (pending === attempt) pending = undefined;
        if (abandoned === attempt) abandoned = undefined;
        if (!pending && !abandoned) onIdle?.();
      });
      return attempt;
    },
  };
}
