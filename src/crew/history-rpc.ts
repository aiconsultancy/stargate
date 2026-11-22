import { Schema } from "effect";
import {
  exactStruct,
  HISTORY_PAGE,
  type HistoryChildrenInput,
  type HistoryEntriesInput,
  type HistorySession,
  historyChildrenInputSchema,
  historyDescribeInputSchema,
  historyEntriesInputSchema,
  piHistoryPrefix,
} from "../shared/session-history";
import type { PiCrewWorkers } from "./pi-worker";
import { CrewError, type CrewState } from "./state";
import type { CrewMember, Team } from "./team";

const unavailable = "Pi history unavailable or cancelled.";
const decodeChildrenCursor = Schema.decodeUnknownSync(
  exactStruct({ parentID: Schema.String, after: Schema.String }),
);
const decodeDescribe = Schema.decodeUnknownSync(historyDescribeInputSchema);
const decodeChildren = Schema.decodeUnknownSync(historyChildrenInputSchema);
const decodeEntries = Schema.decodeUnknownSync(historyEntriesInputSchema);

/** Root: pi:<peer session>. Child: pi:<peer session>~<native numeric ID>.
 * Peer IDs are generated ses_<uuid>, never contain '~'. IDs stay below 512
 * characters. Every component is authorized from state, not from this encoding.
 */
export class CrewHistoryRPC {
  constructor(
    private readonly team: Team,
    private readonly state: CrewState,
    private readonly pi: Pick<PiCrewWorkers, "readHistory">,
  ) {}

  private async safe<T>(
    signal: AbortSignal,
    read: () => Promise<T>,
  ): Promise<T> {
    try {
      signal.throwIfAborted();
      const result = await read();
      signal.throwIfAborted();
      return result;
    } catch {
      throw new CrewError(unavailable);
    }
  }

  private root(member: CrewMember): HistorySession | undefined {
    const peer = this.state.peer(member.id);
    if (peer?.status !== "ready") return undefined;
    if (member.backend && !this.state.piPeer(peer.sessionID)?.conversationID)
      return undefined;
    const model = member.backend?.model ?? member.model;
    return {
      id: `${member.backend ? piHistoryPrefix : ""}${peer.sessionID}`,
      harness: member.backend ? "pi-durable" : "opencode",
      kind: "crew",
      member: member.id,
      ...(member.name ? { title: member.name } : {}),
      ...(member.agent ? { agent: member.agent.slice(0, 200) } : {}),
      ...(model ? { model: model.slice(0, 200) } : {}),
    };
  }

  private authorized(id: string) {
    if (!id.startsWith(piHistoryPrefix)) return undefined;
    const [sessionID, childID, extra] = id
      .slice(piHistoryPrefix.length)
      .split("~");
    if (!sessionID || extra !== undefined) return undefined;
    const peer = this.state.peerBySession(sessionID);
    const member = this.team.crew.find(
      (member) => member.id === peer?.crewID && member.backend,
    );
    if (!peer || !member) return undefined;
    const mainID = this.state.piPeer(sessionID)?.conversationID;
    const conversationID = childID ?? mainID;
    if (
      !conversationID ||
      !/^(0|[1-9]\d*)$/.test(conversationID) ||
      !this.state.piOwnsConversation(sessionID, conversationID)
    )
      return undefined;
    return { member, sessionID, conversationID, child: childID !== undefined };
  }

  historyRoots(signal: AbortSignal) {
    return this.safe(signal, async () => {
      const sessions = this.team.crew.flatMap((member) => {
        const root = this.root(member);
        return root ? [root] : [];
      });
      if (sessions.length > HISTORY_PAGE) throw new CrewError(unavailable);
      return { sessions };
    });
  }

  historyDescribe(ids: readonly string[], signal: AbortSignal) {
    return this.safe(signal, async () => {
      decodeDescribe({ ids });
      const sessions: HistorySession[] = [];
      for (const id of ids) {
        const owned = this.authorized(id);
        if (!owned) continue;
        if (!owned.child) {
          const root = this.root(owned.member);
          if (root) sessions.push(root);
        } else
          sessions.push({
            id,
            harness: "pi-durable",
            kind: "conversation",
            parentID: `${piHistoryPrefix}${owned.sessionID}`,
            title: "task conversation",
          });
      }
      return { sessions };
    });
  }

  historyChildren(raw: HistoryChildrenInput, signal: AbortSignal) {
    return this.safe(signal, async () => {
      const input = decodeChildren(raw);
      const owned = this.authorized(input.parentID);
      if (!owned) throw new CrewError(unavailable);
      if (input.updatedSince !== undefined && input.cursor)
        throw new CrewError(unavailable);
      const cursor = input.cursor
        ? decodeChildrenCursor(
            JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
          )
        : undefined;
      if (cursor && cursor.parentID !== input.parentID)
        throw new CrewError(unavailable);
      if (owned.child) {
        if (cursor) throw new CrewError(unavailable);
        return { sessions: [] };
      }
      const rows = this.state.piHistoryConversations(
        owned.sessionID,
        cursor?.after ?? "",
        input.limit + 1,
        input.updatedSince,
      );
      const selected = rows.slice(0, input.limit);
      return {
        sessions: selected.map((row): HistorySession => ({
          id: `${piHistoryPrefix}${owned.sessionID}~${row.conversationID}`,
          harness: "pi-durable",
          kind: "conversation",
          parentID: input.parentID,
          title: row.title,
          ...(input.updatedSince !== undefined && row.updatedAt !== null
            ? { updatedAt: row.updatedAt }
            : {}),
        })),
        ...(input.updatedSince === undefined && rows.length > input.limit
          ? {
              cursor: Buffer.from(
                JSON.stringify({
                  parentID: input.parentID,
                  after: selected.at(-1)?.conversationID,
                }),
              ).toString("base64url"),
            }
          : {}),
      };
    });
  }

  historyEntries(raw: HistoryEntriesInput, signal: AbortSignal) {
    return this.safe(signal, async () => {
      const input = decodeEntries(raw);
      const owned = this.authorized(input.sessionID);
      if (!owned) throw new CrewError(unavailable);
      return this.pi.readHistory(owned.member, signal, (history, call) =>
        history.entries(
          {
            ...input,
            sessionID: owned.conversationID,
          },
          call,
        ),
      );
    });
  }
}
