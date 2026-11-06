import { describe, expect, test } from "bun:test";
import { chunks } from "../src/routing";

describe("Markdown reply chunks", () => {
  test("keeps short replies unchanged and prefers paragraph boundaries", () => {
    expect(
      chunks("# Heading\n\n**Hello** [link](https://example.com)"),
    ).toEqual(["# Heading\n\n**Hello** [link](https://example.com)"]);
    const paragraph = `${"a".repeat(2000)}\n\n`;
    expect(chunks(`${paragraph}${"b".repeat(2000)}`)).toEqual([
      paragraph,
      "b".repeat(2000),
    ]);
    expect(chunks("a".repeat(5601)).map((part) => part.length)).toEqual([
      2800, 2800, 1,
    ]);
  });

  for (const marker of ["```", "~~~~"]) {
    test(`closes and reopens ${marker} fences without changing code`, () => {
      const code = `${"const n = '🦘';\n".repeat(400)}done();\n`;
      const parts = chunks(`${marker}typescript\n${code}${marker}`);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(Array.from(part).length).toBeLessThanOrEqual(2800);
        expect(part).toStartWith(`${marker}typescript\n`);
        expect(part).toEndWith(`\n${marker}`);
      }
      expect(
        parts
          .map((part) =>
            part.slice(`${marker}typescript\n`.length, -marker.length),
          )
          .join(""),
      ).toBe(code);
    });
  }

  test("keeps fence markers atomic near message boundaries", () => {
    const text = `${"a".repeat(2794)}\n\n\`\`\`typescript\nhello\n\`\`\``;
    const parts = chunks(text);
    expect(parts[0]).toBe(`${"a".repeat(2794)}\n\n`);
    expect(parts[1]).toBe("```typescript\nhello\n```");
  });

  test("preserves unbroken Unicode code lines and longer outer fences", () => {
    const code = "🦘".repeat(6000);
    const parts = chunks(`\`\`\`\`ts\n${code}\n\`\`\`\``);
    expect(
      parts
        .map((part) => part.slice("````ts\n".length, -"\n````".length))
        .join(""),
    ).toBe(code);
    expect(parts.every((part) => Array.from(part).length <= 2800)).toBe(true);
    const nested = "````md\n```js\nhello\n```\n~~~~\n`````\nAfter";
    expect(chunks(nested)).toEqual([nested]);
  });

  test("balances incomplete streaming snapshots deterministically", () => {
    for (const snapshot of [
      "```ts",
      "```ts\n",
      "```ts\nhello",
      `~~~js\n${"🦘".repeat(6000)}`,
    ]) {
      const parts = chunks(snapshot);
      expect(chunks(snapshot)).toEqual(parts);
      for (const part of parts) {
        expect(Array.from(part).length).toBeLessThanOrEqual(2800);
        expect(part).toEndWith(snapshot.startsWith("~") ? "\n~~~" : "\n```");
        expect(part).not.toMatch(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
        );
      }
    }
    expect(chunks("```ts\nhello\n```\nFinal")).toEqual([
      "```ts\nhello\n```\nFinal",
    ]);
  });

  test("bounds pathological fence runs, info strings, and truncated replies", () => {
    for (const text of [
      "`".repeat(70_000),
      `~~~${"x".repeat(70_000)}`,
      `\`\`\`ts\n${"🦘".repeat(70_000)}`,
    ]) {
      const parts = chunks(text);
      expect(parts.length).toBeLessThan(40);
      expect(parts.every((part) => Array.from(part).length <= 2800)).toBe(true);
      expect(parts.join("")).toContain("[Response truncated by Pogo.]");
    }
    expect(chunks("a".repeat(70_000)).join("")).toBe(
      `${"a".repeat(60_000)}\n[Response truncated by Pogo.]`,
    );
  });
});
