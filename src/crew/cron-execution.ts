import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentListInput,
  ExperimentalGenerateTextInput,
  ModelListInput,
  SessionGetInput,
} from "@opencode/client";
import { Schema } from "effect";
import type { BackendContext } from "../backend";
import { PiDurableBackend } from "../backends/pi-durable";
import type { BackendConfig } from "../config";
import {
  type CronAdvanced,
  type CronEvaluation,
  cronModelSchema,
} from "../cron-advanced";
import {
  cronDecision,
  cronDecisionInstructions,
  cronEvaluateInputSchema,
  cronModelInputSchema,
  cronObservation,
  cronObservationInstructions,
  cronPublicText,
  cronRisk,
} from "../cron-decision";
import type { CrewCaller, CrewSession } from "./engine";
import { CrewError } from "./state";
import { defaultModelProviders, type Team } from "./team";

type ModelRef = NonNullable<CrewSession["model"]>;
type Request = { signal: AbortSignal };
export interface CronExecutionAPI {
  session: {
    get(input: SessionGetInput, request: Request): Promise<CrewSession>;
  };
  model: {
    list(
      input: ModelListInput,
      request: Request,
    ): Promise<{
      location: { directory: string };
      data: {
        providerID: string;
        id: string;
        enabled: boolean;
        variants: { id: string }[];
      }[];
    }>;
  };
  agent: {
    list(
      input: AgentListInput,
      request: Request,
    ): Promise<{
      location: { directory: string };
      data: { id: string; model?: ModelRef }[];
    }>;
  };
  /** SDK stateless generation: no session, history, agent loop or tools. */
  generate: {
    text(
      input: ExperimentalGenerateTextInput,
      request: Request,
    ): Promise<{ text: string }>;
  };
}
export interface CronExecutionAuthority {
  options: {
    team: Team;
    captainDirectory: string;
    captainSessionID?: string | undefined;
    stateDirectory: string;
  };
  captain(caller: CrewCaller): Promise<void>;
}
type PiConfig = Extract<BackendConfig, { type: "pi-durable" }>;
export interface CronArbiterBackend {
  createSession(input: {
    key: string;
    title: string;
    signal: AbortSignal;
  }): Promise<string>;
  prompt(sessionID: string, text: string, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
export type CronArbiterFactory = (
  config: PiConfig,
  context: BackendContext,
) => Promise<CronArbiterBackend>;
export type CronModelInput = Pick<CronAdvanced, "model" | "arbiter">;
export type CronEvaluateInput = CronModelInput & { id: string; prompt: string };

function modelName(model: ModelRef) {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}
function parseModel(value: string): ModelRef {
  Schema.decodeUnknownSync(cronModelSchema)(value);
  const separator = value.indexOf("/");
  const [id, variant] = value.slice(separator + 1).split("#");
  if (!id) throw new CrewError("Cron model selector is invalid.");
  return {
    providerID: value.slice(0, separator),
    id,
    ...(variant ? { variant } : {}),
  };
}

/** One admitted evaluation, never a replacement captain or a durable crew task.
 * The gateway commits its run claim before calling. Uncertain calls are not retried.
 */
export class CrewCronExecution {
  constructor(
    private readonly authority: CronExecutionAuthority,
    private readonly api: CronExecutionAPI,
    private readonly pi: CronArbiterFactory = PiDurableBackend.open,
  ) {}

  async model(input: CronModelInput, signal: AbortSignal) {
    try {
      Schema.decodeUnknownSync(cronModelInputSchema)(input);
      const model = await this.resolveModel(input, signal);
      signal.throwIfAborted();
      return { model: modelName(model) };
    } catch (error) {
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Cron model validation unavailable; raw details withheld.",
      );
    }
  }

  async evaluate(
    input: CronEvaluateInput,
    signal: AbortSignal,
  ): Promise<CronEvaluation> {
    try {
      Schema.decodeUnknownSync(cronEvaluateInputSchema)(input);
      const model = await this.resolveModel(input, signal);
      signal.throwIfAborted();
      const generated = await this.api.generate.text(
        {
          model,
          prompt: `${cronObservationInstructions}\n\n${JSON.stringify({
            task: cronPublicText(input.prompt, 14000),
          })}`,
        },
        { signal },
      );
      signal.throwIfAborted();
      const observation = cronObservation(generated.text);
      const text = cronPublicText(observation?.text ?? generated.text);
      const result = { text, model: modelName(model) };
      if (
        !observation ||
        cronRisk(input.prompt, observation.text, observation.risks)
      )
        return { ...result, verdict: "escalate" };
      if (!input.arbiter) return { ...result, verdict: "act" };
      const member = this.arbiter(input.arbiter);
      // A separate per-run store cannot acquire or resume the configured peer's
      // conversation, task, mailbox or controller. No crew extension is installed.
      const key = createHash("sha256").update(input.id).digest("hex");
      const directory = join(
        this.authority.options.stateDirectory,
        "cron-evaluations",
        key,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      signal.throwIfAborted();
      const backend = await this.pi(
        {
          ...member.backend,
          directory: this.authority.options.captainDirectory,
          tools: "none",
          systemPrompt: cronDecisionInstructions,
        },
        { dataDirectory: directory },
      );
      try {
        signal.throwIfAborted();
        const sessionID = await backend.createSession({
          key: input.id,
          title: "Cron decision",
          signal,
        });
        signal.throwIfAborted();
        const decision = await backend.prompt(
          sessionID,
          JSON.stringify({
            task: cronPublicText(input.prompt, 14000),
            observation: text,
          }),
          signal,
        );
        signal.throwIfAborted();
        return {
          ...result,
          verdict: cronDecision(decision, input.prompt, text),
        };
      } finally {
        await backend.close();
      }
    } catch (error) {
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Cron evaluation unavailable or unconfirmed; do not replay. Raw details withheld.",
      );
    }
  }

  private arbiter(id: string) {
    const member = this.authority.options.team.crew.find(
      (item) => item.id === id,
    );
    if (member?.backend?.type !== "pi-durable")
      throw new CrewError(
        "Cron arbiter requires a configured Pi crew backend.",
      );
    return { ...member, backend: member.backend };
  }

  private async resolveModel(input: CronModelInput, signal: AbortSignal) {
    signal.throwIfAborted();
    const {
      team,
      captainDirectory: directory,
      captainSessionID,
    } = this.authority.options;
    if (!captainSessionID)
      throw new CrewError(
        "Cron evaluation requires an existing pinned captain.",
      );
    await this.authority.captain({
      sessionID: captainSessionID,
      agent: team.captain.id,
      signal,
    });
    const captain = await this.api.session.get(
      { sessionID: captainSessionID },
      { signal },
    );
    if (
      captain.id !== captainSessionID ||
      captain.parentID ||
      resolve(captain.location.directory) !== resolve(directory) ||
      ![team.captain.id, team.captain.agent ?? team.captain.id].includes(
        captain.agent ?? "",
      ) ||
      !captain.model
    )
      throw new CrewError(
        "Cron captain identity or actual model is unavailable.",
      );
    const model = input.model ? parseModel(input.model) : captain.model;
    const providers = team.modelProviders ?? defaultModelProviders;
    if (!providers.includes(model.providerID))
      throw new CrewError("Cron model provider is not allowed for this team.");
    const catalog = await this.api.model.list(
      { location: { directory }, types: ["chat"] },
      { signal },
    );
    const selected = catalog.data.find(
      (item) =>
        item.enabled &&
        item.providerID === model.providerID &&
        item.id === model.id,
    );
    if (
      resolve(catalog.location.directory) !== resolve(directory) ||
      !selected ||
      (model.variant &&
        !selected.variants.some((variant) => variant.id === model.variant))
    )
      throw new CrewError("Cron model or exact variant is unavailable.");
    const agents = await this.api.agent.list(
      { location: { directory } },
      { signal },
    );
    if (
      resolve(agents.location.directory) !== resolve(directory) ||
      !agents.data.some((agent) => agent.id === captain.agent) ||
      (modelName(model) !== modelName(captain.model) &&
        !agents.data.some(
          (agent) => agent.model && modelName(agent.model) === modelName(model),
        ))
    )
      throw new CrewError(
        "Cron model is not an available active profile route.",
      );
    if (input.arbiter) this.arbiter(input.arbiter);
    signal.throwIfAborted();
    return model;
  }
}
