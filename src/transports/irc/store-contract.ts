export type IrcBurstMessage = {
  eventId: string;
  thread: string;
  source: string;
  text: string;
  originalText: string;
  received: number;
  files: string[];
};

export interface IrcOperations {
  turnsSince(input: {
    botKeys: readonly string[];
    sender: "captain" | "crew";
    since: number;
    scope: { conversation: string } | { channel: string };
  }): number;
  ircReplyParent(botKey: string, thread: string): string | undefined;
  ircBurst(
    job: number,
  ): { policy: string; deadline: number; maximum: number } | null;
  startIrcBurst(
    job: number,
    policy: string,
    deadline: number,
    maximum: number,
  ): void;
  extendIrcBurst(job: number, deadline: number): void;
  ircBurstMessages(job: number): IrcBurstMessage[];
  ircBurstRequest(
    botKey: string,
    channel: string,
    msgid: string,
  ): string | undefined;
  saveIrcBurstMessage(
    job: number,
    ordinal: number,
    botKey: string,
    message: IrcBurstMessage,
  ): void;
  ircThreadRoot(
    botKey: string,
    channel: string,
    msgid: string,
  ): string | undefined;
  ircThreadParticipating(
    botKey: string,
    channel: string,
    root: string,
  ): boolean;
  ircRequestAnchor(
    botKey: string,
    channel: string,
    msgid: string,
  ): string | undefined;
  ircThreadMessage(
    botKey: string,
    channel: string,
    msgid: string,
    root: string,
    request?: string,
  ): void;
  joinIrcThread(botKey: string, channel: string, root: string): void;
  ircCursor(botKey: string, target: string): string | undefined;
  saveIrcCursor(
    botKey: string,
    target: string,
    time: string,
    replace?: boolean,
  ): void;
  markStargateDmCopy(id: string, now?: number): void;
  stargateDmCopy(id: string): boolean;
  stargateDmCursor(botKey: string): number | undefined;
  saveStargateDmCursor(botKey: string, sequence: number): void;
}
