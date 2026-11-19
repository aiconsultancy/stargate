import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { crewPermissions } from "../src/crew/policy";
import { defaultTeam, type Team, teamSchema } from "../src/crew/team";

const team = {
  captain: { id: "galactica-captain", name: "Galactica Captain" },
  crew: [
    {
      id: "starbuck",
      role: "Implementation",
      permissionProfile: "coding",
      model: "openai-proxy/gpt-6.1-sol#high",
    },
    { id: "roslin", role: "Research", permissionProfile: "research" },
  ],
} satisfies Team;

test("team configuration supports named captains and non-default rosters", () => {
  expect(Schema.decodeUnknownSync(teamSchema)(team)).toEqual(team);
  expect(defaultTeam.captain.id).toBe("bowser");
  expect(defaultTeam.crew.map((member) => member.id)).toEqual([
    "mario",
    "luigi",
    "daisy",
    "toad",
  ]);
});

test("team configuration rejects ambiguous identities and implicit tool access", () => {
  for (const crew of [
    [],
    [team.crew[0], team.crew[0]],
    [{ ...team.crew[0], id: "galactica-captain" }],
    [{ ...team.crew[0], id: "captain" }],
    [{ ...team.crew[0], id: "../escape" }],
    [{ id: "reader", role: "Research" }],
    [{ ...team.crew[0], permissionProfile: "everything" }],
    [{ ...team.crew[0], model: "missing-provider" }],
  ]) {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(teamSchema)({ ...team, crew }),
      ),
    ).toBe(false);
  }
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(teamSchema)({ ...team, unknown: true }),
    ),
  ).toBe(false);
});

test("specialisms share broad tools without granting captain model controls", () => {
  const research = crewPermissions("research");
  const coding = crewPermissions("coding");
  for (const action of ["shell", "edit", "execute", "browser"]) {
    expect(research).toContainEqual({
      action,
      resource: "*",
      effect: "allow",
    });
    expect(coding).toContainEqual({ action, resource: "*", effect: "allow" });
  }
  expect(research).toContainEqual({
    action: "linear_*",
    resource: "*",
    effect: "allow",
  });
  expect(research).toContainEqual({
    action: "stargate_history",
    resource: "*",
    effect: "allow",
  });
  expect(research).not.toContainEqual({
    action: "stargate_model",
    resource: "*",
    effect: "allow",
  });
  expect(crewPermissions("captain")).toContainEqual({
    action: "stargate_model",
    resource: "*",
    effect: "allow",
  });
});

test("history endpoints require safe transport and environment references", () => {
  for (const historyAPI of [
    { url: "http://remote.example" },
    { url: "https://user:secret@example.com" },
    { url: "https://example.com?token=secret" },
    { url: "https://example.com#secret" },
    {
      url: "https://example.com",
      headersEnv: { authorization: "Bearer secret" },
    },
  ])
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(teamSchema)({ ...team, historyAPI }),
      ),
    ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(teamSchema)({
        ...team,
        historyAPI: {
          url: "http://127.0.0.1:4096",
          headersEnv: { authorization: "OPENCODE_AUTHORIZATION" },
        },
      }),
    ),
  ).toBe(true);
});

test("a Pi research specialism does not restrict explicitly enabled host tools", () => {
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(teamSchema)({
        ...team,
        crew: [
          {
            id: "researcher",
            role: "Research",
            permissionProfile: "research",
            backend: {
              type: "pi-durable",
              model: "openai/opencode-go/deepseek-v4.1-flash",
              tools: "coding",
            },
          },
        ],
      }),
    ),
  ).toBe(true);
});
