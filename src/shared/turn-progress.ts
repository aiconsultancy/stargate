/** Fixed lifecycle metadata. No model text or tool data crosses this boundary. */
const descriptions = {
  retry: "OpenCode scheduled a retry.",
  clarified: "OpenCode closed the clarification.",
  waiting: "Waiting for a clarification answer.",
  completed: "OpenCode finished this request.",
  submitting: "OpenCode has not confirmed receipt.",
  accepted:
    "OpenCode accepted the request. Delivery to the model is unconfirmed.",
  queued: "OpenCode queued the request. Delivery to the model is unconfirmed.",
  delivered: "OpenCode delivered the request to the session.",
  model: "OpenCode started a model step.",
  reasoning: "OpenCode reported model reasoning.",
  tool: "OpenCode started a tool call.",
  reply: "OpenCode started writing a reply.",
};

export type TurnStage = keyof typeof descriptions;

export type TurnProgress = {
  stage: TurnStage;
  observedAt: number;
  disconnected?: boolean;
  backend?: "claude" | "codex" | "acp" | "antigravity";
};

export function turnProgressText(progress?: TurnProgress) {
  if (!progress) {
    return "Stargate has no confirmed backend activity for this request.";
  }

  const time = new Date(progress.observedAt).toISOString().slice(11, 16);

  return `${progress.disconnected ? "OpenCode event stream disconnected. " : ""}${descriptions[progress.stage].replace("OpenCode", backendName(progress.backend))} Observed at ${time} UTC.`;
}

function backendName(backend: string | undefined) {
  switch (backend) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "acp":
      return "ACP";
    case "antigravity":
      return "Antigravity";
    default:
      return "OpenCode";
  }
}
