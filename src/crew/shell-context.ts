import { z } from "zod";

/** Minimal retained history fields; tool bodies and output remain opaque. */
export interface ShellContextRecord {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  agent?: string;
  text?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  content?: ReadonlyArray<{
    type: string;
    id?: string;
    text?: string;
    name?: string;
    executed?: boolean;
    state?: unknown;
  }>;
}
const shellID = z
  .string()
  .regex(/^sh_[A-Za-z0-9]+$/)
  .max(256);
const command = z.string().min(1).max(65536);
const notice = z.strictObject({
  source: z.literal("shell"),
  shellID,
  jobID: shellID,
  state: z.enum(["completed", "cancelled", "error"]),
  truncated: z.boolean().optional(),
  exit: z.number().optional(),
  signal: z.string().max(128).optional(),
  timeout: z.boolean().optional(),
});
const launch = z.object({
  type: z.literal("tool"),
  name: z.literal("shell"),
  state: z.object({
    status: z.literal("completed"),
    input: z.object({ command }),
    content: z
      .array(z.object({ type: z.string() }))
      .min(1)
      .max(1000),
    metadata: z.object({
      shellID,
      status: z.literal("running"),
      truncated: z.boolean(),
    }),
  }),
});

/** A candidate format is not ownership proof. Native commands are not XML-escaped. */
function candidate(message: ShellContextRecord) {
  if (
    message.type !== "synthetic" ||
    typeof message.text !== "string" ||
    message.text.length > 1024 * 1024
  )
    return;
  const metadata = notice.safeParse(message.metadata);
  const description = command.safeParse(message.description);
  if (
    !metadata.success ||
    !description.success ||
    metadata.data.jobID !== metadata.data.shellID
  )
    return;
  const prefix = `<shell id="${metadata.data.jobID}" state="${metadata.data.state}" command="${description.data}">\n`;
  const suffix = "\n</shell>";
  if (
    !message.text.startsWith(prefix) ||
    !message.text.endsWith(suffix) ||
    message.text.length < prefix.length + suffix.length
  )
    return;
  return { shellID: metadata.data.shellID, command: description.data };
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
  private callbacks: Array<{
    shellID: string;
    command: string;
    created: number;
    order: number;
  }> = [];
  private launches = new Map<string, Witness[]>();
  private witnesses = 0;
  private readonly workerAgents: ReadonlySet<string>;
  constructor(workerAgent: string, crewID = workerAgent) {
    // Match the two identifiers already accepted by validPeer and final proof.
    this.workerAgents = new Set([workerAgent, crewID]);
  }

  get exceededBounds() {
    return !this.valid;
  }

  /** True only means defer a strict candidate; finish must still prove it. */
  track(message: ShellContextRecord): boolean {
    const order = this.order++;
    if (this.order > 10000) this.valid = false;
    if (message.type === "assistant") {
      for (const part of message.content ?? []) {
        const parsed = launch.safeParse(part);
        if (!parsed.success) continue;
        if (++this.witnesses > 10000) {
          this.valid = false;
          break;
        }
        const { metadata, input } = parsed.data.state;
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
    if (!parsed) return false;
    if (this.callbacks.length >= 10000) {
      this.valid = false;
      return true;
    }
    this.callbacks.push({ ...parsed, created: message.time.created, order });
    return true;
  }

  /** Native descending order proves the launch precedes its callback. */
  finish(inputCreated: number): boolean {
    if (!this.valid || !Number.isFinite(inputCreated) || inputCreated < 0)
      return false;
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
      )
        return false;
      seen.add(callback.shellID);
    }
    return true;
  }
}
