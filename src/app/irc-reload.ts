import type { AgentBackend } from "../backends/backend";
import type { IrcConfig } from "../config";
import type { Gateway } from "../gateway/gateway";
import type { ircDashboardShip } from "../observability/dashboard/dashboard-source";
import { createTranscriber } from "../transcription/startup";
import type {
  IrcRegistration,
  IrcReload,
  IrcShip,
} from "../transports/irc/ship";
import { ReloadRejected } from "./config-reload";

export type IrcRuntimeRegistration = {
  registration: IrcRegistration;
  gateway: Gateway;
  resource: { backend: AgentBackend; close: () => Promise<void> };
  dashboard: ReturnType<typeof ircDashboardShip>;
};

export type IrcBinding = {
  ship: IrcShip;
  entries: Map<string, IrcRuntimeRegistration>;
};

type RosterPlan = {
  binding: IrcBinding;
  plan: IrcReload;
  next: IrcConfig;
  transcriber: ReturnType<typeof createTranscriber> | undefined;
  staged: Map<IrcRegistration, IrcRuntimeRegistration>;
};

/** Prepare ships and stage new workers without publishing the candidate. */
export async function prepareIrcRoster(
  ships: readonly IrcConfig[],
  environment: NodeJS.ProcessEnv,
  bindings: ReadonlyMap<string, IrcBinding>,
  stage: (
    registration: IrcRegistration,
    next: IrcConfig,
  ) => Promise<IrcRuntimeRegistration>,
) {
  const plans: RosterPlan[] = [];

  for (const next of ships) {
    const binding = bindings.get(next.id);

    if (!binding) throw new ReloadRejected("unavailable");
    const plan = await binding.ship.prepareReload(next, environment);
    const staged = new Map<IrcRegistration, IrcRuntimeRegistration>();

    for (const registration of plan.added)
      staged.set(registration, await stage(registration, next));

    plans.push({
      binding,
      plan,
      next,
      transcriber: next.transcription
        ? createTranscriber(next.transcription)
        : undefined,
      staged,
    });
  }

  return plans;
}

/** Resolve every surviving entry and namespace before the synchronous commit. */
export function resolveIrcRosterUpdates(plans: readonly RosterPlan[]) {
  return plans.flatMap(({ binding, plan, transcriber, next, staged }) => {
    const removed = new Set(plan.removed);

    const registrations = [
      ...binding.ship.registrations.filter(
        (registration) => !removed.has(registration),
      ),
      ...plan.added,
    ];

    return registrations.map((registration) => {
      const entry =
        staged.get(registration) ?? binding.entries.get(registration.key);

      if (!entry || entry.gateway.key !== registration.transport.key)
        throw new ReloadRejected("unavailable");

      return { binding, registration, entry, transcriber, next };
    });
  });
}
