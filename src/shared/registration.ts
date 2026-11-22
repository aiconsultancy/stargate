import { createHash } from "node:crypto";

type RoutingRegistration = {
  id: string;
  backend: { type: string; sessionID?: string | undefined };
  slack: { appId: string; inboundReactions?: boolean | undefined };
  access: {
    users: readonly string[];
    deniedUsers: readonly string[];
    channels: readonly string[];
    deniedChannels: readonly string[];
    mentionOnly: boolean;
    peerCaptains?: boolean | undefined;
    textMentions?:
      | {
          channels: readonly string[];
          names: readonly string[];
          muteBypassNames?: readonly string[] | undefined;
        }
      | undefined;
  };
  transcription?:
    | { spokenMentions?: { channels: readonly string[] } | undefined }
    | undefined;
  slackReadReceipts?: boolean | undefined;
};

export type Identity = { team: string; user: string };

export function backendFingerprint<
  T extends Pick<RoutingRegistration, "backend">,
>(config: T) {
  // A pin selects execution identity, not a new Slack/outbox namespace.
  const backend = { ...config.backend };
  if (backend.type === "opencode") delete backend.sessionID;
  return createHash("sha256").update(JSON.stringify(backend)).digest("hex");
}

export function botKey<T extends RoutingRegistration>(
  config: T,
  identity: Identity,
) {
  const fingerprint = backendFingerprint(config);
  return JSON.stringify([
    config.id,
    config.slack.appId,
    identity.team,
    identity.user,
    fingerprint,
  ]);
}

function matchesId(rules: readonly string[], id: string) {
  return rules.includes("*") || rules.includes(id);
}

export function isAllowedUser<T extends RoutingRegistration>(
  config: T,
  user: string,
) {
  return (
    !matchesId(config.access.deniedUsers, user) &&
    matchesId(config.access.users, user)
  );
}

export function isAllowedChannel<T extends RoutingRegistration>(
  config: T,
  channel: string,
) {
  return (
    !matchesId(config.access.deniedChannels, channel) &&
    matchesId(config.access.channels, channel)
  );
}
