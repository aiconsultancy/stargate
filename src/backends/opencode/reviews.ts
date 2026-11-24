import type { OpenCodeClient } from "@opencode/client";
import type {
  FleetReviewBinding,
  FleetReviewEvidence,
  NativeMaker,
} from "../../coordination/fleet/protocol";
import {
  reviewContextPrompt,
  reviewNativePrompt,
} from "../../coordination/fleet/review-prompts";
import { isNativeInstructionContext } from "./instruction-context";
import type { opencodeBackendSchema } from "./config";

type ReviewConfig = Pick<
  typeof opencodeBackendSchema.Type,
  "sessionID" | "agent" | "directory"
>;

function ownsReview(
  marker: unknown,
  binding: FleetReviewBinding,
  sessionID: string | undefined,
): boolean {
  return (
    typeof marker === "object" &&
    marker !== null &&
    "id" in marker &&
    marker["id"] === binding.id &&
    "nonce" in marker &&
    marker["nonce"] === binding.nonce &&
    "owner" in marker &&
    marker["owner"] === sessionID &&
    "contextDigest" in marker &&
    marker["contextDigest"] === binding.context.contextDigest
  );
}

/** Starts native reviews and verifies their session-bound evidence. */
export class OpenCodeReviews {
  public constructor(
    private readonly client: OpenCodeClient,
    private readonly config: ReviewConfig,
  ) {}

  /** One gateway-owned attempt; IDs/nonce were persisted before this call. */
  public async startReview(
    binding: FleetReviewBinding,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      binding.reviewer.kind !== "crew" ||
      binding.context.coordinatorSessionID !== this.config.sessionID
    ) {
      throw new Error("Review worker does not belong to this native root");
    }

    const reviewer = binding.reviewer;

    const definition = await this.client.agent.get(
      { agentID: reviewer.agent, location: { directory: reviewer.directory } },
      { signal },
    );

    if (
      definition.data.id !== reviewer.agent ||
      definition.location.directory !== reviewer.directory ||
      definition.data.mode !== "primary" ||
      !definition.data.model ||
      !reviewer.models.some(
        (m) =>
          m.provider === definition.data.model?.providerID &&
          m.model === definition.data.model?.id &&
          (m.variant === undefined ||
            m.variant === definition.data.model?.variant),
      )
    ) {
      throw new Error("Native review profile or model selector is unavailable");
    }

    const active = await this.client.session.active({ signal });
    let cursor: string | undefined;
    const seen = new Set<string>();

    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.client.session.list(
        {
          directory: reviewer.directory,
          limit: 100,
          ...(cursor && { cursor }),
        },
        { signal },
      );

      if (
        page.data.some(
          (s) =>
            s.location.directory === reviewer.directory &&
            Boolean(active[s.id]),
        )
      ) {
        throw new Error(
          "Configured review worker is busy; no worktree was changed",
        );
      }

      for (const candidate of page.data) {
        if (candidate.location.directory !== reviewer.directory) {
          continue;
        }

        const inbox = await this.client.session.inbox.list(
          { sessionID: candidate.id },
          { signal },
        );

        if (inbox.length > 0) {
          throw new Error("Configured review directory has queued native work");
        }
      }

      const next = page.cursor.next;

      if (!next) {
        break;
      }

      if (seen.has(next) || pageNumber === 99) {
        throw new Error("Review worker ownership cannot be bounded");
      }

      seen.add(next);
      cursor = next;
    }

    const session = await this.client.session.create(
      {
        id: binding.sessionID,
        agent: reviewer.agent,
        title: `PR review ${binding.context.repository}#${binding.context.pullRequest}`,
        location: { directory: reviewer.directory },
        model: definition.data.model,
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...reviewer.permissions,
        ],
        metadata: {
          stargateReview: {
            id: binding.id,
            nonce: binding.nonce,
            owner: this.config.sessionID,
            contextDigest: binding.context.contextDigest,
          },
        },
      },
      { signal },
    );

    if (
      session.id !== binding.sessionID ||
      session.agent !== reviewer.agent ||
      session.location.directory !== reviewer.directory
    ) {
      throw new Error("Native review session identity changed");
    }

    await this.client.session.prompt(
      {
        sessionID: binding.sessionID,
        id: binding.inputID,
        text: reviewNativePrompt(binding),
        metadata: { stargateReview: { id: binding.id, nonce: binding.nonce } },
        delivery: "queue",
        resume: true,
      },
      { signal },
    );
  }

  /** Strict read-only evidence; never reads crew DBs, files, or inferred models. */
  public async readReview(
    binding: FleetReviewBinding,
    signal: AbortSignal,
  ): Promise<FleetReviewEvidence | undefined> {
    if (binding.context.coordinatorSessionID !== this.config.sessionID) {
      throw new Error("Review root mismatch");
    }

    const session = await this.client.session.get(
      { sessionID: binding.sessionID },
      { signal },
    );

    if (
      session.id !== binding.sessionID ||
      session.agent !== binding.reviewer.agent ||
      session.location.directory !== binding.reviewer.directory
    ) {
      throw new Error("Native reviewer session identity changed");
    }

    if (binding.reviewer.kind === "captain") {
      if (
        binding.sessionID !== this.config.sessionID ||
        binding.reviewer.agent !== this.config.agent ||
        binding.reviewer.directory !== this.config.directory ||
        session.parentID !== undefined
      ) {
        throw new Error("Review captain is not the configured root");
      }
    } else {
      const marker = session.metadata?.["stargateReview"];

      if (!ownsReview(marker, binding, this.config.sessionID)) {
        throw new Error("Native worker review ownership unavailable");
      }
    }

    const assistants: {
      maker: NativeMaker;
      completed: boolean;
      failed: boolean;
      finish: string | undefined;
      text: string;
      unsafeTools: boolean;
    }[] = [];

    let cursor: string | undefined;
    const seen = new Set<string>();

    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.client.message.list(
        {
          sessionID: binding.sessionID,
          limit: 100,
          ...(cursor ? { cursor } : { order: "desc" as const }),
        },
        { signal },
      );

      for (const message of page.data) {
        if (message.id === binding.inputID) {
          if (
            message.type !== "user" ||
            (binding.reviewer.kind === "crew"
              ? message.text !== reviewNativePrompt(binding)
              : !message.text.endsWith(
                  reviewContextPrompt(binding.context, binding.contextText),
                ))
          ) {
            throw new Error(
              "Native review input does not match immutable context",
            );
          }

          const final = assistants[0];

          if (!final) {
            return;
          }

          if (assistants.some((m) => m.failed)) {
            throw new Error("Native review failed");
          }

          if (assistants.some((m) => m.unsafeTools)) {
            throw new Error(
              "Native review used a tool outside the read-only review boundary",
            );
          }

          if (assistants.some((m) => !m.completed)) {
            return;
          }

          if (final.finish !== "stop") {
            throw new Error("Native review did not finish successfully");
          }

          const resultText = final.text;

          if (
            !resultText.trim() ||
            Buffer.byteLength(resultText, "utf8") > 64_000
          ) {
            throw new Error("Native review result is missing or oversized");
          }

          return {
            resultText,
            makers: assistants.toReversed().map((m) => m.maker),
          };
        }

        if (message.type === "assistant") {
          if (assistants.length >= 100) {
            throw new Error("Native review maker bound exceeded");
          }

          assistants.push({
            maker: {
              messageID: message.id,
              agent: message.agent,
              provider: message.model.providerID,
              model: message.model.id,
              ...(message.model.variant && { variant: message.model.variant }),
            },
            completed: message.time.completed !== undefined,
            failed: message.error !== undefined,
            finish: message.finish,
            text: message.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
            unsafeTools: message.content.some(
              (part) =>
                part.type === "tool" &&
                ![
                  "read",
                  "glob",
                  "grep",
                  "skill",
                  "fleet_review",
                  "fleet_verify_instruction",
                  "fleet_status",
                  "stargate_history",
                ].includes(part.name),
            ),
          });
        } else if (
          ["user", "shell", "synthetic"].includes(message.type) &&
          !isNativeInstructionContext(message)
        ) {
          assistants.length = 0;
        }
      }

      const next = page.cursor.next;

      if (!next) {
        return;
      }

      if (seen.has(next)) {
        throw new Error("Native review history cursor repeated");
      }

      seen.add(next);
      cursor = next;
    }

    throw new Error("Native review history exceeds bounds");
  }
}
