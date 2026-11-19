import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Schema } from "effect";
import { PiDurableBackend, piModels } from "../src/backends/pi-durable";
import { piDurableBackendSchema } from "../src/config";
import { teamSchema } from "../src/crew/team";

const apiKeyEnv = "STARGATE_PI_CLAUDE_PROXY_TEST_KEY";
const model = "anthropic/claude-haiku-5-5";
const signal = () => new AbortController().signal;
// Native credentials must never reach the proxy or select the native route.
const native = {
  ANTHROPIC_API_KEY: "native-key-must-not-be-sent",
  ANTHROPIC_AUTH_TOKEN: "native-token-must-not-be-sent",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1/native",
};
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of [apiKeyEnv, ...Object.keys(native)])
    saved.set(name, process.env[name]);
  Object.assign(process.env, native, { [apiKeyEnv]: "local-proxy-test-only" });
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function config(
  baseURL: string,
  directory = "/workspace",
  extra: Record<string, unknown> = {},
) {
  return Schema.decodeUnknownSync(piDurableBackendSchema)({
    type: "pi-durable",
    directory,
    model,
    provider: { baseURL, apiKeyEnv },
    tools: "coding",
    ...extra,
  });
}

function messages(text = "Claude proxy answer") {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return new Response(
    event("message_start", {
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text },
      }) +
      event("content_block_stop", { index: 0 }) +
      event("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      }) +
      event("message_stop", {}),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Pi Claude proxy registers only the pinned catalog model at the proxy", () => {
  const settings = config("http://127.0.0.1:8317/v1");
  const models = piModels(settings);
  const source = anthropicProvider()
    .getModels()
    .find((entry) => entry.id === "claude-haiku-5-5");
  const routed = models.getModel("anthropic", "claude-haiku-5-5");
  if (!source) throw new Error("Pinned catalog lacks Claude Haiku 5.5");
  expect(routed).toEqual({ ...source, baseUrl: "http://127.0.0.1:8317" });
  expect(models.getModel("anthropic", "claude-opus-5-5")).toBeUndefined();
  expect(models.getModel("openai", "opencode-go/deepseek-v4.1-flash")).toBe(
    undefined,
  );
});

test("Pi Claude proxy fails closed on unknown model, endpoint or missing key", () => {
  const settings = config("http://127.0.0.1:8317/v1");
  expect(() =>
    piModels({ ...settings, model: "anthropic/claude-opus-5-5" }),
  ).toThrow("Pi proxy requires model");
  expect(() =>
    piModels({ ...settings, model: "anthropic/claude-haiku-5-5#low" }),
  ).toThrow("Pi proxy requires model");
  expect(() => piModels(config("http://127.0.0.1:8317"))).toThrow(
    "baseURL must end with /v1",
  );
  delete process.env[apiKeyEnv];
  expect(() => piModels(settings)).toThrow(
    `Missing environment variable: ${apiKeyEnv}`,
  );
});

test("Pi thinking level accepts only SDK levels the model supports", () => {
  const baseURL = "http://127.0.0.1:8317/v1";
  expect(config(baseURL).thinkingLevel).toBeUndefined();
  expect(config(baseURL, "/workspace", { thinkingLevel: "low" })).toMatchObject(
    { thinkingLevel: "low" },
  );
  for (const thinkingLevel of ["#low", "LOW", "lowest", "", 1, null])
    expect(() => config(baseURL, "/workspace", { thinkingLevel })).toThrow();
  const { directory: _, ...worker } = config(baseURL, "/workspace", {
    thinkingLevel: "low",
  });
  const team = (thinkingLevel: unknown) =>
    Schema.decodeUnknownSync(teamSchema)({
      captain: { id: "captain" },
      crew: [
        {
          id: "avondale",
          role: "Worker",
          permissionProfile: "coding",
          backend: { ...worker, thinkingLevel },
        },
      ],
    });
  expect(team("low").crew[0]?.backend?.thinkingLevel).toBe("low");
  expect(() => team("#low")).toThrow();
  // Haiku maps "minimal" to null; the SDK would clamp it, Stargate refuses it.
  expect(() =>
    piModels(config(baseURL, "/workspace", { thinkingLevel: "minimal" })),
  ).toThrow("does not support thinking level minimal");
  expect(() =>
    piModels(config(baseURL, "/workspace", { thinkingLevel: "low" })),
  ).not.toThrow();
});

for (const thinkingLevel of [undefined, "low"] as const)
  test(`Pi Claude proxy sends thinking ${thinkingLevel ?? "default off"} to bot and report conversations`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "stargate-pi-claude-level-"),
    );
    const bodies: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json());
        return messages();
      },
    });
    let backend: PiDurableBackend | undefined;
    try {
      backend = await PiDurableBackend.open(
        config(new URL("/v1", server.url).href, directory, {
          ...(thinkingLevel && { thinkingLevel }),
        }),
        { dataDirectory: directory },
      );
      const session = await backend.createSession({
        key: "level",
        title: "level",
        signal: signal(),
      });
      expect(await backend.prompt(session, "hello", signal())).toBe(
        "Claude proxy answer",
      );
      expect(await backend.promptReport(session, "Summarize", signal())).toBe(
        "Claude proxy answer",
      );
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        if (thinkingLevel) {
          expect(body["thinking"]).toMatchObject({ type: "adaptive" });
          expect(body["output_config"]).toEqual({ effort: "low" });
          expect(JSON.stringify(body["messages"])).toContain('"effort":"low"');
        } else {
          expect(body["thinking"]).toEqual({ type: "disabled" });
          expect(body["output_config"]).toBeUndefined();
        }
      }
    } finally {
      await backend?.close();
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

test("Pi Claude proxy sends Anthropic messages with only the proxy key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-pi-claude-"));
  const requests: {
    path: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      });
      return messages();
    },
  });
  let backend: PiDurableBackend | undefined;
  try {
    backend = await PiDurableBackend.open(
      config(new URL("/v1", server.url).href, directory),
      { dataDirectory: directory },
    );
    const session = await backend.createSession({
      key: "claude",
      title: "claude",
      signal: signal(),
    });
    expect(await backend.prompt(session, "hello", signal())).toBe(
      "Claude proxy answer",
    );
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (!request) throw new Error("Proxy request is missing");
    expect(request.path).toBe("/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("local-proxy-test-only");
    expect(request.headers.get("authorization")).toBeNull();
    expect(JSON.stringify([...request.headers])).not.toContain("native-");
    expect(request.body["model"]).toBe("claude-haiku-5-5");
    expect(request.body["stream"]).toBe(true);
    // Pi's default thinking level is "off": the SDK disables thinking.
    expect(request.body["thinking"]).toEqual({ type: "disabled" });
    expect(request.body["tools"]).toBeArray();
    expect((request.body["tools"] as unknown[]).length).toBeGreaterThan(0);
  } finally {
    await backend?.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi Claude proxy refuses redirects to another host", async () => {
  let redirected = 0;
  let proxied = 0;
  const target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.text();
      redirected++;
      return messages("REDIRECTED");
    },
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.text();
      proxied++;
      return new Response(null, {
        status: 307,
        headers: { location: new URL("/v1/messages", target.url).href },
      });
    },
  });
  try {
    // Call the provider directly: the durable harness would retry the failure.
    const models = piModels(config(new URL("/v1", server.url).href));
    const routed = models.getModel("anthropic", "claude-haiku-5-5");
    if (!routed) throw new Error("Claude proxy model is missing");
    const reply = await models.completeSimple(routed, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    });
    expect(reply.stopReason).toBe("error");
    expect(proxied).toBeGreaterThan(0);
    expect(redirected).toBe(0);
  } finally {
    await server.stop(true);
    await target.stop(true);
  }
});
