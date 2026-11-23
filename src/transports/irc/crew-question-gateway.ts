import { setTimeout as delay } from "node:timers/promises";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { OpenCodeBackend } from "../../backends/opencode/opencode";
import { type BackendConfig, secret } from "../../config";
import {
  type CrewQuestionReceipt,
  CrewQuestionRpc,
  type CrewQuestionWork,
} from "../../crew/questions/question-handoff";
import { questionFingerprint } from "../../questions/questions";

type Config = Extract<BackendConfig, { type: "opencode" }>;

/** Only the owning gateway connects to the native form API. All RPC calls use
 * its fixed captain location. Worker commands contain no endpoint or credentials. */
export class CrewQuestionGateway {
  private readonly client: OpenCodeClient;
  public constructor(
    private readonly captain: Config,
    env: NodeJS.ProcessEnv,
    client?: OpenCodeClient,
  ) {
    this.client =
      client ??
      OpenCode.make({
        baseUrl: captain.url,
        headers: Object.fromEntries(
          Object.entries(captain.headersEnv).map(([header, name]) => [
            header,
            secret(name, env),
          ]),
        ),
      });
  }

  public async execute(
    work: CrewQuestionWork,
    confirm: () => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<CrewQuestionReceipt> {
    const { owner, action } = work;

    if (
      owner.captain !== this.captain.sessionID ||
      owner.session === owner.captain
    )
      return { status: "mismatch" };

    const worker = await this.client.session.get(
      { sessionID: owner.session },
      { signal },
    );

    const identity = worker.metadata?.["stargateCrew"];

    if (
      worker.id !== owner.session ||
      worker.parentID ||
      worker.fork ||
      worker.location.directory !== owner.directory ||
      worker.agent !== owner.agent ||
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      identity["namespace"] !== owner.namespace ||
      identity["crewID"] !== owner.crew
    )
      return { status: "mismatch" };

    const backend = new OpenCodeBackend(
      {
        type: "opencode",
        url: this.captain.url,
        directory: owner.directory,
        sessionID: owner.session,
        permissions: [],
        headersEnv: {},
      },
      this.client,
    );

    if (action.kind === "list") {
      const questions = await backend.pendingQuestions(owner.session, signal);

      if (questions.length > 16) return { status: "failed" };

      return {
        status: "ok",
        forms: questions
          .filter((q) => !("unsupported" in q) && q.inputID === owner.input)
          .map((q) => JSON.stringify(q)),
      };
    }

    if (action.kind === "outcome") {
      const form = await this.client.session.form.get(
        { sessionID: owner.session, formID: action.form },
        { signal },
      );

      if (
        form.id !== action.form ||
        form.sessionID !== owner.session ||
        questionFingerprint({
          id: form.id,
          sessionID: form.sessionID,
          title: form.title,
          metadata: form.metadata,
          fields: form.fields,
        }) !== action.fingerprint
      )
        return { status: "mismatch" };

      return {
        status:
          form.state.status === "answered" || form.state.status === "cancelled"
            ? form.state.status
            : "unknown",
      };
    }

    if (
      !(await backend.questionBelongsToInput(
        owner.session,
        action.form,
        owner.input,
        action.fingerprint,
        signal,
      ))
    )
      return { status: "mismatch" };

    if (action.kind === "check") return { status: "ok" };

    if (!(await confirm())) return { status: "mismatch" };
    signal.throwIfAborted();
    const target = { sessionID: owner.session, formID: action.form };

    if (action.answer === null)
      await this.client.session.form.cancel(target, { signal });
    else
      await this.client.session.form.reply(
        {
          ...target,
          answer: Object.fromEntries(
            Object.entries(action.answer).map(([key, v]) => [
              key,
              typeof v === "string" ? v : [...v],
            ]),
          ),
        },
        { signal },
      );

    return { status: "ok" };
  }

  public async run(stop: AbortSignal) {
    const captain = this.captain.sessionID;

    if (!captain) return;
    const rpc = this.client.rpc(CrewQuestionRpc);
    const location = { directory: this.captain.directory };

    while (!stop.aborted) {
      let pause = 1000;

      try {
        const signal = AbortSignal.any([stop, AbortSignal.timeout(8000)]);
        const options = { location, signal };
        const { work } = await rpc.take({ captain }, options);

        if (work) {
          const target = { captain, id: work.id };

          const result = await this.execute(
            work,
            async () => (await rpc.confirm(target, options)).approved,
            signal,
          ).catch((): CrewQuestionReceipt => ({ status: "failed" }));

          await rpc.finish({ ...target, result }, options);
          pause = 0;
        }
      } catch {
        pause = 3000;
      }

      await delay(pause, undefined, { signal: stop }).catch(() => {});
    }
  }
}
