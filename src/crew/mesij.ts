import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";

const errors = {
  options: "Invalid Mesij options.",
  input: "Invalid Mesij input.",
  process: "Mesij command failed.",
  output: "Invalid Mesij response.",
  limit: "Mesij output exceeded its limit.",
  cancelled: "Mesij operation cancelled.",
  timeout: "Mesij operation timed out.",
} as const;

export type MesijErrorCode = keyof typeof errors;

export class MesijError extends Error {
  constructor(readonly code: MesijErrorCode) {
    super(errors[code]);
    this.name = "MesijError";
  }
}

const identity = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      }),
  );
const absolutePath = z
  .string()
  .refine((value) => isAbsolute(value) && !value.includes("\0"));
const eventID = z.string().regex(/^[a-f0-9]{32}$/);
const sequence = z.number().int().safe().nonnegative();
const optionsSchema = z.strictObject({
  command: absolutePath,
  projectDirectory: absolutePath,
  dataDirectory: absolutePath.optional(),
  maxOutputBytes: z.number().int().min(1).max(16_777_216).default(4_194_304),
  timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
});
const registrationSchema = z.strictObject({
  actor: identity,
  sessionID: identity,
});
const sendSchema = registrationSchema.extend({
  to: identity,
  text: z
    .string()
    .min(1)
    .max(65_536)
    .refine((value) => value.trim().length > 0),
  key: identity,
  replyTo: eventID.optional(),
});
const inboxSchema = z.strictObject({
  sessionID: identity,
  after: sequence.default(0),
  limit: z.number().int().min(1).max(1000).default(100),
});
// v0.1.0 returns extra source context. Keep only fields callers need.
const eventSchema = z.object({
  id: eventID,
  sequence: sequence.positive(),
  actor: identity,
  session: identity,
  recipient_session: identity.optional(),
  reply_to: eventID.optional(),
  type: z.string().min(1).max(256),
  payload: z.object({ message: z.string().max(65_536).optional() }),
});

export type MesijOptions = z.input<typeof optionsSchema>;
export type MesijSend = z.input<typeof sendSchema>;
export type MesijInbox = z.input<typeof inboxSchema>;
export type MesijReceipt = { id: string; sequence: number };
export type MesijMessage = MesijReceipt & {
  actor: string;
  sessionID: string;
  to?: string;
  replyTo?: string;
  type: string;
  text: string;
};

function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: MesijErrorCode,
): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new MesijError(code);
  return result.data;
}

function json(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new MesijError("output");
  }
}

function receipt(event: MesijReceipt): MesijReceipt {
  return { id: event.id, sequence: event.sequence };
}

/** Trusted callers bind roster identities. This adapter owns no mapping/cursor. */
export class MesijClient {
  private readonly options: z.output<typeof optionsSchema>;

  constructor(options: MesijOptions) {
    this.options = parse(optionsSchema, options, "options");
  }

  async register(
    actor: string,
    sessionID: string,
    signal: AbortSignal,
  ): Promise<MesijReceipt> {
    const input = parse(registrationSchema, { actor, sessionID }, "input");
    const output = await this.run(
      ["session", "--actor", input.actor, "--id", input.sessionID, "--json"],
      signal,
    );
    const event = parse(eventSchema, json(output), "output");
    if (
      event.actor !== input.actor ||
      event.session !== input.sessionID ||
      event.type !== "session.started"
    )
      throw new MesijError("output");
    return receipt(event);
  }

  async send(input: MesijSend, signal: AbortSignal): Promise<MesijReceipt> {
    const message = parse(sendSchema, input, "input");
    const output = await this.run(
      ["emit"],
      signal,
      JSON.stringify({
        event: message.replyTo ? "reply" : "post",
        actor: message.actor,
        session: message.sessionID,
        to: message.to,
        message: message.text,
        key: message.key,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
    );
    const event = parse(eventSchema, json(output), "output");
    if (
      event.actor !== message.actor ||
      event.session !== message.sessionID ||
      event.recipient_session !== message.to ||
      event.reply_to !== message.replyTo ||
      event.type !== (message.replyTo ? "message.replied" : "message.posted") ||
      event.payload.message !== message.text
    )
      throw new MesijError("output");
    return receipt(event);
  }

  /** Includes sent messages and actor mentions, as defined by Mesij's inbox. */
  async inbox(input: MesijInbox, signal: AbortSignal): Promise<MesijMessage[]> {
    const query = parse(inboxSchema, input, "input");
    const output = await this.run(
      [
        "inbox",
        "--session",
        query.sessionID,
        "--after",
        String(query.after),
        "--limit",
        String(query.limit),
        "--json",
      ],
      signal,
    );
    const events = parse(
      z.array(eventSchema).max(query.limit),
      json(output),
      "output",
    );
    let previous = query.after;
    return events.map((event) => {
      if (event.sequence <= previous || !event.type.startsWith("message."))
        throw new MesijError("output");
      previous = event.sequence;
      return {
        ...receipt(event),
        actor: event.actor,
        sessionID: event.session,
        ...(event.recipient_session ? { to: event.recipient_session } : {}),
        ...(event.reply_to ? { replyTo: event.reply_to } : {}),
        type: event.type,
        text: event.payload.message ?? "",
      };
    });
  }

  private async run(
    args: string[],
    signal: AbortSignal,
    input?: string,
  ): Promise<string> {
    if (signal.aborted) throw new MesijError("cancelled");
    const env = { ...process.env };
    // Never let inherited Mesij overrides redirect this roster to another DB.
    delete env.MESIJ_DB;
    delete env.MESIJ_PROJECT;
    delete env.MESIJ_HOME;
    if (this.options.dataDirectory) env.MESIJ_HOME = this.options.dataDirectory;

    return new Promise((resolve, reject) => {
      let failure: MesijErrorCode | undefined;
      let length = 0;
      const chunks: Buffer[] = [];
      const grouped = process.platform !== "win32";
      const child = spawn(
        this.options.command,
        ["--project", `path:${this.options.projectDirectory}`, ...args],
        {
          cwd: this.options.projectDirectory,
          env,
          stdio: ["pipe", "pipe", "ignore"],
          detached: grouped,
        },
      );
      const stop = (code: MesijErrorCode) => {
        failure ??= code;
        try {
          if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // A process that has already exited still completes through close.
          child.kill("SIGKILL");
        }
      };
      const abort = () => stop("cancelled");
      const timer = setTimeout(() => stop("timeout"), this.options.timeoutMs);
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", () => stop("process"));
      child.stdin.on("error", () => stop("process"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        length += chunk.length;
        if (length > this.options.maxOutputBytes) stop("limit");
        else chunks.push(chunk);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure) reject(new MesijError(failure));
        else if (code !== 0) reject(new MesijError("process"));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      if (signal.aborted) abort();
      child.stdin.end(input);
    });
  }
}
