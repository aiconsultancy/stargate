import { expect, test } from "bun:test";
import { prepareSlackReply, slackContent } from "../src/shared/slack-format";

test("standard Markdown stays unchanged, including literal code and quotes", () => {
  const text =
    '# Heading\n\n**Bold** and [link](https://example.test).\n\n> Quote\n\n```html\n<!DOCTYPE html>\n<a href="x">A & B</a>\n```';
  expect(slackContent(text).blocks).toEqual([{ type: "markdown", text }]);
});

test("leading and inline user mentions retain surrounding Markdown styles", () => {
  for (const text of ["<@U123> **bold**", "**bold** for <@U123> *now*"]) {
    const blocks = slackContent(text).blocks;
    expect(blocks[0]?.type).toBe("rich_text");
    expect(JSON.stringify(blocks)).toContain('"type":"user","user_id":"U123"');
    expect(JSON.stringify(blocks)).toContain(
      '"text":"bold","style":{"bold":true}',
    );
  }
});

test("channel mentions and labelled Slack links are structured", () => {
  expect(
    slackContent("<#C123|general> <https://example.test/a?x=1&y=2|Docs>")
      .blocks,
  ).toEqual([
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "channel", channel_id: "C123" },
            { type: "text", text: " " },
            {
              type: "link",
              url: "https://example.test/a?x=1&y=2",
              text: "Docs",
            },
          ],
        },
      ],
    },
  ]);
});

test("broadcast, unsupported and partial controls stay literal beside bold text", () => {
  for (const control of [
    "<!here>",
    "<!channel>",
    "<!everyone>",
    "<!subteam^S123>",
    "<!date^123^{date}|today>",
    "@here",
    "@channel",
    "@everyone",
    "<@",
    "<@U123",
    "<#C123",
    "<!subteam^",
    "<https://example.test|Docs",
    "<@bad>",
  ]) {
    const blocks = slackContent(`**bold** ${control}`).blocks;
    const encoded = JSON.stringify(blocks);
    expect(encoded).toContain('"text":"bold","style":{"bold":true}');
    expect(encoded).toContain(control);
    expect(encoded).not.toContain('"type":"user"');
    expect(encoded).not.toContain('"type":"channel"');
    expect(encoded).not.toContain('"type":"broadcast"');
    expect(slackContent(control).text).not.toContain("<");
  }
});

test("code spans and fenced or indented code never create mentions or links", () => {
  for (const text of [
    "`<@U123> <!here> <https://example.test|Docs>`",
    "```\n<@U123> <!here>\n```",
    "    <@U123> <!here>\n",
  ]) {
    const encoded = JSON.stringify(slackContent(text).blocks);
    expect(encoded).toContain("<@U123>");
    expect(encoded).not.toContain('"type":"user"');
    expect(encoded).not.toContain('"type":"link"');
  }
});

test("mixed content retains lists, quotes, headings, links and inline code", () => {
  const encoded = JSON.stringify(
    slackContent(
      "# Title <@U123>\n\n- **one**\n- `two`\n\n> *quote*\n\n[docs](https://example.test)",
    ).blocks,
  );
  for (const type of ["rich_text_list", "rich_text_quote", "link", "user"])
    expect(encoded).toContain(`"type":"${type}"`);
  for (const style of ["bold", "italic", "code"])
    expect(encoded).toContain(`"${style}":true`);
});

test("invalid or dangerous link targets remain literal and fallback is escaped", () => {
  for (const text of [
    "<javascript:alert(1)|click>",
    "<https://user:pass@example.test|click>",
    "<https://example.test|<!here>>",
    "<https://example.test|<@U123>>",
  ]) {
    expect(JSON.stringify(slackContent(text).blocks)).not.toContain(
      '"type":"link"',
    );
    expect(JSON.stringify(slackContent(text).blocks)).not.toContain(
      '"type":"user"',
    );
  }
  expect(slackContent("<@U123> **bold** & <!here>").text).toBe(
    "&lt;@U123&gt; **bold** &amp; &lt;!here&gt;",
  );
});

test("scheduled announcements can explicitly retain plain-text names", () => {
  const text = "Scheduled task: **literal title** <@U123>";
  expect(slackContent(text, "plain").blocks).toEqual([
    { type: "section", text: { type: "plain_text", text, emoji: false } },
  ]);
});

test("escaping and nested Markdown cannot promote a partial or nested control", () => {
  for (const text of [
    "\\<@U123>",
    "&lt;@U123&gt; <!here>",
    "<https://example.test|**label** <@U123>>",
    "<@**U123**>",
    "- item\n\n  ```\n  <@U123>\n  ```",
  ]) {
    expect(JSON.stringify(slackContent(text).blocks)).not.toContain(
      '"type":"user"',
    );
  }
});

test("mixed nested lists retain indentation and numbering, quotes retain lines", () => {
  const encoded = JSON.stringify(
    slackContent(
      "<@U123>\n\n3. outer\n   - nested\n4. next\n\n> first\n>\n> second",
    ).blocks,
  );
  expect(encoded).toContain('"indent":1');
  expect(encoded).toContain('"offset":2');
  expect(encoded).toContain('"offset":3');
  expect(encoded).toContain('"text":"\\n"');
});

test("mixed headings, tables and images degrade to readable content", () => {
  const encoded = JSON.stringify(
    slackContent(
      "# Heading <@U123>\n\n| Name | State |\n| --- | --- |\n| Ship | Ready |\n\n![Ship image](https://example.test/ship.png)",
    ).blocks,
  );
  for (const content of [
    "Heading",
    "Name",
    "State",
    "Ship",
    "Ready",
    "Ship image (https://example.test/ship.png)",
  ])
    expect(encoded).toContain(content);
  expect(encoded).not.toContain("| --- |");
  expect(encoded).not.toContain("![");
  expect(encoded).not.toContain("# Heading");
});

test("mixed paragraphs preserve soft and hard line breaks", () => {
  for (const text of [
    "Hi <@U1>\nPlease review\nthanks",
    "Hi <@U1>  \nPlease review\\\nthanks",
  ]) {
    const encoded = JSON.stringify(slackContent(text).blocks);
    expect(encoded.match(/"text":"\\n"/g)?.length).toBe(2);
  }
});

test("multiple blocks inside one list item retain a separator", () => {
  const encoded = JSON.stringify(
    slackContent("<@U1>\n\n- first\n\n  second").blocks,
  );
  expect(encoded).toContain(
    '"text":"first"},{"type":"text","text":"\\n"},{"type":"text","text":"second"',
  );
});

test("empty Markdown constructs never create empty rich-text elements", () => {
  for (const extra of [
    "```\n```",
    ">",
    "-",
    "- \n- x",
    "| a |\n| --- |\n| |\n",
  ]) {
    const encoded = JSON.stringify(slackContent(`<@U1>\n\n${extra}`).blocks);
    expect(encoded).not.toContain('"text":""');
    expect(encoded).not.toContain('"elements":[]');
  }
});

test("code, escaped and entity controls in image or unsafe-link labels stay literal", () => {
  for (const text of [
    "![`<@U123>`](https://example.test/img.png)",
    "[`<@U123>`](javascript:x)",
    "![&lt;@U2&gt;](https://x.test/i.png)",
    "[\\<@U2>](javascript:x)",
  ]) {
    const encoded = JSON.stringify(slackContent(text).blocks);
    expect(encoded).not.toContain('"type":"user"');
    if (text.startsWith("[`")) expect(encoded).toContain('"code":true');
    expect(encoded).not.toContain('"literal":');
  }
});

test("unclosed inline code fails closed during streaming", () => {
  for (const text of ["Use `<@U123>", "<@U123>` tail"])
    expect(JSON.stringify(slackContent(text).blocks)).not.toContain(
      '"type":"user"',
    );
  const encoded = JSON.stringify(slackContent("Use `<@U123>` <@U9>").blocks);
  expect(encoded).not.toContain('"user_id":"U123"');
  expect(encoded).toContain('"user_id":"U9"');
});

test("full classification retains leading indented code whitespace", () => {
  const encoded = JSON.stringify(
    prepareSlackReply("    <@U123> code example\n    second line"),
  );
  expect(encoded).not.toContain('"user_id":"U123"');
  expect(encoded).toContain('"type":"rich_text_preformatted"');
});

test("rejected destination metadata cannot promote an escaped mention", () => {
  const encoded = JSON.stringify(
    prepareSlackReply(String.raw`[docs](https://example.test/\<@U123>)`),
  );
  expect(encoded).not.toContain('"user_id":"U123"');
  expect(encoded).not.toContain('"literal":');
});

test("link URLs and labels both consume the Slack chunk budget", () => {
  const source = Array.from(
    { length: 250 },
    (_, index) =>
      `- [#${12000 + index}](https://github.com/example-org/project/pull/${12000 + index})`,
  ).join("\n");
  const parts = prepareSlackReply("<@U9>\n\n" + source);
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const part of parts) {
    if (typeof part === "string")
      throw new Error("Expected classified content");
    let characters = 0;
    const count = (value: unknown) => {
      if (Array.isArray(value)) for (const child of value) count(child);
      else if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value)) {
          if ((key === "text" || key === "url") && typeof child === "string")
            characters += Array.from(child).length;
          else count(child);
        }
    };
    count(part.content.blocks);
    expect(characters).toBeLessThanOrEqual(2800);
  }
});

test("ordinary replies keep main's exact native Markdown payload", () => {
  for (const text of [
    "# Title\n\n**Bold** and *italic*.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst value = a < b && c > d;\n```",
    "Press the ` key.",
    "`Array<string|number>` and ops@channel.io",
  ]) {
    const parts = prepareSlackReply(text);
    expect(parts).toHaveLength(1);
    const part = parts[0];
    if (!part || typeof part === "string")
      throw new Error("Missing prepared payload");
    expect(part.content).toEqual({
      text: text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
      blocks: [{ type: "markdown", text }],
    });
  }
});
