import { join } from "node:path";
import type { Logger } from "pino";
import {
  type AgentDispatchConfig,
  type IrcConfig,
  agentDispatchTarget,
} from "../../../config";
import type { IrcShip } from "../../../transports/irc/ship";
import { SubspaceApi } from "./api";
import { AgentDispatcher } from "./dispatcher";
import { IrcDispatchMessenger, ircDispatchAnswer } from "./irc";
import { DispatchLedger } from "./ledger";

/** What the gateway runtime supplies to agent dispatch. */
export type AgentDispatchHost = {
  config: AgentDispatchConfig | undefined;
  irc: readonly IrcConfig[];
  /** The started ship of an IRC registration, by registration ID. */
  ship(
    registration: string,
  ): Pick<IrcShip, "dispatchListener" | "registrations"> | undefined;
  dataDirectory: string;
  /** False once the gateway is closing: nothing more is sent. */
  allowed: () => boolean;
  log: Logger;
  /** Tests only: the Subspace API transport and environment. */
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

export type AgentDispatchRuntime = {
  /** Worker key, beside the rear admiral registration's own workers. */
  key: string;
  log: Logger;
  run(signal: AbortSignal): Promise<void>;
  close(): void;
};

/**
 * Agent dispatch for this configuration, or undefined when the section is
 * absent or `enabled` is false. Off means nothing is opened, listened to or
 * contacted: no ledger file, no chat listener and no API request.
 */
export function startAgentDispatch(
  host: AgentDispatchHost,
): AgentDispatchRuntime | undefined {
  const dispatch = host.config;

  if (!dispatch?.enabled) return;
  const target = agentDispatchTarget(dispatch, host.irc);

  if (typeof target === "string") throw new Error(target);
  const ship = host.ship(target.registration.id);
  const primary = ship?.registrations[0];

  if (!ship || !primary)
    throw new Error("Agent dispatch registration unavailable");
  const client = primary.client;
  const enrolled = target.registration.fleetPolicy?.agentAccounts ?? [];
  const log = host.log.child({ agentDispatch: dispatch.fleet });

  const ledger = new DispatchLedger(
    join(host.dataDirectory, "agent-dispatch.sqlite"),
  );

  const dispatcher = new AgentDispatcher({
    settings: {
      fleet: dispatch.fleet,
      pollIntervalMs: dispatch.pollIntervalSeconds * 1000,
      answerTimeoutMs: dispatch.answerTimeoutSeconds * 1000,
      retryLadderMs: dispatch.retryLadderSeconds.map(
        (seconds) => seconds * 1000,
      ),
      captainAccount: (name) => dispatch.captainAccounts[name] ?? name,
      enrolled: (account) =>
        enrolled.some((entry) => client.fold(entry) === client.fold(account)),
      sameAccount: (a, b) => client.fold(a) === client.fold(b),
    },
    api: new SubspaceApi({
      baseUrl: dispatch.api.baseUrl,
      tokenEnv: dispatch.api.tokenEnv,
      headersEnv: dispatch.api.headersEnv,
      ...(host.fetch && { fetch: host.fetch }),
      ...(host.env && { env: host.env }),
    }),
    messenger: new IrcDispatchMessenger(
      client,
      target.channel,
      host.allowed,
      log,
    ),
    ledger,
    log,
  });

  const listener: NonNullable<IrcShip["dispatchListener"]> = (
    message,
    caseFold,
  ) => {
    const answer = ircDispatchAnswer(
      message,
      target.channel,
      Date.now(),
      caseFold,
    );

    if (answer)
      void dispatcher.answer(answer).catch(() => {
        log.warn("Agent dispatch answer failed");
      });
  };

  ship.dispatchListener = listener;

  return {
    key: `${primary.key}:agent-dispatch`,
    log,
    run: (signal) => dispatcher.run(signal),
    close() {
      if (ship.dispatchListener === listener) ship.dispatchListener = undefined;
      ledger.close();
    },
  };
}
