import { join } from "node:path";
import type { Logger } from "pino";
import {
  type AgentDispatchConfig,
  type IrcConfig,
  agentDispatchTarget,
} from "../../../config";
import { agentDispatchActive } from "../../../config/composition";
import type { IrcShip } from "../../../transports/irc/ship";
import { SubspaceApi } from "./api";
import { AssignedWork } from "./assigned-work";
import { AgentDispatcher } from "./dispatcher";
import {
  IrcAssignmentRequests,
  IrcDispatchMessenger,
  assignmentCapacityTag,
  ircDispatchAnswer,
} from "./irc";
import { DispatchLedger } from "./ledger";
import type { AssignedWorkPoller } from "./polling";

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

const disabledAssignedWork: AssignedWorkPoller = {
  start() {},
  drain() {},
};

/**
 * Agent dispatch for this configuration, or undefined when the section is
 * absent or both features are off. Off means nothing is opened, listened to or
 * contacted: no ledger file, no chat listener and no API request.
 */
export function startAgentDispatch(
  host: AgentDispatchHost,
): AgentDispatchRuntime | undefined {
  const dispatch = host.config;

  if (!agentDispatchActive(dispatch)) {
    return;
  }

  const target = agentDispatchTarget(dispatch, host.irc);

  if (typeof target === "string") {
    throw new Error(target);
  }

  const ship = host.ship(target.registration.id);
  const primary = ship?.registrations[0];

  if (!ship || !primary) {
    throw new Error("Agent dispatch registration unavailable");
  }

  const client = primary.client;
  const enrolled = target.registration.fleetPolicy?.agentAccounts ?? [];
  const log = host.log.child({ agentDispatch: dispatch.fleet });

  const ledger = new DispatchLedger(
    join(host.dataDirectory, "agent-dispatch.sqlite"),
  );

  const api = new SubspaceApi({
    ...dispatch.api,
    ...(host.fetch && { fetch: host.fetch }),
    ...(host.env && { env: host.env }),
  });

  const requestConfig = dispatch.assignmentRequests;
  const offersEnabled = dispatch.enabled && dispatch.readyOffers !== false;

  const messenger = new IrcDispatchMessenger(
    client,
    target.channel,
    host.allowed,
    log,
  );

  let assignmentRequests: IrcAssignmentRequests | undefined;
  let assignedWork: AssignedWorkPoller | undefined;

  if (requestConfig === null) {
    assignedWork = disabledAssignedWork;
  } else if (dispatch.enabled && requestConfig) {
    assignmentRequests = new IrcAssignmentRequests(
      client,
      requestConfig.shipChannels,
      host.allowed,
      messenger,
    );
    assignedWork = new AssignedWork({
      api,
      ledger,
      requests: assignmentRequests,
      log,
      reminderMs: requestConfig.reminderSeconds * 1000,
      captainIntervalMs: 5 * 60 * 1000,
      offersEnabled,
    });
  }

  const dispatcher = new AgentDispatcher({
    settings: {
      fleet: dispatch.fleet,
      pollIntervalMs: dispatch.pollIntervalSeconds * 1000,
      answerTimeoutMs: dispatch.answerTimeoutSeconds * 1000,
      decisionOutcomeDms: dispatch.decisionOutcomeDms ?? false,
      issueDispatch: dispatch.enabled,
      offersEnabled,
      recheckIdentity: api.usesEnrolledIdentity,
      retryLadderMs: dispatch.retryLadderSeconds.map(
        (seconds) => seconds * 1000,
      ),
      captainAccount: (name) => dispatch.captainAccounts[name] ?? name,
      enrolled: (account) =>
        enrolled.some((entry) => client.fold(entry) === client.fold(account)),
      sameAccount: (a, b) => client.fold(a) === client.fold(b),
    },
    api,
    ...(assignedWork !== undefined && { assignedWork }),
    messenger,
    ledger,
    log,
  });

  const listener: NonNullable<IrcShip["dispatchListener"]> = (
    message,
    caseFold,
  ) => {
    if (message.tags.has(assignmentCapacityTag)) {
      assignmentRequests?.receive(message);

      return;
    }

    if (!offersEnabled) {
      return;
    }

    const answer = ircDispatchAnswer(
      message,
      target.channel,
      Date.now(),
      caseFold,
    );

    if (answer) {
      void dispatcher.answer(answer).catch(() => {
        log.warn("Agent dispatch answer failed");
      });
    }
  };

  if (assignmentRequests || offersEnabled) {
    ship.dispatchListener = listener;
  }

  return {
    key: `${primary.key}:agent-dispatch`,
    log,
    run: (signal) => dispatcher.run(signal),
    close() {
      if (ship.dispatchListener === listener) {
        ship.dispatchListener = undefined;
      }

      ledger.close();
    },
  };
}
