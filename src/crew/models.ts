import type {
  ModelListInput,
  SessionCompactInput,
  SessionGetInput,
  SessionInterruptInput,
  SessionSwitchModelInput,
} from "@opencode/client";
import { z } from "zod";
import type { CrewCaller } from "./engine";
import { CrewError, type Peer } from "./state";
import { agentIDSchema, defaultModelProviders, type Team } from "./team";

const target = agentIDSchema.default("captain");
export const modelInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("get"),
    target: z.enum(["captain", "self"]).default("self"),
  }),
  z.strictObject({ op: z.literal("list"), target }),
  z.strictObject({
    op: z.literal("switch"),
    target,
    providerID: z.string().min(1).max(100),
    id: z.string().min(1).max(256),
    variant: z.string().min(1).max(100).optional(),
    compactFirst: z.boolean().default(false),
  }),
]);
type ModelRef = SessionSwitchModelInput["model"];
type Request = { signal: AbortSignal };
export interface ModelSessions {
  get(input: SessionGetInput, request?: Request): Promise<{ model?: ModelRef }>;
  switchModel(input: SessionSwitchModelInput, request?: Request): Promise<void>;
  compact(input: SessionCompactInput, request?: Request): Promise<unknown>;
  interrupt(input: SessionInterruptInput, request?: Request): Promise<unknown>;
}
interface Models {
  list(
    input: ModelListInput,
    request?: Request,
  ): Promise<{
    data: {
      id: string;
      providerID: string;
      enabled: boolean;
      variants: { id: string }[];
    }[];
  }>;
}
export interface ModelAuthority {
  options: {
    team: Team;
    captainDirectory: string;
    worktrees: Record<string, string>;
  };
  captain(caller: CrewCaller): Promise<void>;
  authorize(caller: CrewCaller): Promise<void>;
  withWorkerControl<T>(
    crewID: string,
    caller: CrewCaller,
    operation: (peer: Peer) => Promise<T>,
  ): Promise<T>;
}

export class CrewModels {
  constructor(
    private readonly authority: ModelAuthority,
    private readonly sessions: ModelSessions,
    private readonly models: Models,
    private readonly compactAndWait: (
      sessionID: string,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  async run(raw: unknown, caller: CrewCaller) {
    const parsed = modelInputSchema.safeParse(raw);
    if (!parsed.success) throw new CrewError("Invalid pogo_model operation.");
    const input = parsed.data;
    try {
      caller.signal.throwIfAborted();
      if (input.op === "get") {
        if (input.target === "captain") await this.authority.captain(caller);
        else await this.authority.authorize(caller);
        const { model } = await this.sessions.get(
          { sessionID: caller.sessionID },
          { signal: caller.signal },
        );
        if (!model)
          throw new CrewError(
            "Session has no selected model; no default inferred.",
          );
        return {
          sessionID: caller.sessionID,
          model: {
            providerID: model.providerID,
            id: model.id,
            variant: model.variant ?? "default/unspecified",
          },
        };
      }
      await this.authority.captain(caller);
      const { team } = this.authority.options;
      if (team.crew.find(({ id }) => id === input.target)?.backend)
        throw new CrewError(
          "Pi worker models are configured in team JSON; live model tools apply only to OpenCode.",
        );
      const directory =
        input.target === "captain"
          ? this.authority.options.captainDirectory
          : team.crew.some(({ id }) => id === input.target)
            ? this.authority.options.worktrees[input.target]
            : undefined;
      if (!directory) throw new CrewError("Unknown configured model target.");
      const providers = team.modelProviders ?? defaultModelProviders;
      const catalog = (
        await this.models.list(
          { location: { directory }, types: ["chat"] },
          { signal: caller.signal },
        )
      ).data.filter(
        (model) => model.enabled && providers.includes(model.providerID),
      );
      if (input.op === "list")
        return {
          models: catalog.slice(0, 100).map((model) => ({
            providerID: model.providerID,
            id: model.id,
            variants: model.variants.map(({ id }) => id),
          })),
          truncated: catalog.length > 100,
        };
      const selected = catalog.find(
        (model) =>
          model.providerID === input.providerID && model.id === input.id,
      );
      if (
        !selected ||
        (input.variant &&
          !selected.variants.some(({ id }) => id === input.variant))
      ) {
        throw new CrewError(
          "Model or variant is unavailable or outside this team's allowed providers; no fallback applied.",
        );
      }
      const model: ModelRef = {
        providerID: input.providerID,
        id: input.id,
        ...(input.variant ? { variant: input.variant } : {}),
      };
      if (input.target === "captain") {
        if (input.compactFirst) {
          // Waiting for our own turn to compact would deadlock this tool call.
          await this.sessions.compact(
            { sessionID: caller.sessionID, delivery: "steer" },
            { signal: caller.signal },
          );
          return {
            status: "compaction-admitted",
            modelChanged: false,
            next: "After compaction completes, call switch again with compactFirst=false.",
          };
        }
        return await this.switch(caller.sessionID, model, caller.signal);
      }
      return await this.authority.withWorkerControl(
        input.target,
        caller,
        async (peer) => {
          if (input.compactFirst) {
            try {
              await this.compactAndWait(peer.sessionID, caller.signal);
            } catch {
              await this.sessions
                .interrupt(
                  { sessionID: peer.sessionID, resume: false },
                  { signal: AbortSignal.timeout(5000) },
                )
                .catch(() => {});
              throw new CrewError(
                "Worker compaction was not confirmed; model unchanged. Inspect the session before retrying.",
              );
            }
          }
          return this.switch(peer.sessionID, model, caller.signal);
        },
      );
    } catch (error) {
      if (caller.signal.aborted)
        throw new CrewError(
          "Model operation cancelled; inspect session state before retrying.",
        );
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Model operation unavailable or unconfirmed; inspect session state. Raw details withheld.",
      );
    }
  }

  private async switch(
    sessionID: string,
    model: ModelRef,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await this.sessions.switchModel({ sessionID, model }, { signal });
    const selected = (await this.sessions.get({ sessionID }, { signal })).model;
    if (
      selected?.providerID !== model.providerID ||
      selected.id !== model.id ||
      selected.variant !== model.variant
    ) {
      throw new CrewError(
        "Model selection was not confirmed; inspect the session before retrying.",
      );
    }
    return {
      status: "switched",
      sessionID,
      model,
      effect: "subsequent-provider-turns",
    };
  }
}
