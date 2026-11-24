import { Result, Schema } from "effect";
import {
  settingsPattern,
  settingsStruct,
} from "../../../config/settings-schema";

/** Minimal retained history fields; tool bodies and output remain opaque. */
export interface ShellContextRecord {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  agent?: string;
  text?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  content?: readonly {
    type: string;
    id?: string;
    text?: string;
    name?: string;
    executed?: boolean;
    state?: unknown;
  }[];
}

const shellID = Schema.String.check(
  settingsPattern(/^sh_[A-Za-z0-9]+$/),
  Schema.isMaxCodePoints(256),
);

const command = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(65_536),
);

const notice = settingsStruct({
  source: Schema.Literal("shell"),
  shellID,
  jobID: shellID,
  state: Schema.Literals(["completed", "cancelled", "error"]),
  truncated: Schema.optional(Schema.Boolean),
  exit: Schema.optional(Schema.Finite),
  signal: Schema.optional(Schema.String.check(Schema.isMaxCodePoints(128))),
  timeout: Schema.optional(Schema.Boolean),
});

const launch = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.Literal("shell"),
  state: Schema.Struct({
    status: Schema.Literal("completed"),
    input: Schema.Struct({ command }),
    content: Schema.Array(Schema.Struct({ type: Schema.String })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1000),
    ),
    metadata: Schema.Struct({
      shellID,
      status: Schema.Literal("running"),
      truncated: Schema.Boolean,
    }),
  }),
});

/** A candidate format is not ownership proof. Native commands are not XML-escaped. */
function candidate(message: ShellContextRecord) {
  if (
    message.type !== "synthetic" ||
    typeof message.text !== "string" ||
    message.text.length > 1024 * 1024
  ) {
    return;
  }

  const metadata = Schema.decodeUnknownResult(notice)(message.metadata);
  const description = Schema.decodeUnknownResult(command)(message.description);

  if (
    Result.isFailure(metadata) ||
    Result.isFailure(description) ||
    metadata.success.jobID !== metadata.success.shellID
  ) {
    return;
  }

  const prefix = `<shell id="${metadata.success.jobID}" state="${metadata.success.state}" command="${description.success}">\n`;
  const suffix = "\n</shell>";

  if (
    !message.text.startsWith(prefix) ||
    !message.text.endsWith(suffix) ||
    message.text.length < prefix.length + suffix.length
  ) {
    return;
  }

  return { shellID: metadata.success.shellID, command: description.success };
}

/** Wire recognition only; callers must still resolve task ownership. */
export function isShellCompletionCandidate(
  message: ShellContextRecord,
): boolean {
  return candidate(message) !== undefined;
}

type Witness = {
  shellID: string;
  command: string;
  agent: string | undefined;
  created: number;
  order: number;
};

/** Descending scan of ONE original input's retained turn, never the latest turn.
 * Keep compact launch proofs, not arbitrary output. finish() is mandatory after
 * the caller validates its exact original input. Unknown/ambiguous proof fails.
 */
export class ShellCompletionContext {
  private order = 0;
  private valid = true;
  private readonly callbacks: {
    shellID: string;
    command: string;
    created: number;
    order: number;
  }[] = [];
  private readonly launches = new Map<string, Witness[]>();
  private witnesses = 0;
  private readonly workerAgents: ReadonlySet<string>;
  public constructor(workerAgent: string, crewID = workerAgent) {
    // Match the two identifiers already accepted by validPeer and final proof.
    this.workerAgents = new Set([workerAgent, crewID]);
  }

  public get exceededBounds() {
    return !this.valid;
  }

  /** True only means defer a strict candidate; finish must still prove it. */
  public track(message: ShellContextRecord): boolean {
    const order = this.order++;

    if (this.order > 10_000) {
      this.valid = false;
    }

    if (message.type === "assistant") {
      for (const part of message.content ?? []) {
        const parsed = Schema.decodeUnknownResult(launch)(part);

        if (Result.isFailure(parsed)) {
          continue;
        }

        if (++this.witnesses > 10_000) {
          this.valid = false;
          break;
        }

        const { metadata, input } = parsed.success.state;
        const entries = this.launches.get(metadata.shellID) ?? [];
        entries.push({
          shellID: metadata.shellID,
          command: input.command,
          agent: message.agent,
          created: message.time.created,
          order,
        });
        this.launches.set(metadata.shellID, entries);
      }
    }

    const parsed = candidate(message);

    if (!parsed) {
      return false;
    }

    if (this.callbacks.length >= 10_000) {
      this.valid = false;

      return true;
    }

    this.callbacks.push({ ...parsed, created: message.time.created, order });

    return true;
  }

  /** Native descending order proves the launch precedes its callback. */
  public finish(inputCreated: number): boolean {
    if (!this.valid || !Number.isFinite(inputCreated) || inputCreated < 0) {
      return false;
    }

    const seen = new Set<string>();

    for (const callback of this.callbacks) {
      const entries = this.launches.get(callback.shellID);
      const witness = entries?.[0];

      if (
        seen.has(callback.shellID) ||
        entries?.length !== 1 ||
        !witness ||
        !this.workerAgents.has(witness.agent ?? "") ||
        witness.command !== callback.command ||
        !Number.isFinite(witness.created) ||
        !Number.isFinite(callback.created) ||
        witness.order <= callback.order ||
        witness.created < inputCreated ||
        witness.created > callback.created
      ) {
        return false;
      }

      seen.add(callback.shellID);
    }

    return true;
  }
}
