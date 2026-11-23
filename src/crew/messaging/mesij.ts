import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { Result, Schema } from "effect";
import {
  settingsDefault,
  settingsPattern,
  settingsStruct,
} from "../../config/settings-schema";

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

const identity = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(256),
  Schema.makeFilter(
    (value) =>
      value.trim().length > 0 &&
      [...value].every((character) => {
        const code = character.charCodeAt(0);

        return code > 31 && code !== 127;
      }),
  ),
);

const absolutePath = Schema.String.check(
  Schema.makeFilter((value) => isAbsolute(value) && !value.includes("\0")),
);

const eventID = Schema.String.check(settingsPattern(/^[a-f0-9]{32}$/));
const sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const optionsSchema = settingsStruct({
  command: absolutePath,
  projectDirectory: absolutePath,
  dataDirectory: Schema.optional(absolutePath),
  maxOutputBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 16_777_216 }),
  ).pipe(settingsDefault(4_194_304)),
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 300_000 }),
  ).pipe(settingsDefault(30_000)),
});

const registrationSchema = settingsStruct({
  actor: identity,
  sessionID: identity,
});

const sendSchema = settingsStruct({
  ...registrationSchema.fields,
  to: identity,
  text: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(65_536),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
  key: identity,
  replyTo: Schema.optional(eventID),
});

const inboxSchema = settingsStruct({
  sessionID: identity,
  after: sequence.pipe(settingsDefault(0)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })).pipe(
    settingsDefault(100),
  ),
});

// V0.1.0 returns extra source context. Keep only fields callers need.
const eventSchema = Schema.Struct({
  id: eventID,
  sequence: sequence.check(Schema.isGreaterThan(0)),
  actor: identity,
  session: identity,
  recipient_session: Schema.optional(identity),
  reply_to: Schema.optional(eventID),
  type: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(256),
  ),
  payload: Schema.Struct({
    message: Schema.optional(
      Schema.String.check(Schema.isMaxCodePoints(65_536)),
    ),
  }),
});

export type MesijOptions = typeof optionsSchema.Encoded;

export type MesijSend = typeof sendSchema.Encoded;

export type MesijInbox = typeof inboxSchema.Encoded;

export type MesijReceipt = { id: string; sequence: number };

export type MesijMessage = MesijReceipt & {
  actor: string;
  sessionID: string;
  to?: string;
  replyTo?: string;
  type: string;
  text: string;
};

function parse<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  code: MesijErrorCode,
): S["Type"] {
  const result = Schema.decodeUnknownResult(schema)(input);

  if (Result.isFailure(result)) throw new MesijError(code);

  return result.success;
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
  private readonly options: typeof optionsSchema.Type;

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
      Schema.mutable(Schema.Array(eventSchema)).check(
        Schema.isMaxLength(query.limit),
      ),
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
    delete env["MESIJ_DB"];
    delete env["MESIJ_PROJECT"];
    delete env["MESIJ_HOME"];

    if (this.options.dataDirectory)
      env["MESIJ_HOME"] = this.options.dataDirectory;

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
