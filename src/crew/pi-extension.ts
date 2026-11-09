import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { z } from "zod";
import { quotaInputSchema } from "../quota";
import { crewInputSchema } from "./engine";
import { journalInputSchema } from "./journal";
import { dmInputSchema, mailInputSchema } from "./messaging";
import { CrewError } from "./state";

const outputLimit = 50 * 1024;

export type PiCrewBinding = {
  authorize(conversationID: string): void;
  run(
    name: string,
    input: unknown,
    conversationID: string,
    id: string,
    signal: AbortSignal,
  ): Promise<unknown>;
};
const history = z.strictObject({
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.record(z.string(), z.json()).optional(),
});

/** Thin native bindings. Each invocation is tied to the saved member conversation. */
export function piCrewExtension(
  binding: PiCrewBinding,
  readHistory: (
    id: string,
    input: z.infer<typeof history>,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  const tools = [
    {
      name: "pogo_quota",
      schema: quotaInputSchema,
      description:
        "Read Claude/Codex subscription quota percentages, scopes, resets and timestamps, not token totals. Cached up to 60s. Missing/inactive limits and reset-passed observations do not prove model availability. No changes; no arguments or credentials.",
    },
    {
      name: "pogo_crew",
      schema: crewInputSchema,
      description:
        "Read configured roster or own task status; captain controls remain captain-only.",
    },
    {
      name: "pogo_journal",
      schema: journalInputSchema,
      description:
        "Append concise task milestones, checks, blockers and outcomes; read scoped journal by entry ID. No transcripts or secrets.",
    },
    {
      name: "pogo_mail",
      schema: mailInputSchema,
      description:
        "Store/read asynchronous peer mail. captain aliases the originating captain; all excludes self. Mail never wakes agents. Reply with replyTo; acknowledge pages with nextAfter as after.",
    },
    {
      name: "pogo_dm",
      schema: dmInputSchema,
      description:
        "Store peer mail and request steer or queue notification. Queued assignments do not block an idle member's roll-call reply. FIFO is default guidance, not a lock; active/uncertain work and ownership/controller guards remain. Native acceptance does not mean read or answered. Final answers remain task results; use replyTo for peer replies.",
    },
    {
      name: "pi_history",
      schema: history,
      description:
        "Read paginated immutable history of this Pi conversation through the existing native runtime. No other conversations, no agent work.",
    },
  ].map(({ name, schema, description }) =>
    defineTool({
      name,
      description,
      parameters: z.toJSONSchema(schema),
      replay: "unsafe",
      async execute(raw, api, context) {
        try {
          binding.authorize(String(api.conversationId));
          const input = schema.parse(raw);
          const signal = context.abortSignal ?? new AbortController().signal;
          const result =
            name === "pi_history"
              ? await readHistory(
                  String(api.conversationId),
                  history.parse(input),
                  signal,
                )
              : await binding.run(
                  name,
                  input,
                  String(api.conversationId),
                  String(api.taskId),
                  signal,
                );
          const text = JSON.stringify(result);
          if (Buffer.byteLength(text, "utf8") > outputLimit)
            throw new CrewError("result too large, retry with a smaller limit");
          return { output: [{ type: "text" as const, text }] };
        } catch (error) {
          return {
            isError: true,
            output: [
              {
                type: "text" as const,
                text:
                  error instanceof CrewError
                    ? error.message
                    : "Crew operation unavailable or unconfirmed; do not replay uncertain work.",
              },
            ],
          };
        }
      },
      outputLimits: { maxBytes: outputLimit, maxLines: 200 },
    }),
  );
  return defineExtension({ name: "pogo.crew", tools });
}
