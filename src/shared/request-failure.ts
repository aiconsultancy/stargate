import { slackContent } from "./slack-format";

export const cancellationNotice =
  "Stargate received your stop request. Work may have run; existing effects may remain. The request was not repeated. Check agent state before trying again.";

export class AttachmentInputUnavailable extends Error {}

export class PromptNotSubmitted extends Error {}

export class PendingBackendQuestion extends PromptNotSubmitted {}

/**
 * What a backend saw when the model provider or the agent process failed.
 * Every backend maps its own evidence to one of these; provider text,
 * credential names, account IDs and URLs never leave the adapter.
 *
 * - `quota`: quota, rate limit, billing or cooldown (HTTP 402, 429).
 * - `auth`: rejected credentials or account (HTTP 401, 403).
 * - `model`: the configured model does not exist or is not allowed (404).
 * - `timeout`: the provider did not answer in time (HTTP 408, 504).
 * - `network`: the provider or its proxy could not be reached.
 * - `crash`: the agent process ended without a result.
 * - `provider`: any other provider error.
 */
export const backendFailureKinds = [
  "quota",
  "auth",
  "model",
  "timeout",
  "network",
  "crash",
  "provider",
] as const;

export type BackendFailureKind = (typeof backendFailureKinds)[number];

/** The category of a provider HTTP status that reports a failure. */
export function statusKind(status: number): BackendFailureKind {
  if (status === 429 || status === 402) return "quota";

  if (status === 401 || status === 403) return "auth";

  if (status === 404) return "model";

  if (status === 408 || status === 504) return "timeout";

  return "provider";
}

/**
 * A backend failure with its category. `status` is the provider's HTTP
 * status when the backend saw one. `ran` is false only when the backend can
 * prove that this turn did no work: the failure came before any tool call
 * or answer, so the request can be sent again.
 */
export class BackendFailure extends Error {
  readonly status: number | undefined;
  readonly ran: boolean;
  constructor(
    readonly kind: BackendFailureKind,
    options: { status?: number | undefined; ran: boolean },
  ) {
    super(`Backend failure: ${kind}`);
    this.status =
      options.status !== undefined &&
      Number.isInteger(options.status) &&
      options.status >= 100 &&
      options.status <= 599
        ? options.status
        : undefined;
    this.ran = options.ran;
  }

  /** The durable cause: category, status (0 when unknown) and work flag. */
  get failure(): ProviderFailure {
    return `provider:${this.kind}:${this.status ?? 0}:${this.ran ? "ran" : "idle"}`;
  }
}

/** No connection was made: the request was never sent. */
const unreachedCodes = new Set([
  "ECONNREFUSED",
  "ConnectionRefused",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "FailedToOpenSocket",
]);

/**
 * A socket-level failure in `error` or a cause below it. `unreached`: no
 * connection was made, so the peer received nothing. `lost`: a connection
 * broke, so the peer may have received the request. Reads only the fixed
 * error code, never a message.
 */
export function connectionFailure(
  error: unknown,
): "unreached" | "lost" | undefined {
  let current = error;

  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code: unknown = Reflect.get(current, "code");

    if (typeof code === "string") {
      if (unreachedCodes.has(code)) return "unreached";

      if (code === "ECONNRESET") return "lost";
    }

    current = current.cause;
  }

  return undefined;
}

/** A `BackendFailure` in its durable form; see `providerFailure`. */
export type ProviderFailure =
  `provider:${BackendFailureKind}:${number}:${"ran" | "idle"}`;

/** Only fixed safe causes cross the durable queue and Slack boundary. */
export type RequestFailure =
  | "timeout"
  | "pending-question"
  | "cancelled"
  | "backend"
  | "context"
  | "attachments"
  | "transcription"
  | "interrupted"
  | "reaction"
  | "history"
  | "muted"
  | ProviderFailure;

type FixedFailure = Exclude<RequestFailure, ProviderFailure>;

const providerPattern = new RegExp(
  `^provider:(${backendFailureKinds.join("|")}):(0|[1-5]\\d\\d):(ran|idle)$`,
);

/** The parts of a durable provider cause; undefined for any other text. */
export function providerFailure(
  cause: string,
):
  | { kind: BackendFailureKind; status: number | undefined; ran: boolean }
  | undefined {
  const match = providerPattern.exec(cause);

  if (!match) return undefined;
  const kind = backendFailureKinds.find((item) => item === match[1]);

  if (!kind) return undefined;

  return {
    kind,
    status: match[2] === "0" ? undefined : Number(match[2]),
    ran: match[3] === "ran",
  };
}

const provider: Record<
  BackendFailureKind,
  { title: string; text: (status: string) => string }
> = {
  quota: {
    title: "Provider quota reached",
    text: (status) =>
      `The model provider refused this request: quota or rate limit reached${status}. Try again after it resets, or switch model.`,
  },
  auth: {
    title: "Provider credentials rejected",
    text: (status) =>
      `The model provider refused this request: its credentials were rejected${status}. An operator must check the provider credentials.`,
  },
  model: {
    title: "Model unavailable",
    text: (status) =>
      `The model provider refused this request: the configured model is not available${status}. An operator must check the model setting.`,
  },
  timeout: {
    title: "Provider timeout",
    text: (status) =>
      `The model provider did not answer in time${status}. Try again later.`,
  },
  network: {
    title: "Provider unreachable",
    text: () =>
      "Stargate could not reach the model provider or its proxy. An operator must check that it is running.",
  },
  crash: {
    title: "Agent process stopped",
    text: () => "The agent process stopped before it gave a result.",
  },
  provider: {
    title: "Provider error",
    text: (status) => `The model provider failed${status}. Try again later.`,
  },
};

function describe(cause: RequestFailure): { title: string; text: string } {
  const parsed = providerFailure(cause);

  // A stored cause that is neither fixed nor a valid provider cause.
  if (!parsed) return failures[cause as FixedFailure] ?? failures.backend;
  const status = parsed.status ? ` (HTTP ${parsed.status})` : "";

  return {
    title: provider[parsed.kind].title,
    text: `${provider[parsed.kind].text(status)} ${
      parsed.ran
        ? "Work may have run; it was not repeated. Check agent state before trying again."
        : "Nothing ran. You can send the request again."
    }`,
  };
}

const failures = {
  muted: {
    title: "Notification suppressed",
    text: "This queued chat notification was intentionally suppressed by a saved mute. No agent turn was started and no Slack error reply is sent. Unmuting does not replay it.",
  },
  timeout: {
    title: "Time limit reached",
    text: "Stargate reached the request time limit and requested cancellation. Work may have run; it was not repeated. Check agent state before trying again. For longer work, increase turnTimeoutMs or split the request.",
  },
  cancelled: { title: "Stop requested", text: cancellationNotice },
  "pending-question": {
    title: "Earlier question needs an answer",
    text: "OpenCode is waiting on a question from earlier work. Stargate did not submit this request. Answer the earlier question in its own thread or ask an operator to resolve it in OpenCode, then resend this request.",
  },
  backend: {
    title: "Agent unavailable",
    text: "Stargate could not finish this request because the backend failed or became unavailable. Work may have run; it was not repeated. Check agent state and backend availability before trying again.",
  },
  context: {
    title: "Thread context unavailable",
    text: "Stargate could not load initial thread context. No agent turn was started. Check Slack history access and try again.",
  },
  attachments: {
    title: "Attachments unavailable",
    text: "Stargate could not pass these attachments to the agent. Check files:read access, channel sharing, supported file types and size limits. No agent turn was admitted; the files were not silently dropped.",
  },
  transcription: {
    title: "Voice message not transcribed: please type it",
    text: "Stargate could not transcribe this audio or video message. No agent turn was started. Please type your message. Accepted formats are m4a, mp3, mp4, mpeg, mpga, wav and webm.",
  },
  interrupted: {
    title: "Gateway interrupted",
    text: "Stargate stopped during this request. Work may have run; it was not repeated. Check agent state before sending another request.",
  },
  history: {
    title: "Reply delayed",
    text: "The agent finished, but its reply was not yet readable in session history. Stargate will post it in this thread when it is. The request was not repeated. Check agent state if no reply appears.",
  },
  reaction: {
    title: "Reaction unavailable",
    text: "Stargate could not add that reaction. The agent request was not repeated. Check Slack reaction permissions before trying again.",
  },
} satisfies Record<FixedFailure, { title: string; text: string }>;

export function failureText(cause: RequestFailure): string {
  return describe(cause).text;
}

export function failureContent(cause: RequestFailure) {
  const { title, text } = describe(cause);

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
