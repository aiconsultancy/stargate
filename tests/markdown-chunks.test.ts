import { describe, expect, test } from "bun:test";
import { chunks } from "../src/gateway/routing";
import { prepareSlackReply, replyText } from "../src/shared/slack-format";

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
      expect(parts.join("")).toContain("[Response truncated by Stargate.]");
    }

    expect(chunks("a".repeat(70_000)).join("")).toBe(
      `${"a".repeat(60_000)}\n[Response truncated by Stargate.]`,
    );
  });
});

test("chunk boundaries never cut bounded complete user or channel mentions", () => {
  for (const mention of ["<@U123>", "<#C123|general>"]) {
    for (let shift = 1; shift < mention.length; shift++) {
      const text = "a".repeat(2800 - shift) + mention + "z".repeat(3000);
      const parts = prepareSlackReply(text).map(replyText);
      expect(parts.join("")).toBe(text.replace("|general", ""));
      expect(
        parts.some((part) => part.includes(mention.replace("|general", ""))),
      ).toBe(true);
      expect(parts.every((part) => Array.from(part).length <= 2800)).toBe(true);
    }
  }

  const unicode = "🦘".repeat(2798) + "<@U123>";
  expect(prepareSlackReply(unicode).map(replyText)).toEqual([
    "🦘".repeat(2798),
    "<@U123>",
  ]);
});

test("inline code cannot notify when split, including marker-free middle chunks", () => {
  for (const close of ["` tail <@U9>", ""]) {
    const source = `Use \`${"x".repeat(3000)} <@U123> ${"y".repeat(5500)}${close}`;
    const parts = prepareSlackReply(source);
    expect(parts.length).toBeGreaterThan(3);

    for (const part of parts) {
      expect(Array.from(replyText(part)).length).toBeLessThanOrEqual(2800);
      expect(JSON.stringify(part)).not.toContain('"user_id":"U123"');
    }

    if (close) expect(JSON.stringify(parts)).toContain('"user_id":"U9"');
  }

  const parts = prepareSlackReply(`${"a".repeat(2796)}\`<@U123>\``);
  expect(parts.length).toBe(2);
  expect(JSON.stringify(parts)).not.toContain('"type":"user"');
});

test("an unmatched code span crossing a fence cannot hang chunking", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import { chunks } from "./src/gateway/routing";
    const parts = chunks("p".repeat(1500) + " \\\`\\n\\\`\\\`\\\`\\n" + "x".repeat(2792));
    if (parts.some(part => Array.from(part).length > 2800)) process.exit(2);
  `,
    ],
    { cwd: new URL("..", import.meta.url).pathname, timeout: 2000 },
  );

  expect(result.exitCode).toBe(0);
});

test("a stray backtick cannot flatten subsequent Markdown paragraphs", () => {
  const prefix = "Press the ` key to open the console.\n\n";

  const text =
    prefix +
    Array.from(
      { length: 8 },
      (_, index) =>
        `## Heading ${index}\n\n${"Plain prose. ".repeat(40)}\n\n- First\n- Second\n\n`,
    ).join("");

  const parts = chunks(text);
  expect(parts[0]).toStartWith(prefix);
  expect(parts.join("")).toBe(text.trimEnd());
  expect(parts.join("")).not.toContain("~~~");
});

test("full-reply classification protects blockquote fences across messages", () => {
  const quote =
    "> ```\n" +
    ("> " + "x".repeat(70) + "\n").repeat(60) +
    "> <@U123> ping\n" +
    ("> " + "y".repeat(70) + "\n").repeat(10) +
    "> ```";

  const parts = prepareSlackReply(quote);
  expect(parts.length).toBeGreaterThan(1);
  expect(JSON.stringify(parts)).not.toContain('"user_id":"U123"');
  expect(JSON.stringify(parts)).toContain('"code":true');
});

test("uncertain full replies fall back to plain text for every chunk", () => {
  for (const source of [
    "Use `<@U1>" + "x".repeat(6000),
    "<@U1>\n\n> ```\n> code",
    "<@U1>\n\n```\ncode",
  ]) {
    const parts = prepareSlackReply(source);

    for (const part of parts) {
      expect(JSON.stringify(part)).toContain('"type":"plain_text"');
      expect(JSON.stringify(part)).not.toContain('"type":"user"');
    }
  }
});
