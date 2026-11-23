import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import { settingsStruct } from "../config/settings-schema";

export const maintenanceWindowMs = 300_000;

// Zod trimmed first and counted code points; keep both for the plan text.
const text = (maximum: number) =>
  Schema.Trim.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(maximum));

const id = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(100),
);

const planFields = {
  plan: text(1000),
  impact: text(500),
  rollback: text(500),
};

export const maintenancePlanSchema = settingsStruct(planFields);
export const maintenanceNoticeSchema = settingsStruct({ ...planFields, id });

export type MaintenanceNotice = typeof maintenanceNoticeSchema.Type;

export interface MaintenanceWatch {
  read(signal: AbortSignal): Promise<MaintenanceNotice | null>;
  delivered(id: string, signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
}

const ownerFields = { sessionID: id, id };
const owner = settingsStruct(ownerFields);

// Clients require Standard Schema definitions.
// OpenCode decodes and encodes these Effect codecs without caller options.
const portable = Schema.toStandardSchemaV1;

export const MaintenanceRPC = Rpc.define({
  id: "stargate.maintenance",
  events: {},
  methods: {
    open: { input: portable(owner), output: portable(Schema.Boolean) },
    read: {
      input: portable(owner),
      output: portable(Schema.NullOr(maintenanceNoticeSchema)),
    },
    delivered: {
      input: portable(settingsStruct({ ...ownerFields, noticeID: id })),
      output: portable(Schema.Boolean),
    },
    close: { input: portable(owner), output: portable(Schema.Boolean) },
  },
});

export function maintenanceText(notice: MaintenanceNotice) {
  return `Planned maintenance: ${notice.plan}\n\nImpact: ${notice.impact}\nRollback: ${notice.rollback}\n\nI will wait five minutes after this notice is delivered. Select Stop to opt out. Silence permits only this reversible maintenance, not destructive changes, credentials or wider access.`;
}

/** Only the confirmed opt-out wait is excluded from the normal turn budget. */
export class TurnBudget {
  public readonly controller = new AbortController();
  private timer: (() => void) | undefined;
  private remaining: number;
  private started: number;

  public constructor(
    ms: number,
    private readonly now = () => performance.now(),
    private readonly schedule = (ms: number, expire: () => void) => {
      const timer = setTimeout(expire, ms);

      return () => {
        clearTimeout(timer);
      };
    },
  ) {
    this.remaining = ms;
    this.started = now();
    this.resume();
  }

  public pause() {
    if (this.timer === undefined) return;
    this.timer();
    this.timer = undefined;
    this.remaining = Math.max(0, this.remaining - (this.now() - this.started));
  }

  public resume() {
    if (this.timer !== undefined || this.controller.signal.aborted) return;
    this.started = this.now();
    this.timer = this.schedule(this.remaining, () => {
      this.controller.abort();
    });
  }

  public close() {
    this.timer?.();
  }
}
