import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  AssistantEntry,
  type ConversationId,
  type ConversationView,
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { z } from "zod";
import type { AgentBackend, BackendContext, TextSink } from "../backend";
import { type BackendConfig, secret } from "../config";

type Config = Extract<BackendConfig, { type: "pi-durable" }>;
const conversationId = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative());

const liveText = z.object({
  generation: z
    .object({
      message: z
        .object({
          content: z.array(
            z.object({ type: z.string(), text: z.string().optional() }),
          ),
        })
        .optional(),
    })
    .optional(),
});

/** Read visible text only; never publish thinking, tool arguments, or results. */
export function piPartialText(view: ConversationView): string {
  const live = liveText.safeParse(view.docs["pi.live"]);
  return live.success
    ? (live.data.generation?.message?.content ?? [])
        .flatMap((block) =>
          block.type === "text" && block.text ? [block.text] : [],
        )
        .join("")
    : "";
}

export class PiDurableBackend implements AgentBackend {
  private constructor(
    private readonly harness: Harness,
    private readonly config: Config,
  ) {}

  static async open(config: Config, context: BackendContext) {
    const models = createModels();
    if (config.model.startsWith("anthropic/")) {
      secret("ANTHROPIC_API_KEY");
      models.setProvider(anthropicProvider());
    } else {
      secret("OPENAI_API_KEY");
      models.setProvider(openaiProvider());
    }
    const registry = createRegistry();
    if (config.tools === "coding") registry.install(CodingTools);
    const storage = await openNodeSqliteStorage(
      join(context.dataDirectory, "pi.sqlite"),
    );
    try {
      const harness = await Harness.open(
        storage,
        {
          models,
          registry,
          env: ({ cwd }) =>
            new NodeExecutionEnv({ cwd: cwd ?? config.directory }),
        },
        BACKGROUND_CONTEXT,
      );
      return new PiDurableBackend(harness, config);
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  async createSession({
    signal,
  }: Parameters<AgentBackend["createSession"]>[0]) {
    const separator = this.config.model.indexOf("/");
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: {
            provider: this.config.model.slice(0, separator),
            modelId: this.config.model.slice(separator + 1),
          },
          instructions: this.config.systemPrompt,
          cwd: this.config.directory,
          maxTurns: 50,
        },
      },
      withAbortSignal(signal, BACKGROUND_CONTEXT),
    );
    return String(conversation.id);
  }

  async prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
  ) {
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const conversation = await this.harness.conversation(
      conversationId.parse(sessionId) as ConversationId,
      context,
    );
    if (!conversation) throw new Error("Pi conversation not found");
    let observation:
      | Awaited<ReturnType<Harness["observeConversation"]>>
      | undefined;
    const visible = new Map<number, string>();
    let baseline = 0;
    try {
      if (onText) {
        observation = await this.harness.observeConversation(
          conversationId.parse(sessionId) as ConversationId,
          {
            advance(call) {
              if (call.kind !== "value") return;
              for (const entry of call.value.entries) {
                if (entry.id <= baseline || !AssistantEntry.is(entry)) continue;
                visible.set(
                  entry.id,
                  (entry.model ?? [])
                    .flatMap((message) =>
                      message.role === "assistant"
                        ? message.content.flatMap((block) =>
                            block.type === "text" ? [block.text] : [],
                          )
                        : [],
                    )
                    .join(""),
                );
              }
              onText(
                [...visible.values(), piPartialText(call.value)]
                  .filter(Boolean)
                  .join("\n\n"),
              );
            },
            end() {},
          },
          context,
        );
        baseline = Math.max(
          0,
          ...observation.value.entries.map((entry) => entry.id),
        );
      }
      const submission = await conversation.submit(
        { type: "input", content: text, whenBusy: "followUp" },
        context,
      );
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input")
        throw new Error("Pi input did not complete");
      const entry = await conversation.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        context,
      );
      if (!entry) throw new Error("Pi answer not found");
      const answer = (entry.model ?? [])
        .flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((block) =>
                block.type === "text" ? [block.text] : [],
              )
            : [],
        )
        .join("");
      if (!onText) return answer;
      visible.set(entry.id, answer);
      return [...visible.values()].filter(Boolean).join("\n\n");
    } catch (error) {
      await this.interrupt(sessionId, AbortSignal.timeout(5000)).catch(
        () => {},
      );
      throw error;
    } finally {
      observation?.detach();
    }
  }

  async interrupt(sessionId: string, signal: AbortSignal) {
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const conversation = await this.harness.conversation(
      conversationId.parse(sessionId) as ConversationId,
      context,
    );
    if (conversation) await conversation.abort(context);
  }

  async close() {
    await this.harness.close(BACKGROUND_CONTEXT);
  }
}
