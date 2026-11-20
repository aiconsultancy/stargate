/** Deliver the deadline separately from the lifetime of the underlying read. */
export function readWithDeadline<T>(
  parent: AbortSignal,
  timeout: number,
  read: (signal: AbortSignal) => Promise<T>,
) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeout)]);
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
