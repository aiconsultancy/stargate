import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { crewOpenCodeInput } from "../src/crew/crew-tool-input";
import { crewInputSchema, crewOptionsSchema } from "../src/crew/engine";
import { canExpandCrew, crewFingerprint } from "../src/crew/identity";
import { modelInputSchema, modelToolInputSchema } from "../src/crew/models";
import { projectsSchema } from "../src/crew/project-options";
import { inspectInputSchema } from "../src/crew/reconciliation";
import { CrewState } from "../src/crew/state";
import { profileTeam, teamSchema } from "../src/crew/team";
import { workspaceInputSchemas } from "../src/crew/workspace";
import { renderProfile } from "../src/app/profile";
import { decodeSettings } from "../src/config/settings-errors";

const rawTeam = {
  captain: { id: "cain" },
  crew: [
    {
      id: "twiki",
      role: " Pi ",
      permissionProfile: "research",
      backend: { tools: "coding", model: "openai/fixture", type: "pi-durable" },
    },
    { id: "shaw", role: " Backend ", permissionProfile: "coding" },
  ],
};
const fingerprint =
  '{"version":2,"namespace":"fixture","projectDirectory":"/project","captain":{"id":"cain","directory":"/captain"},"crew":[{"id":"shaw","permissionProfile":"coding","directory":"/crew/shaw"},{"id":"twiki","permissionProfile":"research","directory":"/crew/twiki","backend":{"type":"pi-durable","model":"openai/fixture","systemPrompt":"You are a helpful assistant responding in Slack.","tools":"coding"}}]}';

test("crew containers compose native team and agent-ID validation and advertisement", () => {
  const options = {
    namespace: "fixture",
    stateDirectory: "/state",
    captainDirectory: "/captain",
    projectDirectory: "/project",
    mesijCommand: "/bin/mesij",
    worktrees: { shaw: "/crew/shaw", twiki: "/crew/twiki" },
    team: rawTeam,
  };
  expect(Schema.decodeUnknownSync(crewOptionsSchema)(options).team).toEqual(
    Schema.decodeUnknownSync(teamSchema)(rawTeam),
  );
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(crewOptionsSchema)({
        ...options,
        team: { ...rawTeam, crew: [] },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(projectsSchema)({
        other: {
          projectDirectory: "/other",
          worktrees: { "bad name": "/other/bad" },
        },
      }),
    ),
  ).toBe(false);
  for (const [schema, input] of [
    [crewInputSchema, { op: "dispatch", crew: "shaw", text: "fixture" }],
    [inspectInputSchema, { op: "inspect", crew: "shaw" }],
    [workspaceInputSchemas[0], { op: "workspace", crew: "shaw" }],
  ] as const) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(schema)(input))).toBe(
      true,
    );
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(schema)({ ...input, crew: "bad name" }),
      ),
    ).toBe(false);
  }
  expect(
    JSON.stringify(
      crewOpenCodeInput()["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      }),
    ),
  ).toContain('"pattern":"^[a-z0-9][a-z0-9_-]{0,63}$"');
});

test("crew decoding preserves legacy fingerprint bytes and persisted identity", async () => {
  const actual = crewFingerprint({
    namespace: "fixture",
    projectDirectory: "/project",
    captainDirectory: "/captain",
    worktrees: { shaw: "/crew/shaw", twiki: "/crew/twiki" },
    team: Schema.decodeUnknownSync(teamSchema)(rawTeam),
  });
  expect(actual).toBe(fingerprint);
  const directory = await mkdtemp(join(tmpdir(), "stargate-identity-schema-"));
  try {
    const before = await CrewState.open(directory, "fixture", fingerprint);
    before.close();
    const reopened = await CrewState.open(directory, "fixture", actual);
    reopened.close();
    await expect(
      CrewState.open(
        directory,
        "fixture",
        actual.replace("/crew/shaw", "/other/shaw"),
      ),
    ).rejects.toThrow("Crew configuration changed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("append-only identity compares raw member order and shallow record values", () => {
  const previous = JSON.parse(fingerprint) as {
    crew: Record<string, unknown>[];
  };
  const added = {
    id: "hoshi",
    permissionProfile: "research",
    directory: "/crew/hoshi",
  };
  const next = { ...previous, crew: [...previous.crew, added] };
  expect(canExpandCrew(fingerprint, JSON.stringify(next))).toBe(true);
  const first = previous.crew[0];
  if (!first) throw new Error("Missing identity fixture");
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  expect(
    canExpandCrew(
      fingerprint,
      JSON.stringify({ ...next, crew: [reordered, ...next.crew.slice(1)] }),
    ),
  ).toBe(false);
  const ownProto = JSON.parse(JSON.stringify(previous));
  Object.defineProperty(ownProto.crew[0], "__proto__", {
    enumerable: true,
    value: { ignored: true },
  });
  expect(canExpandCrew(JSON.stringify(ownProto), JSON.stringify(next))).toBe(
    true,
  );
  const nested = {
    ...first,
    metadata: JSON.parse('{"__proto__":{"kept":true},"constructor":1}'),
  };
  const beforeNested = {
    ...previous,
    crew: [nested, ...previous.crew.slice(1)],
  };
  const afterNested = { ...beforeNested, crew: [...beforeNested.crew, added] };
  expect(
    canExpandCrew(JSON.stringify(beforeNested), JSON.stringify(afterNested)),
  ).toBe(true);
  expect(canExpandCrew("invalid JSON", JSON.stringify(next))).toBe(false);
});

test("model native envelope preserves raw arguments, branch defaults and strictness", () => {
  const envelope = modelToolInputSchema["~standard"];
  const decode = (input: unknown) => {
    const result = envelope.validate(input);
    if (result instanceof Promise)
      throw new Error("Expected synchronous native model validation");
    if (result.issues)
      throw new Error(result.issues.map((issue) => issue.message).join("\n"));
    return result.value;
  };
  const json = envelope.jsonSchema.input({ target: "draft-2020-12" });
  // Captured through SDK 2.3.2's Standard Schema input contract at merged3e82863.
  expect(
    createHash("sha256")
      .update(JSON.stringify(json, null, 2) + "\n")
      .digest("hex"),
  ).toBe("055f96010b647acc4415dab1eb1f13ac46c5fb7a007e51aaab0eb72b300130fe");
  expect(json["type"]).toBe("object");
  expect(json["required"]).toEqual(["op"]);
  expect(json["additionalProperties"]).toBe(false);
  for (const keyword of ["anyOf", "oneOf", "allOf"])
    expect(json).not.toHaveProperty(keyword);
  for (const input of [
    { op: "get" },
    { op: "list" },
    { op: "switch", providerID: "fixture", id: "model" },
  ])
    expect(decode(input)).toEqual(input);
  expect(
    JSON.stringify(
      decode({
        op: "switch",
        target: "worker",
        providerID: "proxy",
        id: "model",
        variant: "high",
        compactFirst: true,
      }),
    ),
  ).toBe(
    '{"op":"switch","target":"worker","variant":"high","providerID":"proxy","id":"model","compactFirst":true}',
  );
  const defaults = Schema.decodeUnknownSync(modelInputSchema);
  expect(defaults({ op: "get" })).toEqual({ op: "get", target: "self" });
  expect(defaults({ op: "list" })).toEqual({ op: "list", target: "captain" });
  expect(
    defaults({ op: "switch", providerID: "fixture", id: "model" }),
  ).toEqual({
    op: "switch",
    target: "captain",
    providerID: "fixture",
    id: "model",
    compactFirst: false,
  });
  for (const input of [
    { op: "get", variant: "high" },
    { op: "inspect" },
    { op: "effort", target: "shaw", variant: "" },
    { op: "switch", providerID: "fixture", id: "model", extra: true },
    { op: "get", target: null },
  ])
    expect(() => decode(input)).toThrow();
  expect(
    defaults({ op: "effort", target: "shaw", variant: "𐐀".repeat(100) }).op,
  ).toBe("effort");
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(modelInputSchema)({
        op: "effort",
        target: "shaw",
        variant: "𐐀".repeat(101),
      }),
    ),
  ).toBe(true);
  const invalid = envelope.validate({ op: "inspect", project: "../bad" });
  if (invalid instanceof Promise)
    throw new Error("Expected synchronous native model validation");
  expect(invalid.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: ["project"] }),
      expect.objectContaining({ path: ["target"] }),
    ]),
  );
  const unknown = Schema.decodeUnknownResult(modelInputSchema)({
    op: "unknown",
  });
  if (Result.isSuccess(unknown))
    throw new Error("Unknown model operation accepted");
  expect(unknown.failure.message).toContain('["op"]');
});

test("profile rendering retains captured legacy JSON bytes after package-root normalization", async () => {
  const options = {
    directory: "/fixture/captain",
    projectDirectory: "/fixture/project",
    worktreeDirectory: "/fixture/crew",
    mesijCommand: "/fixture/bin/mesij",
  };
  const explicit = {
    ...options,
    namespace: "ship",
    team: Schema.decodeUnknownSync(teamSchema)({
      captain: { id: "captain" },
      toolAccess: "direct",
      crew: [
        {
          id: "worker",
          role: "Builder",
          permissionProfile: "coding",
          model: "proxy/model#high",
        },
      ],
    }),
  };
  for (const [input, role, hash] of [
    [
      options,
      "bowser",
      "190245240cae0f4e2030dbb1d7501664193d80f25f565cb7b7b72cd7180e9dc6",
    ],
    [
      explicit,
      "worker",
      "699d2f4a549a2b3780310495b4a74664a40e9219d54a3fad577bd03d59cf5646",
    ],
  ] as const) {
    const config = await renderProfile(input, role);
    const bytes = JSON.stringify(config, null, 2) + "\n";
    const normalized = bytes
      .split(join(import.meta.dir, "..") + "/")
      .join("@PACKAGE_ROOT@/");
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(hash);
  }
});

test("team diagnostics retain dependent custom paths and profile errors stay safe", async () => {
  const invalid = {
    ...rawTeam,
    crew: [
      { id: "shaw", name: "Other", role: "", permissionProfile: "coding" },
    ],
  };
  expect(() => decodeSettings(teamSchema, invalid)).toThrow(
    "Agent IDs must match assigned names",
  );
  expect(() => decodeSettings(teamSchema, invalid)).toThrow('["crew",0,"id"]');
  expect(() =>
    profileTeam(Schema.decodeUnknownSync(teamSchema)(rawTeam), "x".repeat(64)),
  ).toThrow();
  const options = {
    directory: "/captain",
    projectDirectory: "/project",
    worktreeDirectory: "/crew",
    mesijCommand: "/bin/mesij",
  };
  await expect(
    renderProfile(
      {
        ...options,
        proxyURL: "https://user:SENSITIVE_PROFILE_VALUE@example.test",
      },
      "bowser",
    ),
  ).rejects.toThrow("Proxy URL must be HTTP(S), without credentials.");
  await expect(
    renderProfile(
      { ...options, apiKeyReference: "SENSITIVE_PROFILE_VALUE" },
      "bowser",
    ),
  ).rejects.toThrow(
    "Invalid profile paths, team, namespace, proxy URL, or credential reference.",
  );
});
