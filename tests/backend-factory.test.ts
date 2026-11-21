import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createBackend } from "../src/backends/factory";

test("custom module receives the unchanged options and context signature", async () => {
  const root = await mkdtemp(join(tmpdir(), "backend-factory-"));
  try {
    const module = join(root, "adapter.ts");
    await writeFile(
      module,
      `
export async function createBackend(options, context) {
  return {
    async createSession() { return context.dataDirectory; },
    async prompt() { return options.answer; },
    async close() {},
  };
}
`,
    );
    const backend = await createBackend(
      { type: "module", module, options: { answer: "custom answer" } },
      { dataDirectory: root },
    );
    const signal = new AbortController().signal;
    expect(
      await backend.createSession({ key: "thread", title: "Test", signal }),
    ).toBe(root);
    expect(await backend.prompt("session", "question", signal)).toBe(
      "custom answer",
    );
    await backend.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  [
    "missing factory",
    "export const other = true;",
    "Backend module must export createBackend(options, context)",
  ],
  [
    "invalid backend",
    "export function createBackend() { return {}; }",
    "Backend module returned an invalid AgentBackend",
  ],
])("custom module rejects %s", async (_name, source, message) => {
  const root = await mkdtemp(join(tmpdir(), "backend-factory-"));
  try {
    const module = join(root, "invalid.ts");
    await writeFile(module, source);
    await expect(
      createBackend(
        { type: "module", module, options: {} },
        { dataDirectory: root },
      ),
    ).rejects.toThrow(message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
