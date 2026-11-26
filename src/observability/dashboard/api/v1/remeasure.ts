/**
 * Settled turns changed late are measured again, whole and exactly, once
 * per `windowMs` rather than at every streamed frame. A late write only
 * clears the turn's cached size; the window's single `settle` measures and
 * evicts, so a burst of late frames on a large turn serialises it once,
 * including new entries' separators and the aggregate usage. `flush` cancels
 * the window when the caller settles sooner, before any turn begins or ends,
 * so that eviction never sums a stale size: a size that shrank late could
 * otherwise evict an older turn that fits.
 */
export function remeasurer(settle: () => void, windowMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  // A running turn is measured when its family settles.
  const mark = (turn: { endedAt: number | null }) => {
    if (turn.endedAt === null || timer !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      flush();
      settle();
    }, windowMs);
    timer.unref?.();
  };

  return Object.assign(mark, { flush });
}
