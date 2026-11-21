import { randomBytes } from "node:crypto";

/**
 * Agent dispatch chat markers. Like `+stargate/progress`, the value is a
 * client tag for programs; the message text is for people and can change.
 * Clients must check the server's authenticated `account` tag before acting
 * on a marker. Stargate trusts an answer only from the asked captain's
 * account, as a reply (`+draft/reply`) to that offer's own message ID.
 */
export const dispatchTag = "+stargate/dispatch";

/** Behaviour 1 notice and behaviour 2 offer: the two markers that wake a captain. */
export type DispatchRequestKind = "assigned" | "offer";
/** A captain's answer, sent through the Stargate answer tool. */
export type DispatchAnswer = "accept" | "decline";
/** Rear admiral status lines for people; they never wake an agent. */
export type DispatchOutcome =
  | "accepted"
  | "timeout"
  | "withdrawn"
  | "taken"
  | "retrying";

export type DispatchMarker =
  | { kind: "assigned" | "gave-up"; issue: string }
  | { kind: "offer"; offerID: string }
  | { kind: DispatchAnswer; offerID: string }
  | { kind: DispatchOutcome; offerID: string };

const offerPattern = /^offer-[a-f0-9]{16}$/;
const issuePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const outcomes: readonly string[] = [
  "accepted",
  "timeout",
  "withdrawn",
  "taken",
  "retrying",
];

export function isOfferID(value: string): boolean {
  return offerPattern.test(value);
}

export function newOfferID(): string {
  return `offer-${randomBytes(8).toString("hex")}`;
}

export function formatDispatchMarker(marker: DispatchMarker): string {
  return "issue" in marker
    ? `${marker.kind},${marker.issue}`
    : `${marker.kind},${marker.offerID}`;
}

/** Strict parser: anything unexpected is not a marker. */
export function parseDispatchMarker(
  value: string | undefined,
): DispatchMarker | undefined {
  if (value === undefined) return;
  const comma = value.indexOf(",");
  if (comma < 0 || value.indexOf(",", comma + 1) >= 0) return;
  const kind = value.slice(0, comma);
  const argument = value.slice(comma + 1);
  if (kind === "assigned" || kind === "gave-up")
    return issuePattern.test(argument) ? { kind, issue: argument } : undefined;
  if (!offerPattern.test(argument)) return;
  if (kind === "offer") return { kind, offerID: argument };
  if (kind === "accept" || kind === "decline")
    return { kind, offerID: argument };
  if (outcomes.includes(kind))
    return { kind: kind as DispatchOutcome, offerID: argument };
  return;
}

/** One line of untrusted issue text for chat: no controls, bounded. */
export function chatTitle(title: string, maxCodePoints = 120): string {
  const flat = [...title.replace(/\s+/g, " ").trim()]
    .filter((character) => !/\p{Cc}|\p{Cf}/u.test(character))
    .join("");
  const points = [...flat];
  return points.length <= maxCodePoints
    ? flat
    : `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

export const answerToolName = "fleet_answer_offer";

function minutes(seconds: number) {
  const value = Math.max(1, Math.round(seconds / 60));
  return value === 1 ? "1 minute" : `${value} minutes`;
}

export type IssueLabel = { identifier: string; title: string };

function issueLabel(issue: IssueLabel, maxTitle = 120) {
  return `${issue.identifier} “${chatTitle(issue.title, maxTitle)}”`;
}

/** Text for people. Programs read the marker, never this text. */
export const dispatchText = {
  assigned: (nick: string, issue: IssueLabel, maxTitle?: number) =>
    `@${nick}: ${issueLabel(issue, maxTitle)} is assigned to you. Please pick it up, assign it to a crew member and get it done.`,
  offer: (
    nick: string,
    offerID: string,
    issue: IssueLabel,
    timeoutSeconds: number,
    maxTitle?: number,
  ) =>
    `@${nick}: ${issueLabel(issue, maxTitle)} is ready for agents. Can you take it? Call ${answerToolName} with offerID ${offerID} to accept or decline within ${minutes(timeoutSeconds)}. No answer counts as a decline.`,
  accepted: (account: string, offerID: string, issue: IssueLabel) =>
    `${account} accepted offer ${offerID}: ${issue.identifier} is now assigned to ${account}.`,
  timeout: (
    account: string,
    offerID: string,
    issue: IssueLabel,
    timeoutSeconds: number,
  ) =>
    `No answer from ${account} to offer ${offerID} for ${issue.identifier} within ${minutes(timeoutSeconds)}; counted as a decline.`,
  taken: (account: string, offerID: string, issue: IssueLabel) =>
    `${issue.identifier} was assigned to someone else before ${account}'s acceptance; offer ${offerID} is closed.`,
  withdrawn: (offerID: string, issue: IssueLabel, reason: WithdrawReason) =>
    `Withdrew offer ${offerID} for ${issue.identifier}: ${withdrawText[reason]}.`,
  gaveUp: (issue: IssueLabel, rounds: number) =>
    `No captain could take ${issue.identifier} after ${rounds === 1 ? "1 round" : `${rounds} rounds`}. Ready for agents is cleared; flag the issue again to retry.`,
  retrying: (account: string, offerID: string, issue: IssueLabel) =>
    `${account} accepted offer ${offerID}, but ${issue.identifier} could not be assigned yet. Stargate will retry.`,
  answer: (answer: DispatchAnswer, offerID: string, reason?: string) =>
    `${answer === "accept" ? "Accepting" : "Declining"} offer ${offerID}${reason ? `: ${chatTitle(reason, 200)}` : "."}`,
};

export type WithdrawReason =
  | "assigned"
  | "unflagged"
  | "closed"
  | "archived"
  | "missing"
  | "moved";

const withdrawText: Record<WithdrawReason, string> = {
  assigned: "it is now assigned",
  unflagged: "it is no longer ready for agents",
  closed: "it is closed",
  archived: "it was archived",
  missing: "it can no longer be read",
  moved: "it no longer belongs to this fleet",
};
