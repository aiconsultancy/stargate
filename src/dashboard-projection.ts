import type { CrewStatus } from "./crew-status";
import type { DashboardCrewMember, ShipSummary } from "./dashboard-model";

/** A person can have independent task state in several repository contexts. */
export function dashboardCrewMembers(
  status: CrewStatus,
): DashboardCrewMember[] {
  const people = new Map<string, DashboardCrewMember>();
  for (const context of status.members) {
    let person = people.get(context.id);
    if (!person) {
      person = { id: context.id, name: context.name, contexts: [] };
      people.set(context.id, person);
    }
    person.contexts.push(context);
  }
  return [...people.values()];
}

/** Keep the legacy context aggregates; people counts are an additive view. */
export function dashboardCrewSummary(
  status: CrewStatus,
): NonNullable<ShipSummary["crew"]> {
  const people = dashboardCrewMembers(status);
  return {
    total: status.total,
    busy:
      status.busy ?? status.members.filter((member) => member.current).length,
    ...(status.busy === undefined && status.truncated
      ? { busyPartial: true as const }
      : {}),
    people: {
      total: people.length,
      busy: people.filter((person) =>
        person.contexts.some((context) => context.current),
      ).length,
      ...(status.truncated ? { partial: true as const } : {}),
    },
  };
}
