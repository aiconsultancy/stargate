import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { CrewCaller } from "./engine";
import type { CrewProjects } from "./projects";
import { CrewError } from "./state";

/** Normal crew tool entry: a grant intersects native permission, never replaces
 * it. The same native check runs again before delegated data is returned. */
export async function protectedCrewTool(
  projects: CrewProjects,
  input: unknown,
  caller: CrewCaller,
  permission: (resource: string) => Promise<void>,
) {
  try {
    await permission(
      typeof input === "object" && input !== null && "op" in input
        ? String(input.op)
        : "inspection",
    );
  } catch (error) {
    projects.inspectionDenied(
      input,
      caller,
      caller.signal.aborted ? "cancelled" : "native-denied",
    );
    throw error;
  }
  try {
    return {
      content: JSON.stringify(
        await projects.run(input, {
          ...caller,
          inspectionPermission: permission,
        }),
      ),
    };
  } catch (error) {
    throw new ToolError({
      message:
        error instanceof CrewError
          ? error.message
          : "Crew operation failed; raw details withheld.",
    });
  }
}
