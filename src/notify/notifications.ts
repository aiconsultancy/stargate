import { setTimeout as delay } from "node:timers/promises";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Queue,
  Result,
  Schema,
} from "effect";
import { abortable } from "../effect";
import {
  type Accepted,
  Destination,
  InvalidNotification,
  type Limits,
  NotificationInput,
  type PublishError,
  QueueFull,
  ShuttingDown,
  Source,
  StoreUnavailable,
  Subscription,
  TopicNotGranted,
} from "./model";
import type { NotificationSink, SinkOutcome } from "./sink";
import { type NotificationCounters, NotifyStore } from "./store";
import { resolveSubscriptions, topicMatches } from "./subscriptions";

export class Notifications extends Context.Service<
  Notifications,
  {
    publish(
      source: Source,
      input: NotificationInput,
    ): Effect.Effect<Accepted, PublishError>;
  }
>()("stargate/notify/Notifications") {}

export interface NotificationTiming {
  now(): number;
  /** Cancellation must settle this wait. No provider or store operation here. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
const timing: NotificationTiming = {
  now: Date.now,
  wait: async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
};
export interface NotificationOptions {
  readonly path: string;
  readonly subscriptions: readonly Subscription[];
  readonly destinations: Readonly<Record<string, Destination>>;
  readonly sink: NotificationSink;
  readonly limits?: Partial<Limits>;
  readonly timing?: NotificationTiming;
}
export type ShutdownResult =
  | { readonly state: "closed" }
  | { readonly state: "unresolved"; readonly active: number };
type NotificationsService = Notifications["Service"];
export interface NotificationCore extends NotificationsService {
  readonly counters: NotificationCounters;
  /** Supervisor must observe this failure and initiate the normal shutdown. */
  readonly failure: Effect.Effect<never, StoreUnavailable>;
  /** Synchronous early intake gate, before runtime worker interruption. */
  closeAdmission(): void;
  /** Unresolved means store ownership is retained. Runtime must terminate. */
  shutdown(): Promise<ShutdownResult>;
}
interface Admission {
  readonly source: Source;
  readonly input: NotificationInput;
  readonly result: Deferred.Deferred<Accepted, PublishError>;
}

/** Caller holds the instance lock. The scope owns this core and its store. */
export const makeNotifications = Effect.fn("notify.makeNotifications")(
  function* (options: NotificationOptions) {
    const clock = options.timing ?? timing;
    const store = yield* Effect.try({
      try: () => new NotifyStore(options.path, options.limits),
      catch: () => new StoreUnavailable(),
    });
    let initialized = false;
    try {
      const subscriptions = Schema.decodeUnknownResult(
        Schema.Array(Subscription).check(Schema.isMaxLength(512)),
      )(options.subscriptions);
      const destinations = Schema.decodeUnknownResult(
        Schema.Record(Schema.String, Destination).check(
          Schema.makeFilter((value) => Object.keys(value).length <= 128),
        ),
      )(options.destinations);
      if (Result.isFailure(subscriptions) || Result.isFailure(destinations))
        return yield* Effect.fail(new StoreUnavailable());
      yield* Effect.try({
        try: () => store.recover(clock.now()),
        catch: () => new StoreUnavailable(),
      });
      const queue = yield* Queue.dropping<Admission>(
        store.limits.admissionQueue,
      );
      const failure = yield* Deferred.make<never, StoreUnavailable>();
      const pending = new Set<Admission>();
      const active = new Map<
        number,
        { controller: AbortController; promise: Promise<void> }
      >();
      const wake = new AbortController();
      let closing = false;
      let storeClosed = false;
      let shutdownRun: Promise<ShutdownResult> | undefined;

      const closeAdmission = () => {
        closing = true;
        for (const admission of pending)
          Deferred.doneUnsafe(
            admission.result,
            Effect.fail(new ShuttingDown()),
          );
        pending.clear();
        Queue.shutdownUnsafe(queue);
        wake.abort();
      };
      const fail = () => {
        Deferred.doneUnsafe(failure, Effect.fail(new StoreUnavailable()));
        closeAdmission();
      };
      const publish = Effect.fn("notify.publish")(function* (
        source: Source,
        input: NotificationInput,
      ): Effect.fn.Return<Accepted, PublishError> {
        if (closing) return yield* Effect.fail(new ShuttingDown());
        const checkedSource = Schema.decodeUnknownResult(Source)(source);
        const checkedInput =
          Schema.decodeUnknownResult(NotificationInput)(input);
        if (Result.isFailure(checkedSource) || Result.isFailure(checkedInput))
          return yield* Effect.fail(new InvalidNotification());
        if (
          !checkedSource.success.topics.some((pattern) =>
            topicMatches(pattern, checkedInput.success.topic),
          )
        )
          return yield* Effect.fail(new TopicNotGranted());
        const result = yield* Deferred.make<Accepted, PublishError>();
        const admission: Admission = {
          source: checkedSource.success,
          input: checkedInput.success,
          result,
        };
        // Offer and bookkeeping are one non-suspending operation. The owner, not
        // the caller's fiber, owns every successfully offered admission.
        const offered = yield* Effect.sync(() => {
          if (closing) return "closed";
          if (!Queue.offerUnsafe(queue, admission)) return "full";
          pending.add(admission);
          return "offered";
        });
        if (offered === "closed") return yield* Effect.fail(new ShuttingDown());
        if (offered === "full") return yield* Effect.fail(new QueueFull());
        return yield* Deferred.await(result);
      });

      const admissionFiber = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (!closing) {
            const admission = yield* Queue.take(queue);
            yield* Effect.sync(() => {
              if (closing) {
                Deferred.doneUnsafe(
                  admission.result,
                  Effect.fail(new ShuttingDown()),
                );
                pending.delete(admission);
                return;
              }
              try {
                const accepted = store.admit(
                  admission.source,
                  admission.input,
                  () =>
                    resolveSubscriptions(
                      admission.source,
                      admission.input,
                      subscriptions.success,
                      destinations.success,
                    ),
                  clock.now(),
                );
                Deferred.doneUnsafe(admission.result, Effect.succeed(accepted));
              } catch {
                Deferred.doneUnsafe(
                  admission.result,
                  Effect.fail(new StoreUnavailable()),
                );
              }
              pending.delete(admission);
            });
          }
        }),
      );

      const launch = (claim: NonNullable<ReturnType<NotifyStore["claim"]>>) => {
        const controller = new AbortController();
        const deadline = new AbortController();
        const timeout = clock
          .wait(store.limits.attemptTimeoutMs, deadline.signal)
          .then(
            () => controller.abort(),
            () => {},
          );
        const run = abortable<SinkOutcome>(async (signal) => {
          let allowed = false;
          try {
            allowed = options.sink.allowed(claim.destination);
          } catch {
            /* fail closed */
          }
          if (!allowed) return { state: "refused", retryable: false };
          try {
            return await options.sink.send(
              claim.destination,
              claim.payload,
              signal,
            );
          } catch {
            return { state: "unknown" };
          }
        });
        const promise = Effect.runPromise(run, { signal: controller.signal })
          .then(
            (outcome) => {
              store.settle(claim, outcome, clock.now());
            },
            () => {
              store.settle(claim, { state: "unknown" }, clock.now());
            },
          )
          .catch(() => {
            fail();
          })
          .finally(() => {
            deadline.abort();
          })
          .then(() => timeout)
          .then(() => {
            active.delete(claim.id);
          });
        active.set(claim.id, { controller, promise });
      };
      const scheduler = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (!closing) {
            try {
              while (!closing && active.size < store.limits.concurrency) {
                const claim = store.claim(clock.now());
                if (!claim) break;
                launch(claim);
              }
            } catch {
              fail();
            }
            if (!closing)
              yield* abortable(
                (signal) =>
                  clock.wait(25, AbortSignal.any([signal, wake.signal])),
                () => new ShuttingDown(),
              ).pipe(Effect.catch(() => Effect.void));
          }
        }),
      );

      const shutdown = (): Promise<ShutdownResult> => {
        if (storeClosed) return Promise.resolve({ state: "closed" });
        if (shutdownRun !== undefined) return shutdownRun;
        closeAdmission();
        for (const attempt of active.values()) attempt.controller.abort();
        const grace = new AbortController();
        const settled = Promise.all([
          Effect.runPromise(Fiber.await(admissionFiber)),
          Effect.runPromise(Fiber.await(scheduler)),
          ...[...active.values()].map((attempt) => attempt.promise),
        ]).then(() => true);
        shutdownRun = Promise.race([
          settled,
          clock
            .wait(store.limits.shutdownGraceMs, grace.signal)
            .then(() => false),
        ])
          .then((quiet): ShutdownResult => {
            grace.abort();
            if (!quiet) return { state: "unresolved", active: active.size };
            store.close();
            storeClosed = true;
            return { state: "closed" };
          })
          .finally(() => {
            shutdownRun = undefined;
          });
        return shutdownRun;
      };
      const core: NotificationCore = {
        publish,
        closeAdmission,
        shutdown,
        counters: store.counters,
        failure: Deferred.await(failure),
      };
      yield* Effect.addFinalizer(() => Effect.promise(shutdown));
      initialized = true;
      return core;
    } finally {
      if (!initialized) store.close();
    }
  },
  // Acquisition must register the store finalizer before interruption can
  // release its parent scope. Forked workers remain interruptible.
  Effect.uninterruptible,
);
