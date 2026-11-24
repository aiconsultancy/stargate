import { afterEach, expect, test } from "bun:test";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { configSchema } from "../src/config";
import { decodeSettings } from "../src/config/settings-errors";
import { checkCredentials } from "../src/app/setup";
import { restartRequired } from "../src/app/config-reload";
import { runCli } from "../src/app/cli";
import {
  bundleText,
  generateAgentKey,
  parseBundle,
} from "../src/subspace/certificate";
import { enrolOfficers } from "../src/subspace/enrol";
import { mintAgentToken } from "../src/subspace/token";
import { clientPem } from "../src/transports/irc/client-pem";
import example from "../stargate.example.json";
import {
  ENROLMENT_TOKEN,
  StubApi,
  captain,
  childDirectory,
  enrolled,
  privateDirectory,
  removeDirectories,
  section,
  verifyAgentToken,
} from "./subspace-fixture";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }

  await removeDirectories();
});

function api() {
  const stub = new StubApi();
  cleanup.push(() => stub.stop());

  return stub;
}

const env = { SUBSPACE_ENROLMENT: ENROLMENT_TOKEN };

const ircCaptain = (id: string, backend: Record<string, unknown>) => ({
  id,
  server: { host: "127.0.0.1", port: 6667, tls: false },
  account: id,
  passwordEnv: `IRC_${id.toUpperCase().replaceAll("-", "_")}`,
  channels: ["#example"],
  access: { allowedAccounts: ["example-human"] },
  backend,
});

const claudeBackend = (more: Record<string, unknown> = {}) => ({
  type: "claude",
  directory: "/workspace",
  model: "claude-example",
  provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv: "PROXY_KEY" },
  ...more,
});

const enabledRaw = (more: Record<string, unknown> = {}) => ({
  enabled: true,
  api: { baseUrl: "https://subspace.example.test" },
  officers: [captain("example-captain")] as Record<string, unknown>[],
  ...more,
});

function decodeConfig(raw: Record<string, unknown>) {
  return decodeSettings(configSchema, { ...example, ...raw });
}

function refusal(raw: Record<string, unknown>) {
  try {
    decodeConfig(raw);
  } catch (error) {
    return String(error);
  }

  return "accepted";
}

test("configuration: absent by default; switched off is the same as absent, unvalidated", () => {
  const { subspaceAgents: _shown, ...withoutSection } = example;

  expect(
    decodeSettings(configSchema, withoutSection).subspaceAgents,
  ).toBeUndefined();

  const { enabled: _enabled, ...withoutEnabled } = enabledRaw();

  // The example shows the section switched off; it decodes as no section.
  for (const section of [
    undefined,
    example.subspaceAgents,
    { enabled: false },
    withoutEnabled,
    { enabled: false, api: "not checked", officers: 7, unknown: true },
  ]) {
    expect(decodeConfig({ subspaceAgents: section }).subspaceAgents).toBe(
      undefined,
    );
  }

  // An enabled section is validated in full, with its defaults.
  const decoded: unknown = decodeConfig({
    subspaceAgents: enabledRaw(),
  }).subspaceAgents;

  expect(decoded).toEqual({
    enabled: true,
    api: {
      baseUrl: "https://subspace.example.test",
      headersEnv: {},
      timeoutSeconds: 60,
    },
    keyAlgorithm: "ed25519",
    officers: [captain("example-captain")],
  });

  for (const section of [
    { enabled: "yes" },
    { enabled: true },
    enabledRaw({ unknown: true }),
    "on",
  ]) {
    expect(refusal({ subspaceAgents: section })).not.toBe("accepted");
  }
});

test("reload: adding, changing or removing a switched-off section needs no restart", () => {
  const candidate = (subspaceAgents?: unknown) => ({
    config: decodeConfig({ subspaceAgents }),
    environment: {},
  });

  const off = { ...enabledRaw(), enabled: false };

  expect(restartRequired(candidate(), candidate({ enabled: false }))).toEqual(
    [],
  );
  expect(restartRequired(candidate(), candidate(off))).toEqual([]);
  expect(
    restartRequired(candidate(off), candidate({ enabled: false })),
  ).toEqual([]);
  expect(restartRequired(candidate(off), candidate())).toEqual([]);
  // Switching it on is a restart, as for any enabled section.
  expect(restartRequired(candidate(off), candidate(enabledRaw()))).toEqual([
    "subspaceAgents",
  ]);
});

test("configuration: a disabled section is not cross-checked; an enabled one is", () => {
  const officers = [captain("example-captain", { registration: "missing" })];

  expect(
    refusal({
      subspaceAgents: { ...enabledRaw({ officers }), enabled: false },
    }),
  ).toBe("accepted");
  expect(refusal({ subspaceAgents: enabledRaw({ officers }) })).toContain(
    "Name a Slack, IRC or Teams registration",
  );

  const irc = [ircCaptain("example-captain", claudeBackend())];

  expect(
    refusal({
      irc,
      subspaceAgents: enabledRaw({
        officers: [
          captain("example-captain", { registration: "example-captain" }),
        ],
      }),
    }),
  ).toContain("A Claude officer needs socketPath for its MCP bridge");

  expect(
    refusal({
      irc: [
        ircCaptain(
          "example-captain",
          claudeBackend({
            mcpServers: {
              subspace: { type: "stdio", command: "/usr/local/bin/example" },
            },
          }),
        ),
      ],
      subspaceAgents: enabledRaw({
        officers: [
          captain("example-captain", {
            registration: "example-captain",
            socketPath: "/run/stargate/subspace/example-captain/api.sock",
          }),
        ],
      }),
    }),
  ).toContain("Remove the registration's own subspace MCP server");

  for (const [officers, message] of [
    [
      [captain("example-a"), captain("EXAMPLE-A")],
      "Officer names must be unique",
    ],
    [
      [
        captain("example-a", { socketPath: "/run/example/shared/a.sock" }),
        captain("example-b", { socketPath: "/run/example/shared/b.sock" }),
      ],
      "Each officer's socketPath needs its own directory",
    ],
    [
      [
        captain("example-a", { bundlePath: "/srv/keys/one.pem" }),
        captain("example-b", { bundlePath: "/srv/keys/one.pem" }),
      ],
      "Each officer needs its own bundlePath",
    ],
  ] as const) {
    expect(refusal({ subspaceAgents: enabledRaw({ officers }) })).toContain(
      message,
    );
  }
});

test("configuration: officer fields, headers and the enrolment source are bounded", () => {
  for (const raw of [
    enabledRaw({
      officers: [{ ...captain("example-captain"), ship: undefined }],
    }),
    enabledRaw({
      officers: [{ ...captain("example-admiral"), rank: "rearAdmiral" }],
    }),
    enabledRaw({ officers: [captain("../escape")] }),
    enabledRaw({
      officers: [captain("example-captain", { socketPath: "relative.sock" })],
    }),
    enabledRaw({
      officers: [captain("example-captain", { bundlePath: "/srv/../x.pem" })],
    }),
    enabledRaw({ officers: [] }),
    enabledRaw({ api: { baseUrl: "http://subspace.example.test" } }),
    // Routes are /api/v1/ and /mcp on the origin; a path is refused.
    enabledRaw({ api: { baseUrl: "https://subspace.example.test/api" } }),
    enabledRaw({ api: { baseUrl: "https://subspace.example.test/x/" } }),
    enabledRaw({
      api: {
        baseUrl: "https://subspace.example.test",
        audience: "https://subspace.example.test/api",
      },
    }),
    ...["Authorization", "Cookie", "X-Subspace-Agent", "Origin"].map((name) =>
      enabledRaw({
        api: {
          baseUrl: "https://subspace.example.test",
          headersEnv: { [name]: "EXAMPLE_VALUE" },
        },
      }),
    ),
    enabledRaw({ enrolment: {} }),
    enabledRaw({
      enrolment: { tokenEnv: "EXAMPLE_TOKEN", tokenFile: "/etc/example/token" },
    }),
  ]) {
    expect(refusal({ subspaceAgents: raw })).not.toBe("accepted");
  }

  expect(
    refusal({
      subspaceAgents: enabledRaw({
        officers: [
          {
            name: "example-admiral",
            rank: "rearAdmiral",
            model: "example-model",
          },
        ],
        enrolment: { tokenFile: "/etc/example/enrolment-token" },
        api: {
          baseUrl: "http://127.0.0.1:3000/",
          audience: "https://subspace.example.test",
          headersEnv: { "CF-Access-Client-Id": "EXAMPLE_ACCESS_ID" },
        },
      }),
    }),
  ).toBe("accepted");
});

test("credential check: enabled sections need their header variables; others need none", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "stargate.json");

  const headers = {
    baseUrl: "https://subspace.example.test",
    headersEnv: { "CF-Access-Client-Id": "EXAMPLE_ACCESS_ID" },
  };

  const enabled = decodeConfig({
    subspaceAgents: enabledRaw({ api: headers }),
  }).subspaceAgents;

  const disabled = decodeConfig({
    subspaceAgents: { ...enabledRaw({ api: headers }), enabled: false },
  }).subspaceAgents;

  const check = (
    section: typeof enabled,
    environment: NodeJS.ProcessEnv = {},
  ) =>
    checkCredentials(
      path,
      [],
      environment,
      [],
      undefined,
      directory,
      undefined,
      section,
    );

  await check(undefined);
  await check(disabled);
  await expect(check(enabled)).rejects.toThrow(
    "Missing Subspace agent API environment reference",
  );
  await check(enabled, { EXAMPLE_ACCESS_ID: "example-value" });
});

test("keys: Ed25519 and P-256 certificates verify, name the officer and are client certificates", () => {
  for (const algorithm of ["ed25519", "ecdsa-p256"] as const) {
    const key = generateAgentKey("example-captain", algorithm);
    const certificate = new X509Certificate(key.certificate);

    expect(certificate.subject).toBe("CN=example-captain");
    expect(certificate.issuer).toBe("CN=example-captain");
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.checkPrivateKey(key.privateKey)).toBe(true);
    expect(certificate.ca).toBe(false);
    expect(certificate.keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]);
    // The contract: SHA-256 of the DER, lower-case hex, no separators.
    expect(key.fingerprint).toBe(
      createHash("sha256").update(certificate.raw).digest("hex"),
    );
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(certificate.validFrom).getTime()).toBeLessThan(Date.now());

    const parsed = parseBundle(bundleText(key));

    expect(parsed.fingerprint).toBe(key.fingerprint);
    expect(parsed.algorithm).toBe(algorithm);
  }

  // Dates from 2050 use GeneralizedTime.
  const late = generateAgentKey(
    "example-captain",
    "ed25519",
    new Date("2045-06-01"),
  );

  expect(new X509Certificate(late.certificate).validTo).toContain("2055");
  expect(() => parseBundle(generateAgentKey("x").certificate)).toThrow(
    "one private key",
  );
  expect(() =>
    parseBundle(
      `${bundleText(generateAgentKey("x")).split("-----BEGIN CERTIFICATE")[0]}${generateAgentKey("y").certificate}`,
    ),
  ).toThrow("does not match");
});

test("agent token: header and claims per the contract, verified with the certificate", async () => {
  for (const algorithm of ["ed25519", "ecdsa-p256"] as const) {
    const key = generateAgentKey("example-captain", algorithm);
    const audience = "https://subspace.example.test";
    const first = mintAgentToken(key, audience);
    const second = mintAgentToken(key, audience);

    const { payload, protectedHeader } = await verifyAgentToken(
      first,
      key.certificate,
      audience,
    );

    expect(protectedHeader).toEqual({
      alg: algorithm === "ed25519" ? "EdDSA" : "ES256",
      typ: "subspace-agent+jwt",
      kid: key.fingerprint,
    });
    expect(payload.sub).toBe(key.fingerprint);
    expect(payload.aud).toBe(audience);
    expect(payload.iss).toBe("subspace-agent");
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeGreaterThan(0);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(300);
    expect(Math.abs((payload.iat ?? 0) - Date.now() / 1000)).toBeLessThan(5);
    expect(typeof payload.jti).toBe("string");
    expect(decodeJwt(second).jti).not.toBe(payload.jti);
    // Another officer's certificate does not verify it.
    await expect(
      verifyAgentToken(
        first,
        generateAgentKey("other", algorithm).certificate,
        audience,
      ),
    ).rejects.toThrow();
    await expect(
      verifyAgentToken(first, key.certificate, "https://other.example.test"),
    ).rejects.toThrow();
  }

  expect(
    decodeProtectedHeader(
      mintAgentToken(generateAgentKey("x"), "https://a.example"),
    ).alg,
  ).toBe("EdDSA");
});

test("enrolment: a private bundle and record, the contract's request, then nothing on a re-run", async () => {
  const stub = api();
  stub.handler = (recorded) => enrolled(recorded);
  const dataDirectory = await privateDirectory();

  const config = section(stub.url, [
    captain("example-captain"),
    { name: "example-admiral", rank: "rearAdmiral", model: "example-model" },
  ]);

  const first = await enrolOfficers({ section: config, dataDirectory, env });
  const state = join(dataDirectory, "subspace-agents");

  expect(((await stat(state)).mode & 0o777).toString(8)).toBe("700");
  expect(first.map((outcome) => outcome.state)).toEqual([
    "enrolled",
    "enrolled",
  ]);
  expect(stub.requests).toHaveLength(2);

  const [request] = stub.requests;
  const bundle = join(state, "example-captain.pem");
  const key = parseBundle(await readFile(bundle, "utf8"));

  expect(request?.method).toBe("POST");
  expect(request?.path).toBe("/api/v1/agents/enrol");
  expect(request?.headers["authorization"]).toBe(`Bearer ${ENROLMENT_TOKEN}`);
  expect(request?.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(request?.body ?? "")).toEqual({
    name: "example-captain",
    rank: "captain",
    ship: "example-captain-ship",
    model: "example-model",
    ircNick: "example-captain",
    certificate: key.certificate,
    scopes: ["api", "irc"],
  });
  expect(JSON.parse(stub.requests[1]?.body ?? "")).not.toHaveProperty("ship");
  expect(((await stat(bundle)).mode & 0o777).toString(8)).toBe("600");

  const record = `${bundle}.enrolment.json`;

  expect(((await stat(record)).mode & 0o777).toString(8)).toBe("600");
  expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({
    fingerprint: key.fingerprint,
    agentId: "agent-example-captain",
    credentialId: `credential-${key.fingerprint.slice(0, 8)}`,
    audience: stub.url,
  });
  expect(first[0]).toMatchObject({
    fingerprint: key.fingerprint,
    agentId: "agent-example-captain",
  });
  // The same bundle serves IRC later (SASL EXTERNAL client certificate).
  expect((await clientPem(bundle)).key).toContain("PRIVATE KEY");

  const before = await readFile(bundle, "utf8");
  const again = await enrolOfficers({ section: config, dataDirectory, env });

  expect(again.map((outcome) => outcome.state)).toEqual([
    "unchanged",
    "unchanged",
  ]);
  expect(stub.requests).toHaveLength(2);
  expect(await readFile(bundle, "utf8")).toBe(before);
  expect(JSON.stringify([first, again])).not.toContain(ENROLMENT_TOKEN);
  expect(JSON.stringify([first, again])).not.toContain("PRIVATE KEY");
});

test("certificates: sent in canonical form, and never one for two officers", async () => {
  const stub = api();
  stub.handler = (recorded) => enrolled(recorded);
  const dataDirectory = await privateDirectory();
  const keys = await childDirectory(dataDirectory, "keys", 0o700);
  const key = generateAgentKey("captain-a");
  // A bundle written elsewhere, with Windows line endings.
  const text = bundleText(key).replaceAll("\n", "\r\n");

  for (const name of ["a.pem", "b.pem"]) {
    await writeFile(join(keys, name), text, { mode: 0o600 });
  }

  const shared = section(stub.url, [
    captain("captain-a", { bundlePath: join(keys, "a.pem") }),
    captain("captain-b", { bundlePath: join(keys, "b.pem") }),
  ]);

  await expect(
    enrolOfficers({ section: shared, dataDirectory, env }),
  ).rejects.toThrow(
    "captain-a and captain-b have the same certificate; each officer needs its own",
  );
  expect(stub.requests).toHaveLength(0);

  const [outcome] = await enrolOfficers({
    section: section(stub.url, [
      captain("captain-a", { bundlePath: join(keys, "a.pem") }),
    ]),
    dataDirectory,
    env,
  });

  expect(outcome?.fingerprint).toBe(key.fingerprint);

  const sent = (
    JSON.parse(stub.requests[0]?.body ?? "") as {
      certificate: string;
    }
  ).certificate;

  const base64 = new X509Certificate(sent).raw.toString("base64");

  expect(sent).toBe(
    `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----\n`,
  );
  expect(sent).toBe(key.certificate);
});

test("enrolment: each refusal is that officer's outcome, in fixed words, and records nothing", async () => {
  const stub = api();
  const dataDirectory = await privateDirectory();
  const config = section(stub.url, [captain("example-captain")]);

  const record = join(
    dataDirectory,
    "subspace-agents",
    "example-captain.pem.enrolment.json",
  );

  for (const [status, message] of [
    [401, "refused the enrolment token"],
    [403, "refused the enrolment token"],
    [409, "refused to enrol example-captain (HTTP 409)"],
    [422, "refused example-captain's enrolment details (HTTP 422)"],
    [500, "answered HTTP 500"],
  ] as const) {
    stub.handler = () =>
      Response.json(
        { title: "Refused", detail: `Example detail ${ENROLMENT_TOKEN}\n.` },
        { status },
      );

    const [outcome] = await enrolOfficers({
      section: config,
      dataDirectory,
      env,
    });

    expect(outcome?.state).toBe("failed");
    expect(outcome?.error).toContain(message);
    // The API's own detail follows, without the token or a line break.
    expect(outcome?.error).toContain("The API says: Example detail [token] .");
    expect(outcome?.error).not.toContain(ENROLMENT_TOKEN);
    expect(existsSync(record)).toBe(false);
  }

  // A different fingerprint in the answer is not recorded as enrolment.
  stub.handler = () =>
    Response.json(
      { agentId: "a", credentialId: "c", fingerprint: "0".repeat(64) },
      { status: 201 },
    );
  expect(
    (await enrolOfficers({ section: config, dataDirectory, env }))[0]?.error,
  ).toBe("The API reported a different certificate fingerprint");
  expect(existsSync(record)).toBe(false);

  const down = section("http://127.0.0.1:9", [captain("example-captain")]);

  expect(
    (await enrolOfficers({ section: down, dataDirectory, env }))[0]?.error,
  ).toBe("The Subspace API is unreachable");

  const requests = stub.requests.length;

  for (const [environment, extra, message] of [
    [{}, {}, "The enrolment token is not set"],
    [
      { SUBSPACE_ENROLMENT: "not-an-enrolment-token" },
      {},
      "not a Subspace enrolment token",
    ],
    [env, { enrolment: undefined }, "No enrolment token is configured"],
  ] as const) {
    const [outcome] = await enrolOfficers({
      section: { ...config, ...extra },
      dataDirectory,
      env: environment,
    });

    expect(outcome?.error).toContain(message);
  }

  expect(stub.requests).toHaveLength(requests);
});

test("enrolment: the token file must be private; the key stays generated for a later run", async () => {
  const stub = api();
  stub.handler = (recorded) => enrolled(recorded);
  const dataDirectory = await privateDirectory();
  const tokenFile = join(dataDirectory, "enrolment-token");
  await writeFile(tokenFile, `${ENROLMENT_TOKEN}\n`, { mode: 0o644 });

  const config = section(stub.url, [captain("example-captain")], {
    enrolment: { tokenFile },
  });

  const [refused] = await enrolOfficers({
    section: config,
    dataDirectory,
    env: {},
  });

  expect(refused?.error).toContain(
    "The enrolment token file must be a regular file owned by the gateway user",
  );
  expect(stub.requests).toHaveLength(0);
  await chmod(tokenFile, 0o600);

  const [accepted] = await enrolOfficers({
    section: config,
    dataDirectory,
    env: {},
  });

  expect(accepted?.state).toBe("enrolled");
  expect(accepted?.fingerprint).toBe(refused?.fingerprint);
  expect(stub.requests[0]?.headers["authorization"]).toBe(
    `Bearer ${ENROLMENT_TOKEN}`,
  );
});

test("rotation: a new key replaces the bundle only once enrolled, and reports the old fingerprint", async () => {
  const stub = api();
  stub.handler = (recorded) => enrolled(recorded);
  const dataDirectory = await privateDirectory();

  const config = section(stub.url, [
    captain("example-captain"),
    captain("example-other"),
  ]);

  const [first] = await enrolOfficers({ section: config, dataDirectory, env });
  const bundle = join(dataDirectory, "subspace-agents", "example-captain.pem");
  const old = await readFile(bundle, "utf8");

  stub.handler = () => new Response("unavailable", { status: 503 });

  const [failed] = await enrolOfficers({
    section: config,
    dataDirectory,
    env,
    rotate: true,
    names: ["example-captain"],
  });

  expect(failed).toMatchObject({
    state: "failed",
    fingerprint: first?.fingerprint,
  });
  expect(await readFile(bundle, "utf8")).toBe(old);

  stub.handler = (recorded) => enrolled(recorded);

  const rotated = await enrolOfficers({
    section: config,
    dataDirectory,
    env,
    rotate: true,
    names: ["example-captain"],
  });

  expect(rotated).toHaveLength(1);
  expect(rotated[0]).toMatchObject({
    name: "example-captain",
    state: "rotated",
    previousFingerprint: first?.fingerprint,
  });
  expect(rotated[0]?.fingerprint).not.toBe(first?.fingerprint);
  expect(rotated[0]?.fingerprint).toBe(
    parseBundle(await readFile(bundle, "utf8")).fingerprint,
  );
  expect(((await stat(bundle)).mode & 0o777).toString(8)).toBe("600");

  // The next ordinary run keeps the rotated key.
  const after = await enrolOfficers({ section: config, dataDirectory, env });

  expect(after.map((outcome) => outcome.state)).toEqual([
    "unchanged",
    "unchanged",
  ]);
  await expect(
    enrolOfficers({ section: config, dataDirectory, env, names: ["missing"] }),
  ).rejects.toThrow("No configured officer is named missing");
});

test("files: a state directory, bundle or bundle directory others can use stops everything", async () => {
  const stub = api();
  stub.handler = (recorded) => enrolled(recorded);
  const dataDirectory = await privateDirectory();
  const config = section(stub.url, [captain("example-captain")]);
  const state = join(dataDirectory, "subspace-agents");
  await enrolOfficers({ section: config, dataDirectory, env });
  const bundle = join(state, "example-captain.pem");

  await chmod(bundle, 0o640);
  await expect(
    enrolOfficers({ section: config, dataDirectory, env }),
  ).rejects.toThrow(
    "example-captain's Subspace bundle must be a regular file owned by the gateway user, readable by it alone",
  );
  await chmod(bundle, 0o600);
  await chmod(state, 0o750);
  await expect(
    enrolOfficers({ section: config, dataDirectory, env }),
  ).rejects.toThrow(
    "state directory must be owned by the gateway user and private to it",
  );
  await chmod(state, 0o700);

  const elsewhere = await childDirectory(dataDirectory, "keys", 0o755);
  const linked = join(elsewhere, "linked.pem");
  await symlink(bundle, linked);

  await expect(
    enrolOfficers({
      section: section(stub.url, [
        captain("example-captain", { bundlePath: linked }),
      ]),
      dataDirectory,
      env,
    }),
  ).rejects.toThrow("unreadable or a link");

  // An explicit bundle may live in its own directory, writable by the gateway alone.
  const explicit = join(elsewhere, "example-captain.pem");

  const [placed] = await enrolOfficers({
    section: section(stub.url, [
      captain("example-captain", { bundlePath: explicit }),
    ]),
    dataDirectory,
    env,
  });

  expect(placed?.state).toBe("enrolled");
  expect(existsSync(`${explicit}.enrolment.json`)).toBe(true);
  await chmod(elsewhere, 0o775);
  await expect(
    enrolOfficers({
      section: section(stub.url, [
        captain("example-captain", { bundlePath: explicit }),
      ]),
      dataDirectory,
      env,
    }),
  ).rejects.toThrow(
    "must exist, be owned by the gateway user and be writable by it alone",
  );
});

test("command: enrol prints outcomes without secrets and refuses a disabled section", async () => {
  const stub = api();
  stub.handler = (recorded) => enrolled(recorded);
  const directory = await privateDirectory();
  const path = join(directory, "stargate.json");

  const base = {
    dataDirectory: directory,
    irc: [
      ircCaptain("example-captain", {
        type: "opencode",
        url: "http://127.0.0.1:4096",
        directory: "/workspace",
      }),
    ],
  };

  await writeFile(
    path,
    JSON.stringify({
      ...base,
      subspaceAgents: { ...enabledRaw(), enabled: false },
    }),
  );
  await expect(runCli(["subspace", "enrol", "--config", path])).rejects.toThrow(
    "Enable subspaceAgents in the Stargate configuration first.",
  );
  expect(stub.requests).toHaveLength(0);
  expect(existsSync(join(directory, "subspace-agents"))).toBe(false);

  await writeFile(
    path,
    JSON.stringify({
      ...base,
      subspaceAgents: enabledRaw({
        api: { baseUrl: stub.url },
        enrolment: { tokenEnv: "EXAMPLE_ENROLMENT_TOKEN" },
      }),
    }),
  );
  await writeFile(
    `${path}.env`,
    `EXAMPLE_ENROLMENT_TOKEN=${ENROLMENT_TOKEN}\n`,
    { mode: 0o600 },
  );

  const printed: string[] = [];
  const original = console.log;

  console.log = (line: string) => printed.push(line);

  try {
    await runCli(["subspace", "enrol", "--config", path]);
    await runCli([
      "subspace",
      "enrol",
      "--config",
      path,
      "--rotate",
      "--name",
      "example-captain",
    ]);
  } finally {
    console.log = original;
  }

  const [enrolment, rotation] = printed.map(
    (line) =>
      JSON.parse(line) as {
        officers: {
          state: string;
          previousFingerprint?: string;
          fingerprint?: string;
        }[];
      },
  );

  expect(enrolment?.officers[0]?.state).toBe("enrolled");
  expect(rotation?.officers[0]?.previousFingerprint).toBe(
    enrolment?.officers[0]?.fingerprint,
  );
  expect(printed.join("\n")).not.toContain(ENROLMENT_TOKEN);
  expect(printed.join("\n")).not.toContain("PRIVATE KEY");
  await expect(
    runCli(["subspace", "enrol", "--config", path, "--json"]),
  ).rejects.toThrow("Option is not supported by this command");
});
