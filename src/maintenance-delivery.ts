import { setTimeout as delay } from "node:timers/promises";
import type { AgentBackend } from "./backend";
import type { MaintenanceNotice } from "./maintenance";

type Input = {
  backend: AgentBackend;
  sessionID: string;
  requestID: string;
  signal: AbortSignal;
  publish(notice: MaintenanceNotice): Promise<void>;
  resume(): void;
  cancel(): void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Delivery failure or a lost gateway cancels the turn, never grants consent. */
export async function startMaintenanceDelivery(input: Input) {
  if (!input.backend.startMaintenance) return;
  const watch = await input.backend
    .startMaintenance(
      input.sessionID,
      input.requestID,
      AbortSignal.any([input.signal, AbortSignal.timeout(2000)]),
    )
    .catch(() => undefined);
  // Ordinary bots may not have the Stargate plugin. The captain tool fails closed
  // without this registration; failed setup never becomes a timed permit.
  if (!watch) return;
  const stop = new AbortController();
  const signal = AbortSignal.any([input.signal, stop.signal]);
  const wait = input.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const done = (async () => {
    let shown: string | undefined;
    try {
      while (!signal.aborted) {
        const request = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        const notice = await watch.read(request);
        signal.throwIfAborted();
        if (notice && notice.id !== shown) {
          await input.publish(notice);
          signal.throwIfAborted();
          await watch.delivered(
            notice.id,
            AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          );
          shown = notice.id;
        } else if (!notice && shown) {
          input.resume();
          shown = undefined;
        }
        await wait(1000, signal);
      }
    } catch {
      if (!signal.aborted) input.cancel();
    } finally {
      input.resume();
    }
  })();
  return {
    async close() {
      stop.abort();
      await done;
      await watch.close(AbortSignal.timeout(2000)).catch(() => {});
    },
  };
}
