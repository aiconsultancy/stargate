import { Effect, Exit, Scope } from "effect";
import type { Logger } from "pino";
import type { notificationRoutes } from "../notifications/ingest/http";
import type { NotificationCore } from "../notifications/ingest/notifications";

type ShutdownOptions = {
  shutdownGraceMs?: number;
  terminate?: () => never;
};

/** Keep notification resources owned until all writes have settled. */
export class NotificationShutdown {
  public core: NotificationCore | undefined;
  public scope: Scope.Closeable | undefined;
  public producer: ReturnType<typeof notificationRoutes> | undefined;
  public api: { closeAdmission(): void; stop(): Promise<void> } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping: Promise<void> | undefined;
  private closing = false;

  public constructor(
    private readonly enabled: boolean,
    private readonly log: Logger,
    private readonly options?: ShutdownOptions,
  ) {}

  public closeAdmission() {
    if (!this.enabled || this.closing) return;
    this.closing = true;
    // Referenced and armed before interruption or any unbounded stop wait.
    this.timer ??= setTimeout(
      () => {
        this.log.error(
          "Notification shutdown did not settle; terminating process",
        );

        if (this.options?.terminate) this.options.terminate();
        process.exit(1);
      },
      Math.min(this.options?.shutdownGraceMs ?? 25_000, 25_000),
    );
    this.producer?.closeAdmission();
    this.api?.closeAdmission();
    this.core?.closeAdmission();
  }

  public readonly stop = () => {
    if (!this.enabled) return Promise.resolve();
    this.closeAdmission();
    this.stopping ??= (async () => {
      const result = await this.core?.shutdown();

      if (result?.state === "unresolved") await new Promise<never>(() => {});
      await this.api?.stop();

      if (this.scope)
        await Effect.runPromise(Scope.close(this.scope, Exit.void));

      if (this.timer) clearTimeout(this.timer);
    })().catch(async () => {
      // Cleanup failure cannot prove quiescence. Keep ownership to hard exit.
      this.log.error("Notification cleanup did not establish settlement");
      await new Promise<never>(() => {});
    });

    return this.stopping;
  };
}
