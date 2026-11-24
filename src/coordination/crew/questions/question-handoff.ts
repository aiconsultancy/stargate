import { randomUUID } from "node:crypto";
import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import {
  type NativeQuestion,
  type QuestionAnswer,
  nativeQuestionSchema,
} from "../../../chat/questions/native-question";
import { settingsStruct } from "../../../config/settings-schema";
import { messagePortableSchema as portable } from "../messaging/message-tool-input";
import type { CrewTask } from "../execution/state";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

const binding = settingsStruct({
  task: id,
  captain: id,
  session: id,
  input: id,
  crew: id,
  namespace: id,
  directory: Schema.String.check(Schema.isMaxLength(4096)),
  agent: id,
});

const form = {
  form: id,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
};

const value = Schema.String.check(Schema.isMaxLength(4000));

const answer = Schema.NullOr(
  Schema.Record(
    id,
    Schema.Union([value, Schema.Array(value).check(Schema.isMaxLength(20))]),
  ),
);

const action = Schema.Union([
  settingsStruct({ kind: Schema.Literal("list") }),
  settingsStruct({ kind: Schema.Literal("check"), ...form }),
  settingsStruct({ kind: Schema.Literal("outcome"), ...form }),
  settingsStruct({ kind: Schema.Literal("write"), ...form, answer }),
]);

const command = settingsStruct({ id, owner: binding, action });

const receipt = settingsStruct({
  status: Schema.Literals([
    "ok",
    "failed",
    "mismatch",
    "answered",
    "cancelled",
    "unknown",
  ]),
  // Reuse the native question codec on both sides of the transport.
  forms: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(96_000))).check(
      Schema.isMaxLength(16),
    ),
  ),
});

export const CrewQuestionRpc = Rpc.define({
  id: "stargate.crew.questions",
  events: {},
  methods: {
    take: {
      input: portable(settingsStruct({ captain: id })),
      output: portable(settingsStruct({ work: Schema.NullOr(command) })),
    },
    confirm: {
      input: portable(settingsStruct({ captain: id, id })),
      output: portable(settingsStruct({ approved: Schema.Boolean })),
    },
    finish: {
      input: portable(settingsStruct({ captain: id, id, result: receipt })),
      output: portable(settingsStruct({ received: Schema.Boolean })),
    },
  },
});

type Action = typeof action.Type;

export type CrewQuestionWork = typeof command.Type;

export type CrewQuestionReceipt = typeof receipt.Type;

type Pending = {
  work: CrewQuestionWork;
  taken: boolean;
  confirmed: boolean;
  current: () => boolean;
  finish: (result: CrewQuestionReceipt) => void;
};

// Allow one full gateway RPC deadline and a retry before forgetting the owner.
export const crewQuestionConsumerLeaseMs = 15_000;

/** Captain-location RPC mailbox. An in-flight write is never delivered twice.
 * CrewState holds the durable answer claim. Lost messages only lose observation. */
export class CrewQuestionHandoff {
  private readonly pending = new Map<string, Pending>();
  private lastTake = -Infinity;

  public constructor(
    private readonly captain: string | undefined,
    private readonly now = () => performance.now(),
  ) {}

  public hasConsumer() {
    return this.now() - this.lastTake < crewQuestionConsumerLeaseMs;
  }

  public route(preference?: boolean, externalHistory = false) {
    if (preference === false) {
      return "direct";
    }

    if (preference || this.hasConsumer()) {
      return "gateway";
    }

    // A configured history service may be read-only. Its URL and credentials
    // Do not establish authority to read the exact form or submit an answer.
    return this.captain && externalHistory ? "unavailable" : "direct";
  }

  public take(captain: string) {
    if (captain !== this.captain) {
      return { work: null };
    }

    this.lastTake = this.now();

    for (const entry of this.pending.values()) {
      if (
        entry.work.owner.captain !== captain ||
        entry.taken ||
        !entry.current()
      ) {
        continue;
      }

      entry.taken = true;

      return { work: entry.work };
    }

    return { work: null };
  }

  public confirm(captain: string, id: string) {
    const entry = this.pending.get(id);

    if (
      !entry ||
      entry.work.owner.captain !== captain ||
      !entry.taken ||
      entry.confirmed ||
      entry.work.action.kind !== "write" ||
      !entry.current()
    ) {
      return { approved: false };
    }

    entry.confirmed = true;

    return { approved: true };
  }

  public finish(captain: string, id: string, result: CrewQuestionReceipt) {
    const entry = this.pending.get(id);

    if (!entry || entry.work.owner.captain !== captain || !entry.taken) {
      return { received: false };
    }

    entry.finish(
      entry.confirmed || entry.current() ? result : { status: "failed" },
    );

    return { received: true };
  }

  public backend(
    task: CrewTask,
    identity: Pick<
      CrewQuestionWork["owner"],
      "directory" | "agent" | "namespace"
    >,
    current: () => boolean,
  ) {
    const owner = {
      ...identity,
      task: task.id,
      captain: task.originCaptainID,
      session: task.workerSessionID,
      input: task.inputID,
      crew: task.crewID,
    };

    const request = async (action: Action, signal: AbortSignal) => {
      if (!current() || this.pending.size >= 64) {
        throw new Error("Crew question handoff unavailable");
      }

      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      deadline.throwIfAborted();
      const id = randomUUID();

      const { promise, resolve, reject } =
        Promise.withResolvers<CrewQuestionReceipt>();

      const abort = () => {
        reject(new Error("Crew question handoff interrupted"));
      };

      this.pending.set(id, {
        work: { id, owner, action },
        taken: false,
        confirmed: false,
        current,
        finish: resolve,
      });
      deadline.addEventListener("abort", abort, { once: true });

      try {
        const result = await promise;

        if (result.status === "failed") {
          throw new Error("Crew question handoff unavailable");
        }

        return result;
      } finally {
        deadline.removeEventListener("abort", abort);
        this.pending.delete(id);
      }
    };

    return {
      async pendingQuestions(session: string, signal: AbortSignal) {
        if (session !== owner.session) {
          return [];
        }

        const result = await request({ kind: "list" }, signal);

        if (result.status !== "ok" || !result.forms) {
          throw new Error("Crew question list unavailable");
        }

        return result.forms
          .map((raw) =>
            Schema.decodeUnknownSync(nativeQuestionSchema)(JSON.parse(raw)),
          )
          .filter((q) => q.sessionID === session && q.inputID === owner.input);
      },
      async questionBelongsToInput(
        session: string,
        form: string,
        input: string,
        fingerprint: string,
        signal: AbortSignal,
      ) {
        return (
          session === owner.session &&
          input === owner.input &&
          (await request({ kind: "check", form, fingerprint }, signal))
            .status === "ok"
        );
      },
      async replyQuestion(
        q: NativeQuestion,
        answer: QuestionAnswer | null,
        signal: AbortSignal,
      ) {
        if (
          q.sessionID !== owner.session ||
          q.inputID !== owner.input ||
          (
            await request(
              { kind: "write", form: q.id, fingerprint: q.fingerprint, answer },
              signal,
            )
          ).status !== "ok"
        ) {
          throw new Error("Crew answer outcome unconfirmed");
        }
      },
      async outcome(form: string, fingerprint: string, signal: AbortSignal) {
        const { status } = await request(
          { kind: "outcome", form, fingerprint },
          signal,
        );

        return status === "answered" || status === "cancelled"
          ? status
          : undefined;
      },
    };
  }
}
