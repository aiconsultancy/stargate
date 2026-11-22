import { createHash } from "node:crypto";
import { Option, Schema } from "effect";
import { crewMessageMetadataKey } from "../../crew/message-protocol";
import type { ResultAPI, ResultMessage } from "../../crew/execution/result";
import {
  boundaryRecord,
  InputBoundaryFold,
  type InputBoundaryRecord,
} from "./input-boundary";

const shellID = Schema.String.check(
  Schema.isPattern(/^sh_[A-Za-z0-9]{1,253}$/),
);
const command = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(65536),
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

  constructor(
    private readonly api: ResultAPI,
    private readonly sessionID: string,
    private readonly signal: AbortSignal,
  ) {}

  async record(
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
          if (record.launches.length >= 10000) return;
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
    // greybeard: 10,000 compact records per read. Missing/truncated/ambiguous
    // ancestry stays native-only. A native original-input field can remove
    // this scan when the installed API supplies one; never infer from text.
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
      if (page.data.length > 100 || records.length + page.data.length > 10000)
        return new Map();
      for (const message of page.data) {
        if (ids.has(message.id)) return new Map();
        ids.add(message.id);
        const record = this.compact(message);
        if (!record) return new Map();
        witnesses += record.launches.length;
        if (witnesses > 10000) return new Map();
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
