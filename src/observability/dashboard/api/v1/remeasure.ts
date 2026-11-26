/**
 * Settled turns changed late are measured again, whole and exactly, once
 * per `windowMs` rather than at every streamed frame. A late write only
 * clears the turn's cached size; the window's single `settle` measures and
 * evicts, so a burst of late frames on a large turn serialises it once,
 * including new entries' separators and the aggregate usage. `drain`
 * settles a pending window at once, before any turn begins or ends, against
 * the turns as they were: eviction never sums a stale size, a size that
 * shrank late cannot evict an older turn that fits, and the boundary's turn
 * never counts against the late writes.
 */
export function remeasurer(settle: () => void, windowMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drain = () => {
    if (timer === undefined) {
      return;
    }

    clearTimeout(timer);
    timer = undefined;
    settle();
  };

  // A running turn is measured when its family settles.
  const mark = (turn: { endedAt: number | null }) => {
    if (turn.endedAt === null || timer !== undefined) {
      return;
    }

    timer = setTimeout(drain, windowMs);
    timer.unref?.();
  };

  return Object.assign(mark, { drain });
}
