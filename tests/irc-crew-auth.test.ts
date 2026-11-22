import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { configSchema, ircSchema } from "../src/config";
import { restartRequired } from "../src/app/config-reload";
import { checkCredentials } from "../src/app/setup";

const backend = {
  type: "opencode",
  directory: "/project",
  url: "http://localhost:4096",
};

const member = (id: string, auth: Record<string, unknown>) => ({
  id,
  account: `ship-${id}`,
  channels: ["#ship"],
  backend,
  ...auth,
});

const registration = (
  crew: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  id: "ship",
  server: { host: "localhost", port: 6697, tls: true },
  account: "ship-captain",
  passwordEnv: "CAPTAIN",
  channels: ["#ship"],
  backend,
  crew,
  ...extra,
});

const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("crew auth accepts mixed and multiple EXTERNAL members without password collisions", () => {
  const irc = registration([
    member("chief", { clientPemFile: "/private/chief.pem" }),
    member("apollo", { clientPemFile: "/private/apollo.pem" }),
    member("bosun", { passwordEnv: "BOSUN" }),
  ]);

  expect(
    Result.isSuccess(Schema.decodeUnknownResult(configSchema)({ irc: [irc] })),
  ).toBe(true);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...irc,
        passwordEnv: undefined,
        clientPemFile: "/private/captain.pem",
      }),
    ),
  ).toBe(true);
});

test("crew auth refuses missing, both, non-TLS and duplicate PLAIN references", () => {
  for (const auth of [
    {},
    { passwordEnv: "CHIEF", clientPemFile: "/private/chief.pem" },
  ])
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(ircSchema)(
          registration([member("chief", auth)]),
        ),
      ),
    ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)(
        registration(
          [member("chief", { clientPemFile: "/private/chief.pem" })],
          {
            server: { host: "127.0.0.1", port: 6667, tls: false },
          },
        ),
      ),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)(
        registration([member("chief", { passwordEnv: "CAPTAIN" })]),
      ),
    ),
  ).toBe(false);
  const first = registration([member("chief", { passwordEnv: "SHARED" })]);

  const second = registration(
    [member("other-chief", { passwordEnv: "SHARED" })],
    {
      id: "other",
      account: "other-captain",
      passwordEnv: "OTHER",
    },
  );

  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({ irc: [first, second] }),
    ),
  ).toBe(false);
});

test("crew PEM references are restart-only without changing session routing", () => {
  const before = Schema.decodeUnknownSync(configSchema)({
    irc: [
      registration([member("chief", { clientPemFile: "/private/chief.pem" })]),
    ],
  });

  const after = structuredClone(before);
  const chief = after.irc[0]?.crew[0];

  if (!chief) throw new Error("missing test member");
  chief.clientPemFile = "/private/rotated.pem";
  expect(
    restartRequired(
      { config: before, environment: {} },
      { config: after, environment: {} },
    ),
  ).toEqual(["irc[ship].crew[chief].clientPemFile"]);
});

test("credential checks validate crew PEMs without requiring an undefined password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stargate-crew-auth-"));
  cleanup.push(dir);
  const pem = join(dir, "unsafe.pem");
  await writeFile(pem, "not a certificate", { mode: 0o644 });

  const config = Schema.decodeUnknownSync(ircSchema)(
    registration([member("chief", { clientPemFile: pem })]),
  );

  await expect(
    checkCredentials(join(dir, "config.json"), [], { CAPTAIN: "synthetic" }, [
      config,
    ]),
  ).rejects.toThrow("IRC client PEM must be a private");
});
