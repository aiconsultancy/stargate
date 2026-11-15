import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { piMemberDefinition } from "../src/crew/instructions";

test("OpenCode and Pi crew definitions include the two short coordination rules", async () => {
  const template = await readFile(
    new URL("../templates/agents/crew.md", import.meta.url),
    "utf8",
  );
  const pi = piMemberDefinition(
    { id: "chief", role: "Engineer", permissionProfile: "coding" },
    "/work/chief",
    "/work/captain",
  );
  for (const text of [template, pi]) {
    expect(text).toContain(
      "Child agents use their own standard tools, never Stargate tools or prefixed names; do not nest children.",
    );
    expect(text).toContain(
      "Reply on IRC only when tagged, asked directly, or once per all-call.",
    );
  }
});
