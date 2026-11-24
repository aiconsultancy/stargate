import { Result, Schema } from "effect";
import {
  type Identity,
  isAllowedChannel,
  isAllowedUser,
} from "../../shared/registration";
import type { NotifyConfig } from "./config";
import { Destination, audienceAllowed, physicalKey } from "./model";
import type { DeliveryDestination } from "./sink";

type BotConfig = Parameters<typeof isAllowedChannel>[0];

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
