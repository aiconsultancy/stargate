import { createHash } from "node:crypto";
import type { OpenCodeClient } from "@opencode/client";
import { Option, Schema } from "effect";
import { crewMessageMetadataKey } from "../../coordination/crew/message-protocol";
import type {
  ResultAPI,
  ResultMessage,
} from "../../coordination/crew/execution/result";
import {
  InputBoundaryFold,
  type InputBoundaryRecord,
  boundaryRecord,
  closesBoundaryContext,
  resolveBoundaryContext,
} from "./input-boundary";

const shellID = Schema.String.check(
  Schema.isPattern(/^sh_[A-Za-z0-9]{1,253}$/),
);

const command = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(65_536),
);

const decodeNotice = Schema.decodeUnknownOption(
  Schema.Struct({
    metadata: Schema.Struct({
      source: Schema.Literal("shell"),
      shellID,
      jobID: shellID,
      state: Schema.Literals(["completed", "cancelled", "error"]),
    }),
    description: command,
  }),
);

const decodeLaunch = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("tool"),
    id: Schema.NonEmptyString,
    name: Schema.Literal("shell"),
    state: Schema.Struct({
      status: Schema.Literal("completed"),
      input: Schema.Struct({ command }),
      metadata: Schema.Struct({ shellID, status: Schema.Literal("running") }),
    }),
  }),
);

const digest = (command: string) =>
  createHash("sha256").update(command).digest("hex");

type ShellReference = { id: string; command: string };

type Compact = InputBoundaryRecord & {
  callback?: ShellReference;
  launches: ShellReference[];
};

/** OpenCode 2.3 shell completion metadata contains no original input ID.
 * Resolve its unique earlier native tool result inside this session. This
 * reader is local to one history operation; it owns no state or execution.
 */
export class InputBoundaryReader {
  private origins: Promise<Map<string, string>> | undefined;

  public constructor(
    private readonly api: ResultAPI,
    private readonly sessionID: string,
    private readonly signal: AbortSignal,
  ) {}

  public async record(
    message: Pick<
      ResultMessage,
      "id" | "type" | "metadata" | "text" | "description"
    >,
  ): Promise<InputBoundaryRecord> {
    const record = boundaryRecord(message, this.sessionID);

    if (
      message.type !== "synthetic" ||
      message.metadata?.["source"] !== "shell"
    )
      return record;
    this.origins ??= this.readShellOrigins();

    return {
      ...record,
      input: (await this.origins).get(message.id) ?? message.id,
    };
  }

  private compact(message: ResultMessage): Compact | undefined {
    const record: Compact = {
      ...boundaryRecord(message, this.sessionID),
      launches: [],
    };

    if (
      message.type === "synthetic" &&
      !Object.hasOwn(message.metadata ?? {}, crewMessageMetadataKey)
    ) {
      const parsed = decodeNotice(message);

      if (
        Option.isSome(parsed) &&
        parsed.value.metadata.shellID === parsed.value.metadata.jobID
      )
        record.callback = {
          id: parsed.value.metadata.shellID,
          command: digest(parsed.value.description),
        };
    }

    if (message.type === "assistant") {
      for (const part of message.content ?? []) {
        const parsed = decodeLaunch(part);

        if (Option.isSome(parsed)) {
          if (record.launches.length >= 10_000) return;
          record.launches.push({
            id: parsed.value.state.metadata.shellID,
            command: digest(parsed.value.state.input.command),
          });
        }
      }
    }

    return record;
  }

  private async readShellOrigins(): Promise<Map<string, string>> {
    const records: Compact[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let witnesses = 0;
    let cursor: string | undefined;

    // Greybeard: 10,000 compact records per read. Missing/truncated/ambiguous
    // Ancestry stays native-only. A native original-input field can remove
    // This scan when the installed API supplies one; never infer from text.
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      this.signal.throwIfAborted();

      const page = await this.api.message.list(
        {
          sessionID: this.sessionID,
          limit: 100,
          ...(cursor ? { cursor } : { order: "desc" as const }),
        },
        { signal: this.signal },
      );

      this.signal.throwIfAborted();

      if (page.data.length > 100 || records.length + page.data.length > 10_000)
        return new Map();

      for (const message of page.data) {
        if (ids.has(message.id)) return new Map();
        ids.add(message.id);
        const record = this.compact(message);

        if (!record) return new Map();
        witnesses += record.launches.length;

        if (witnesses > 10_000) return new Map();
        records.push(record);
      }

      cursor = page.cursor.next ?? undefined;

      if (!cursor) break;

      if (cursors.has(cursor)) return new Map();
      cursors.add(cursor);
    }

    if (cursor) return new Map();
    records.reverse();

    const launches = new Map<
      string,
      { position: number; command: string; input: string | undefined }[]
    >();

    for (const [position, record] of records.entries()) {
      for (const launch of record.launches) {
        const witnesses = launches.get(launch.id) ?? [];
        witnesses.push({ position, command: launch.command, input: undefined });
        launches.set(launch.id, witnesses);
      }
    }

    const origins = new Map<string, string>();
    const fold = new InputBoundaryFold();
    let input: string | undefined;

    for (const [position, record] of records.entries()) {
      if (record.callback) {
        const witnesses = launches.get(record.callback.id);
        const witness = witnesses?.[0];
        record.input =
          witnesses?.length === 1 &&
          witness &&
          witness.position < position &&
          witness.command === record.callback.command
            ? (witness.input ?? record.id)
            : record.id;
        origins.set(record.id, record.input);
      }

      input = fold.next(record) ?? input;

      for (const launch of record.launches) {
        const witnesses = launches.get(launch.id);

        if (witnesses?.length === 1 && witnesses[0]) witnesses[0].input = input;
      }
    }

    return origins;
  }
}

export async function inputOwnership(
  client: OpenCodeClient,
  sessionID: string,
  input: string,
  signal: AbortSignal,
  assistant?: string,
) {
  if (assistant !== undefined) {
    // Inbox list is unpaginated in this SDK. Presence proves we still queue;
    // Absence proves nothing, so delivered candidates still need history.
    const inbox = await client.session.inbox.list({ sessionID }, { signal });

    if (inbox.some((item) => item.id === input)) return;
  }

  const boundaries = new InputBoundaryReader(client, sessionID, signal);
  let found = assistant === undefined;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const chain: InputBoundaryRecord[] = [];

  do {
    const page = await client.message.list(
      cursor
        ? { sessionID, limit: 100, cursor }
        : { sessionID, order: "desc", limit: 100 },
      { signal },
    );

    for (const message of page.data) {
      if (!found) {
        if (message.id === input) return;

        if (message.id === assistant && message.type === "assistant")
          found = true;
        continue;
      }

      const record = await boundaries.record(message);

      if (chain.length > 0 && closesBoundaryContext(record)) {
        chain.push(record);

        return resolveBoundaryContext(chain) === input;
      }

      if (record.input === undefined) continue;

      if (chain.length === 0 && record.type !== "synthetic")
        return record.input === input;
      chain.push(record);
    }

    cursor = page.cursor.next ?? undefined;

    if (cursor && cursors.has(cursor))
      throw new Error("OpenCode history cursor repeated");

    if (cursor) cursors.add(cursor);
  } while (cursor);

  return found ? resolveBoundaryContext(chain) === input : undefined;
}
