import { Result, Schema } from "effect";
import {
  type Identity,
  isAllowedChannel,
  isAllowedUser,
} from "../../shared/registration";
import type { NotifyConfig } from "./config";
import { audienceAllowed, Destination, physicalKey } from "./model";
import type { DeliveryDestination } from "./sink";
import { topicMatches } from "./subscriptions";

type BotConfig = Parameters<typeof isAllowedChannel>[0];

/** Offline identity uncertainty must not permit possible peer echo. */
export function notifyConfigError(
  notify: NotifyConfig,
  bots: readonly BotConfig[],
  listen?: string,
  live = false,
): string | undefined {
  const paths = new Set<string>();
  for (const adapter of Object.values(notify.adapters)) {
    if (adapter.enabled && listen !== "unix")
      return "Notification HTTP requires Unix API mode";
    if (paths.has(adapter.path)) return "Duplicate notification mount";
    paths.add(adapter.path);
    if (
      new Set(adapter.sources.map((source) => source.id)).size !==
      adapter.sources.length
    )
      return "Duplicate notification source";
  }
  const aliases = new Map<string, string>();
  for (const destination of Object.values(notify.destinations)) {
    const sender = bots.find((bot) => bot.id === destination.slack.bot);
    if (
      !sender ||
      (!live && !isAllowedChannel(sender, destination.slack.channel))
    )
      return "Notification destination must name an allowed Slack channel and registration";
    if (
      !live &&
      bots.some(
        (receiver) =>
          receiver.id !== sender.id &&
          receiver.access.peerCaptains &&
          isAllowedChannel(receiver, destination.slack.channel) &&
          !receiver.access.deniedUsers.includes("*"),
      )
    )
      return "Notification destination may echo into a local receiver";
    const key = JSON.stringify([
      destination.slack.bot,
      destination.slack.channel,
    ]);
    if (aliases.has(key) && aliases.get(key) !== destination.audience)
      return "Conflicting notification destination aliases";
    aliases.set(key, destination.audience);
  }
  for (const subscription of notify.subscriptions) {
    for (const alias of subscription.to) {
      if (!Object.hasOwn(notify.destinations, alias))
        return "Unknown notification destination alias";
      const destination = notify.destinations[alias];
      if (!destination) return "Unknown notification destination alias";
      for (const adapter of Object.values(notify.adapters))
        for (const source of adapter.sources)
          if (
            !audienceAllowed(source.audience, destination.audience) &&
            source.topics.some((grant) =>
              patternsOverlap(grant, subscription.topic),
            )
          )
            return "Notification audience is not allowed";
    }
  }
  return undefined;
}
function patternsOverlap(left: string, right: string) {
  return (
    topicMatches(left, right.replace(/\.\*$/, ".x")) ||
    topicMatches(right, left.replace(/\.\*$/, ".x"))
  );
}
export interface SlackRegistration {
  readonly bot: BotConfig;
  readonly identity: Identity;
}
function echo(
  destination: Destination,
  registrations: readonly SlackRegistration[],
) {
  return registrations.some(
    ({ bot, identity }) =>
      identity.team === destination.workspaceId &&
      identity.user !== destination.botUserId &&
      bot.access.peerCaptains &&
      isAllowedChannel(bot, destination.channel) &&
      isAllowedUser(bot, destination.botUserId),
  );
}
export function resolveDestinations(
  notify: NotifyConfig,
  registrations: readonly SlackRegistration[],
): Record<string, Destination> {
  const result: Record<string, Destination> = {};
  const physical = new Map<string, Destination>();
  for (const [alias, configured] of Object.entries(notify.destinations)) {
    const sender = registrations.find(
      ({ bot }) => bot.id === configured.slack.bot,
    );
    if (!sender || !isAllowedChannel(sender.bot, configured.slack.channel))
      throw new Error("Unsafe notification destination binding");
    const decoded = Schema.decodeUnknownResult(Destination)({
      transport: "slack",
      registrationId: sender.bot.id,
      appId: sender.bot.slack.appId,
      workspaceId: sender.identity.team,
      botUserId: sender.identity.user,
      channel: configured.slack.channel,
      audience: configured.audience,
    });
    if (Result.isFailure(decoded) || echo(decoded.success, registrations))
      throw new Error("Unsafe notification destination binding");
    const destination = decoded.success;
    const previous = physical.get(physicalKey(destination));
    if (
      previous &&
      (previous.audience !== destination.audience ||
        previous.registrationId !== destination.registrationId)
    )
      throw new Error("Conflicting notification destination aliases");
    physical.set(physicalKey(destination), destination);
    result[alias] = destination;
  }
  return result;
}
/** One synchronous view and check directly before request dispatch. */
export function bindingAllowed(
  destination: DeliveryDestination,
  notify: NotifyConfig | undefined,
  registrations: readonly SlackRegistration[],
  admitted: Readonly<Record<string, Destination>>,
) {
  if (
    !notify ||
    !audienceAllowed(destination.sourceAudience, destination.audience)
  )
    return false;
  try {
    const aliases = Object.entries(admitted).filter(
      ([, value]) =>
        physicalKey(value) === physicalKey(destination) &&
        value.registrationId === destination.registrationId,
    );
    const destinations: NotifyConfig["destinations"] = Object.fromEntries(
      aliases.flatMap(([alias]) => {
        const value = Object.hasOwn(notify.destinations, alias)
          ? notify.destinations[alias]
          : undefined;
        return value ? [[alias, value]] : [];
      }),
    );
    const current = resolveDestinations(
      { ...notify, destinations },
      registrations,
    );
    return (
      aliases.length > 0 &&
      aliases.every(([alias]) => {
        const value = current[alias];
        return (
          value !== undefined &&
          value.registrationId === destination.registrationId &&
          physicalKey(value) === physicalKey(destination) &&
          value.audience === destination.audience
        );
      })
    );
  } catch {
    return false;
  }
}
