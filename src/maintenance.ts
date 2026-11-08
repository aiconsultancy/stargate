import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

export const maintenanceWindowMs = 300_000;
export const maintenancePlanSchema = z.strictObject({
  plan: z.string().trim().min(1).max(1000),
  impact: z.string().trim().min(1).max(500),
  rollback: z.string().trim().min(1).max(500),
});
export const maintenanceNoticeSchema = maintenancePlanSchema.extend({
  id: z.string().min(1).max(100),
});
export type MaintenanceNotice = z.infer<typeof maintenanceNoticeSchema>;
export interface MaintenanceWatch {
  read(signal: AbortSignal): Promise<MaintenanceNotice | null>;
  delivered(id: string, signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
}
const owner = z.strictObject({
  sessionID: z.string().min(1).max(100),
  id: z.string().min(1).max(100),
});
export const MaintenanceRPC = Rpc.define({
  id: "pogo.maintenance",
  events: {},
  methods: {
    open: { input: owner, output: z.boolean() },
    read: { input: owner, output: maintenanceNoticeSchema.nullable() },
    delivered: {
      input: owner.extend({ noticeID: z.string().min(1).max(100) }),
      output: z.boolean(),
    },
    close: { input: owner, output: z.boolean() },
  },
});

export function maintenanceText(notice: MaintenanceNotice) {
  return `Planned maintenance: ${notice.plan}\n\nImpact: ${notice.impact}\nRollback: ${notice.rollback}\n\nI will wait five minutes after this notice is delivered. Select Stop to opt out. Silence permits only this reversible maintenance, not destructive changes, credentials or wider access.`;
}

/** Only the confirmed opt-out wait is excluded from the normal turn budget. */
export class TurnBudget {
  readonly controller = new AbortController();
  private timer: (() => void) | undefined;
  private remaining: number;
  private started: number;

  constructor(
    ms: number,
    private readonly now = () => performance.now(),
    private readonly schedule = (ms: number, expire: () => void) => {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
  ) {
    this.remaining = ms;
    this.started = now();
    this.resume();
  }

  pause() {
    if (this.timer === undefined) return;
    this.timer();
    this.timer = undefined;
    this.remaining = Math.max(0, this.remaining - (this.now() - this.started));
  }

  resume() {
    if (this.timer !== undefined || this.controller.signal.aborted) return;
    this.started = this.now();
    this.timer = this.schedule(this.remaining, () => this.controller.abort());
  }

  close() {
    this.timer?.();
  }
}
