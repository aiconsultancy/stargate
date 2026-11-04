import { botSchema } from "../src/config";

export function bot(id = "helper") {
  return botSchema.parse({
    id,
    slack: {
      appId: "A123",
      appTokenEnv: "APP_TOKEN",
      botTokenEnv: "BOT_TOKEN",
    },
    access: { users: ["U123"], channels: ["C123", "D123"] },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
    },
  });
}

export const identity = { team: "T123", user: "UBOT" };

export function event(text = "<@UBOT> hello", ts = "1.000") {
  return {
    api_app_id: "A123",
    team_id: "T123",
    event_id: `Ev${ts}`,
    event: { type: "app_mention", user: "U123", channel: "C123", text, ts },
  };
}
