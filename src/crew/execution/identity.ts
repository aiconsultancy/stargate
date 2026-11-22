import { resolve } from "node:path";
import { Schema } from "effect";
import { settingsRecord, settingsStruct } from "../../config/settings-schema";
import type { Team } from "../team";

/** Shared with the explicit cutover planner; JSON ordering is persistent identity. */
export function crewFingerprint(options: {
  namespace: string;
  projectDirectory: string;
  captainDirectory: string;
  worktrees: Record<string, string>;
  team: Team;
}) {
  return JSON.stringify({
    version: 2,
    namespace: options.namespace,
    projectDirectory: resolve(options.projectDirectory),
    captain: {
      id: options.team.captain.id,
      directory: resolve(options.captainDirectory),
    },
    crew: options.team.crew
      .map(({ id, permissionProfile, backend }) => ({
        id,
        permissionProfile,
        directory: resolve(options.worktrees[id] ?? ""),
        ...(backend ? { backend } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

const identitySchema = settingsStruct({
  version: Schema.Literal(2),
  namespace: Schema.String,
  projectDirectory: Schema.String,
  captain: settingsStruct({ id: Schema.String, directory: Schema.String }),
  crew: Schema.mutable(
    Schema.Array(settingsRecord(Schema.String, Schema.Unknown)),
  ),
});

/** Explicit append-only rollout; existing workers can never be rebound. */
export function canExpandCrew(previous: string, next: string): boolean {
  try {
    const before = Schema.decodeUnknownSync(identitySchema)(
      JSON.parse(previous),
    );
    const after = Schema.decodeUnknownSync(identitySchema)(JSON.parse(next));
    if (
      before.namespace !== after.namespace ||
      before.projectDirectory !== after.projectDirectory ||
      JSON.stringify(before.captain) !== JSON.stringify(after.captain) ||
      before.crew.length >= after.crew.length
    )
      return false;
    if (
      !before.crew.every((old) =>
        after.crew.some(
          (member) => JSON.stringify(old) === JSON.stringify(member),
        ),
      )
    )
      return false;
    const added = after.crew.filter(
      (member) => !before.crew.some((old) => old["id"] === member["id"]),
    );
    return (
      added.length > 0 &&
      added.every((member) => {
        const backend = member["backend"];
        if (backend === undefined) return true;
        return (
          typeof backend === "object" &&
          backend !== null &&
          "type" in backend &&
          backend.type === "pi-durable"
        );
      })
    );
  } catch {
    return false;
  }
}
