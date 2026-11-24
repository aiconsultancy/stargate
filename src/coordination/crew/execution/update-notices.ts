import type { SessionInfo } from "@opencode/client";
import { Schema } from "effect";
import {
  type UpdateReceipt,
  type UpdateSnapshot,
  noticeTools,
  scopedUpdate,
} from "../../../automation/maintenance/update-notice";
import { piCrewToolDefinitions } from "../pi/pi-extension";
import type { Team } from "../team";
import type { CrewState } from "./state";

type NoticeOptions = {
  namespace: string;
  team: Team;
  worktrees: Readonly<Record<string, string>>;
  captainSessionID?: string | undefined;
};

type NoticeSession = Pick<SessionInfo, "agent" | "location" | "model"> & {
  permissions?: unknown;
};

type NoticeMail = (
  message: { op: "send"; to: string; text: string; key: string },
  caller: { sessionID: string; agent: string; signal: AbortSignal },
) => Promise<unknown>;

export class CrewUpdateNotices {
  public constructor(
    private readonly options: NoticeOptions,
    private readonly state: Pick<
      CrewState,
      "peer" | "peerBySession" | "ircSessions" | "updateNotices"
    >,
    private readonly session: (
      id: string,
      signal: AbortSignal,
    ) => Promise<NoticeSession>,
    private readonly mail: NoticeMail,
  ) {}

  /** Passive ready-state information only: never provision, promote or notify a worker. */
  public async updateNotice(
    snapshot: UpdateSnapshot,
    tools: Record<string, string>,
    signal: AbortSignal,
  ): Promise<UpdateReceipt[]> {
    const captain = this.options.captainSessionID;

    if (!captain) return [];
    const receipts: UpdateReceipt[] = [];

    for (const member of this.options.team.crew) {
      signal.throwIfAborted();
      const peer = this.state.peer(member.id);

      if (peer?.status !== "ready") continue;

      try {
        let effective: unknown;

        if (member.backend)
          effective = {
            model: member.backend.model,
            permissions: member.permissionProfile,
            tools: member.backend.tools,
          };
        else {
          const session = await this.session(peer.sessionID, signal);

          if (
            session.agent !== (member.agent ?? member.id) ||
            session.location.directory !== this.options.worktrees[member.id]
          )
            throw new Error("Wrong crew session");
          effective = {
            model: session.model,
            permissions: session.permissions,
          };
        }

        const selectedTools = member.backend
          ? noticeTools(
              member.backend.tools === "coding"
                ? piCrewToolDefinitions().map((tool) => ({
                    id: tool.name,
                    description: tool.description,
                    input: tool.schema,
                  }))
                : [],
            )
          : tools;

        const next = scopedUpdate(snapshot, selectedTools, effective);
        receipts.push(
          await this.state.updateNotices.deliver(
            peer.sessionID,
            next,
            member.backend ? "mail" : "queued",
            async (id, text) => {
              if (member.backend) {
                const receipt = await this.mail(
                  { op: "send", to: member.id, text, key: id },
                  {
                    sessionID: captain,
                    agent:
                      this.options.team.captain.agent ??
                      this.options.team.captain.id,
                    signal,
                  },
                );

                Schema.decodeUnknownSync(
                  Schema.Struct({ stored: Schema.Literal(true) }),
                )(receipt);
              } else
                this.state.updateNotices.queueContext(
                  peer.sessionID,
                  id,
                  this.options.namespace,
                );
            },
            this.options.namespace,
          ),
        );
      } catch {
        receipts.push({ sessionID: peer.sessionID, status: "uncertain" });
      }
    }

    return receipts;
  }

  /** Consume only for this roster's native worker, at an already-running model context boundary. */
  public updateNoticeContext(
    sessionID: string,
    agent: string,
    system: { type: "text"; text: string }[],
  ) {
    if (
      agent ===
        (this.options.team.captain.agent ?? this.options.team.captain.id) &&
      !this.state.peerBySession(sessionID)
    ) {
      this.state.updateNotices.consumeContext(
        sessionID,
        this.options.namespace,
        (text) => {
          system.push({ type: "text", text });
        },
      );

      return;
    }

    const peer = this.state.peerBySession(sessionID);
    const ircMember = this.state.ircSessions.crewID(sessionID);

    const member = this.options.team.crew.find(
      (member) => member.id === (peer?.crewID ?? ircMember),
    );

    if (
      (!ircMember && peer?.status !== "ready") ||
      !member ||
      member.backend ||
      agent !== (member.agent ?? member.id)
    )
      return;
    this.state.updateNotices.consumeContext(
      sessionID,
      this.options.namespace,
      (text) => {
        system.push({ type: "text", text });
      },
    );
  }
}
