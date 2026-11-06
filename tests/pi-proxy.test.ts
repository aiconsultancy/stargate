import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { PiDurableBackend } from "../src/backends/pi-durable";
import { piDurableBackendSchema } from "../src/config";

const apiKeyEnv = "POGO_PI_PROXY_TEST_KEY";
const model = "openai/opencode-go/deepseek-v4.1-flash";
const signal = () => new AbortController().signal;

function config(baseURL: string, directory = "/workspace") {
  return piDurableBackendSchema.parse({
    type: "pi-durable",
    directory,
    model,
    provider: { baseURL, apiKeyEnv },
    tools: "coding",
  });
}

test("Pi proxy configuration validates endpoint and environment references", () => {
  for (const baseURL of [
    "http://127.0.0.1:8317/v1",
    "http://127.0.0.2/v1",
    "http://localhost/v1",
    "http://[::1]/v1",
    "https://proxy.example/v1",
  ]) {
    expect(config(baseURL).provider?.baseURL).toBe(baseURL);
  }
  for (const baseURL of [
    "http://proxy.example/v1",
    "http://127.0.0.1.example/v1",
    "ftp://127.0.0.1/v1",
    "https://user:password@proxy.example/v1",
    "https://proxy.example/v1?key=secret",
    "https://proxy.example/v1#secret",
    "https://proxy.example/v1?",
    "https://proxy.example/v1#",
  ]) {
    expect(() => config(baseURL)).toThrow();
  }
  const valid = config("http://127.0.0.1/v1");
  expect(() =>
    piDurableBackendSchema.parse({
      ...valid,
      provider: { baseURL: valid.provider?.baseURL, apiKey: "raw-secret" },
    }),
  ).toThrow();
  expect(() =>
    piDurableBackendSchema.parse({
      ...valid,
      provider: { baseURL: valid.provider?.baseURL, apiKeyEnv: "raw-key" },
    }),
  ).toThrow();
  const { directory: _, ...worker } = valid;
  expect(
    piDurableBackendSchema.omit({ directory: true }).parse(worker),
  ).toEqual(worker);
});

function completion() {
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "opencode-go/deepseek-v4.1-flash",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  return new Response(
    chunk({ role: "assistant", reasoning_content: "PRIVATE" }) +
      chunk({ content: "Proxy answer" }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Pi proxy sends chat tools, safe auth and persisted conversation headers", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-pi-proxy-");
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "local-proxy-test-only";
  const requests: {
    path: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  let denied = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      });
      if (denied)
        return Response.json(
          {
            error: {
              message: "Fixture authentication failed",
              type: "authentication_error",
            },
          },
          { status: 401 },
        );
      return completion();
    },
  });
  let backend: PiDurableBackend | undefined;
  try {
    const settings = config(new URL("/v1", server.url).href, directory);
    backend = await PiDurableBackend.open(settings, {
      dataDirectory: directory,
    });
    const first = await backend.createSession({
      key: "one",
      title: "one",
      signal: signal(),
    });
    expect(await backend.prompt(first, "hello", signal())).toBe("Proxy answer");
    expect(await backend.prompt(first, "again", signal())).toBe("Proxy answer");
    const second = await backend.createSession({
      key: "two",
      title: "two",
      signal: signal(),
    });
    expect(await backend.prompt(second, "hello", signal())).toBe(
      "Proxy answer",
    );
    await backend.close();
    backend = await PiDurableBackend.open(settings, {
      dataDirectory: directory,
    });
    expect(await backend.prompt(first, "after restart", signal())).toBe(
      "Proxy answer",
    );
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.path).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-proxy-test-only",
      );
      expect(request.headers.get("user-agent")).toBe("Pogo/0.1.0");
      expect(request.body["model"]).toBe("opencode-go/deepseek-v4.1-flash");
      expect(request.body["stream"]).toBe(true);
      expect(request.body["max_tokens"]).toBeGreaterThan(0);
      expect(request.body["tools"]).toBeArray();
      expect((request.body["tools"] as unknown[]).length).toBeGreaterThan(0);
      expect(request.body["store"]).toBeUndefined();
    }
    const ids = requests.map((request) =>
      request.headers.get("x-opencode-session"),
    );
    expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[3]).toBe(ids[0]);
    expect(JSON.stringify(requests[1]?.body["messages"])).toContain(
      "reasoning_content",
    );
    denied = true;
    await expect(backend.prompt(first, "denied", signal())).rejects.toThrow();
    expect(requests).toHaveLength(5);
  } finally {
    await backend?.close();
    await server.stop(true);
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi proxy fails closed on missing auth or unsupported model", async () => {
  const settings = config("http://127.0.0.1:1/v1");
  await expect(
    PiDurableBackend.open(
      {
        ...settings,
        provider: {
          ...settings.provider,
          baseURL: "http://127.0.0.1:1/v1",
          apiKeyEnv: "POGO_PI_PROXY_MISSING_KEY",
        },
      },
      { dataDirectory: "/unused" },
    ),
  ).rejects.toThrow("Missing environment variable: POGO_PI_PROXY_MISSING_KEY");
  await expect(
    PiDurableBackend.open(
      { ...settings, model: "openai/gpt-5" },
      { dataDirectory: "/unused" },
    ),
  ).rejects.toThrow("Pi proxy requires model");
  const { provider: _, ...withoutProxy } = settings;
  await expect(
    PiDurableBackend.open(withoutProxy, { dataDirectory: "/unused" }),
  ).rejects.toThrow("requires provider configuration");
});

test("Pi cancellation closes the underlying proxy stream", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-pi-cancel-");
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "local-proxy-test-only";
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.text();
      request.signal.addEventListener("abort", () => cancelled.resolve(), {
        once: true,
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            started.resolve();
          },
          cancel() {
            cancelled.resolve();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let backend: PiDurableBackend | undefined;
  try {
    backend = await PiDurableBackend.open(
      config(new URL("/v1", server.url).href, directory),
      { dataDirectory: directory },
    );
    const session = await backend.createSession({
      key: "cancel",
      title: "cancel",
      signal: signal(),
    });
    const controller = new AbortController();
    const pending = backend.prompt(session, "hello", controller.signal);

    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await cancelled.promise;
  } finally {
    await backend?.close();
    await server.stop(true);
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
