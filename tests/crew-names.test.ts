import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  CrewEngine,
  type CrewOptions,
  type CrewSessions,
} from "../src/coordination/crew/execution/engine";
import { crewFingerprint } from "../src/coordination/crew/execution/identity";
import { teamSchema } from "../src/coordination/crew/team";
import { dashboardCrewMembers } from "../src/observability/dashboard/dashboard-projection";
import { fixtureRoot } from "./fixture-root";

const forbidden = async (): Promise<never> => {
  throw new Error("Naming must not call an agent API");
};

const sessions: CrewSessions = {
  get: forbidden,
  create: forbidden,
  prompt: forbidden,
  wait: forbidden,
  interrupt: forbidden,
  synthetic: forbidden,
  compact: forbidden,
};

function options(directory: string, chief: object, ids = ["chief", "gaeta"]) {
  const team = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "adama" },
    crew: [
      { ...chief, role: "Engineering", permissionProfile: "coding" },
      { id: "gaeta", role: "Research", permissionProfile: "research" },
    ],
  });

  return {
    namespace: "names",
    stateDirectory: directory,
    projectDirectory: directory,
    captainDirectory: join(directory, "captain"),
    team,
    worktrees: Object.fromEntries(ids.map((id) => [id, join(directory, id)])),
    mesijCommand: "/usr/bin/mesij",
  } satisfies CrewOptions;
}

const open = (input: CrewOptions) =>
  CrewEngine.open(input, sessions, undefined, undefined, forbidden);

function durable(path: string) {
  const db = new Database(path, { readonly: true });

  try {
    return JSON.stringify(
      ["identity", "peers", "tasks"].map((table) =>
        db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    );
  } finally {
    db.close();
  }
}

test("naming a crew member apart from its ID keeps the ID's state", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-crew-names-"));

  try {
    const unnamed = options(directory, { id: "chief" });
    const named = options(directory, { id: "chief", name: "Kestrel" });

    // The name is not part of the persistent identity, so state opens as is.
    expect(crewFingerprint(named)).toBe(crewFingerprint(unnamed));
    expect(crewFingerprint(named)).not.toContain("Kestrel");

    const before = await open(unnamed);
    const peer = before.state.reservePeer("chief");
    const task = before.state.reserveTask(peer, "captain", "Review the change");
    const path = before.state.path;
    expect(before.status().members[0]).toMatchObject({
      id: "chief",
      name: "chief",
    });
    await before.close();
    const saved = durable(path);

    const after = await open(named);

    try {
      expect(after.state.path).toBe(path);
      expect(after.state.peer("chief")?.sessionID).toBe(peer.sessionID);
      expect(after.state.activeTask("chief")?.id).toBe(task?.id);
      expect(durable(path)).toBe(saved);

      // People see the name; the ID stays beside it for everything keyed on it.
      const status = after.status();
      expect(status.members.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: "chief", name: "Kestrel" },
        { id: "gaeta", name: "gaeta" },
      ]);
      expect(after.status({ member: "chief" }).members[0]?.name).toBe(
        "Kestrel",
      );
      expect(
        dashboardCrewMembers(status).map(({ id, name }) => ({ id, name })),
      ).toEqual([
        { id: "chief", name: "Kestrel" },
        { id: "gaeta", name: "gaeta" },
      ]);
      expect(after.roster()).toContainEqual(
        expect.objectContaining({
          id: "chief",
          name: "Kestrel",
          role: "Engineering",
        }),
      );

      const capture = after.state.reporting.start("captain", "request", "");

      for (const member of ["chief", "gaeta"]) {
        after.state.reporting.journal.append(
          {
            member,
            captainID: "captain",
            taskID: null,
            kind: "update",
            text: `${member} checked`,
          },
          `update-${member}`,
        );
      }

      expect(
        after.state.reporting
          .entries(capture.id)
          .map(({ member, text }) => ({ member, text })),
      ).toEqual([
        { member: "Kestrel", text: "chief checked" },
        { member: "gaeta", text: "gaeta checked" },
      ]);
    } finally {
      await after.close();
    }

    // Changing the ID itself is a different member and stays refused.
    await expect(
      open(options(directory, { id: "kestrel" }, ["kestrel", "gaeta"])),
    ).rejects.toThrow("Crew configuration changed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
