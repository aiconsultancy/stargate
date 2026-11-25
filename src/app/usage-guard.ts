import type { Effect } from "effect";
import type { Logger } from "pino";
import { QuotaReader, type quotaConfigSchema } from "../backends/quota/quota";
import { UsageGuard } from "../backends/quota/usage-guard";
import {
  QuotaWatch,
  type UsageGuardConfig,
} from "../backends/quota/quota-watch";
import {
  type BotConfig,
  type Config,
  type IrcConfig,
  effectiveIrcConfig,
} from "../config";
import { abortable } from "../lib/effect";
import {
  type IrcClient,
  IrcRecipientChanged,
  IrcSendExpired,
} from "../transports/irc/client";

export function startUsageGuard(options: {
  config: UsageGuardConfig;
  registrations: readonly IrcConfig[];
  client: Pick<
    IrcClient,
    | "fold"
    | "registered"
    | "inChannel"
    | "verifiedNick"
    | "recipientGuard"
    | "budget"
    | "privmsg"
  >;
  reader: Pick<QuotaReader, "read">;
  allowed: () => boolean;
  log: Logger;
}): UsageGuard {
  const { config, registrations, client, reader, allowed, log } = options;

  if (!config.stateFile) {
    throw new Error("Usage guard state file is missing");
  }

  const sender = registrations.find((irc) => irc.id === config.sender);

  if (!sender) {
    throw new Error("Usage guard rear admiral registration is missing");
  }

  const server = sender.server;
  const joined = effectiveIrcConfig(sender).channels;

  const same = (left: string, right: string) =>
    client.fold(left) === client.fold(right);

  const targets =
    config.captains ??
    registrations
      .filter(
        (irc) =>
          irc.fleetPolicy?.role === "captain" &&
          irc.server.host === server.host &&
          irc.server.port === server.port &&
          irc.server.tls === server.tls,
      )
      .map((irc) => ({
        account: irc.account,
        channel: irc.fleetChannels?.home ?? irc.channels[0],
      }));

  const recipients = new Set<string>();

  const routes = targets.flatMap(({ account, channel }) => {
    if (!channel || !joined.some((name) => same(name, channel))) {
      log.warn(
        { captain: account, channel },
        "Usage guard rear admiral has no joined ship channel configured for captain",
      );

      return [];
    }

    const key = client.fold(account);

    if (recipients.has(key)) {
      log.warn(
        { captain: account, channel },
        "Usage guard captain is configured more than once",
      );

      return [];
    }

    recipients.add(key);

    return [{ account, channel }];
  });

  if (routes.length === 0) {
    log.warn(
      "Usage guard has no captain ship channels; crew cutoffs remain enabled",
    );
  }

  return new UsageGuard(
    { ...config, stateFile: config.stateFile },
    reader,
    routes,
    async ({ account, channel }, message, signal) => {
      if (!allowed() || !client.registered || !client.inChannel(channel)) {
        throw new Error("Usage guard IRC connection is not ready");
      }

      const nick = await client.verifiedNick(account);
      const recipient = client.recipientGuard(account, nick);
      const text = `@${nick} ${message}`;

      if (Buffer.byteLength(text) > client.budget("PRIVMSG", channel, {})) {
        throw new Error("Usage guard IRC message exceeds the line budget");
      }

      return async () => {
        try {
          await client.privmsg(
            channel,
            text,
            {},
            () =>
              allowed() &&
              !signal.aborted &&
              recipient() &&
              client.inChannel(channel),
          );
        } catch (error) {
          if (
            error instanceof IrcRecipientChanged ||
            error instanceof IrcSendExpired
          ) {
            return "retry" as const;
          }

          throw error;
        }

        return;
      };
    },
    log,
  );
}

type Provider = "claude" | "codex";

export function quotaWorkers(
  config: {
    quotaWatch?: Config["quotaWatch"];
    usageGuard?: Config["usageGuard"];
    irc?: Config["irc"];
  },
  log: Logger,
  add: (worker: { key: string; work: Effect.Effect<void> }) => void,
) {
  const readers = new Map<string, QuotaReader>();

  const readerFor = (
    proxy: typeof quotaConfigSchema.Type,
    providers: Provider[],
  ) => {
    const key = JSON.stringify([proxy, providers.toSorted()]);
    let reader = readers.get(key);

    if (!reader) {
      reader = new QuotaReader(proxy, Date.now, providers);
      readers.set(key, reader);
    }

    return reader;
  };

  return {
    slack(
      id: string,
      bot: () => BotConfig,
      slack: {
        announce(
          channel: string,
          text: string,
          signal: AbortSignal,
        ): Promise<string>;
      },
      botLog: Logger,
    ) {
      const watcher = config.quotaWatch;

      if (watcher?.report.bot !== id) {
        return;
      }

      const providers = watcher.providers.filter(
        (provider) => provider !== "codex" || !watcher.nativeCodexFile,
      );

      const channel = watcher.report.channel;

      const watch = new QuotaWatch(
        watcher,
        readerFor(watcher.proxy, providers),
        async (text, signal) => {
          if (
            !bot().access.deniedChannels.some(
              (rule) => rule === "*" || rule === channel,
            )
          ) {
            await slack.announce(channel, text, signal);
          }
        },
        botLog,
        Date.now,
        config.usageGuard?.enabled === true,
      );

      add({
        key: `quota:${id}`,
        work: abortable((signal) => watch.work(signal)),
      });
    },
    irc(
      clientFor: (id: string) => IrcClient | undefined,
      allowed: () => boolean,
    ) {
      const guard = config.usageGuard;

      if (!guard?.enabled || !guard.sender || !guard.proxy) {
        return;
      }

      const client = clientFor(guard.sender);

      if (!client) {
        throw new Error(
          "Usage guard rear admiral IRC connection is unavailable",
        );
      }

      const guardLog = log.child({ usageGuard: guard.sender });

      const providers = (["claude", "codex"] as const).filter(
        (provider) =>
          Object.hasOwn(guard.providers, provider) &&
          (provider !== "codex" || !guard.nativeCodexFile),
      );

      const watch = startUsageGuard({
        config: guard,
        registrations: config.irc ?? [],
        client,
        reader: readerFor(guard.proxy, providers),
        allowed,
        log: guardLog,
      });

      guardLog.info("Usage guard enabled");

      add({
        key: "usage-guard",
        work: abortable((signal) => watch.work(signal)),
      });
    },
  };
}
