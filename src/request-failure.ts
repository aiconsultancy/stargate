import { cancellationNotice } from "./cancellation";
import { slackContent } from "./slack-format";

export class AttachmentInputUnavailable extends Error {}

/** Only fixed safe causes cross the durable queue and Slack boundary. */
export type RequestFailure =
  | "timeout"
  | "cancelled"
  | "backend"
  | "context"
  | "attachments"
  | "interrupted"
  | "reaction"
  | "history";

const failures = {
  timeout: {
    title: "Time limit reached",
    text: "Pogo reached the request time limit and requested cancellation. Work may have run; it was not repeated. Check agent state before trying again. For longer work, increase turnTimeoutMs or split the request.",
  },
  cancelled: { title: "Stop requested", text: cancellationNotice },
  backend: {
    title: "Agent unavailable",
    text: "Pogo could not finish this request because the backend failed or became unavailable. Work may have run; it was not repeated. Check agent state and backend availability before trying again.",
  },
  context: {
    title: "Thread context unavailable",
    text: "Pogo could not load initial thread context. No agent turn was started. Check Slack history access and try again.",
  },
  attachments: {
    title: "Attachments unavailable",
    text: "Pogo could not pass these attachments to the agent. Check files:read access, channel sharing, supported file types and size limits. No agent turn was admitted; the files were not silently dropped.",
  },
  interrupted: {
    title: "Gateway interrupted",
    text: "Pogo stopped during this request. Work may have run; it was not repeated. Check agent state before sending another request.",
  },
  history: {
    title: "Reply delayed",
    text: "The agent finished, but its reply was not yet readable in session history. Pogo will post it in this thread when it is. The request was not repeated. Check agent state if no reply appears.",
  },
  reaction: {
    title: "Reaction unavailable",
    text: "Pogo could not add that reaction. The agent request was not repeated. Check Slack reaction permissions before trying again.",
  },
} satisfies Record<RequestFailure, { title: string; text: string }>;

export function failureText(cause: RequestFailure): string {
  return failures[cause].text;
}

export function failureContent(cause: RequestFailure) {
  const { title, text } = failures[cause];
  const plain = (text: string) => ({
    type: "plain_text" as const,
    text,
    emoji: false,
  });
  return {
    text: slackContent(`Request status — ${title}\n\n${text}`, "plain").text,
    blocks: [
      {
        type: "container" as const,
        title: plain("Request status"),
        subtitle: plain(title),
        is_collapsible: true,
        default_collapsed: true,
        child_blocks: [{ type: "section" as const, text: plain(text) }],
      },
    ],
  };
}
