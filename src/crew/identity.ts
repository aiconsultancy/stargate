import { z } from "zod";

const identitySchema = z.strictObject({
  version: z.literal(2),
  namespace: z.string(),
  projectDirectory: z.string(),
  captain: z.strictObject({ id: z.string(), directory: z.string() }),
  crew: z.array(z.record(z.string(), z.unknown())),
});

/** Explicit append-only rollout; existing workers can never be rebound. */
export function canExpandCrew(previous: string, next: string): boolean {
  try {
    const before = identitySchema.parse(JSON.parse(previous));
    const after = identitySchema.parse(JSON.parse(next));
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
