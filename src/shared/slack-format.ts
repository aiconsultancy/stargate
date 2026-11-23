import { markdownChunks } from "../slack/markdown-chunks";

/** Native Markdown cannot represent Slack mentions. Use structured text only
 * when controls occur; Slack never interprets text elements as notifications. */
const slackControls =
  /<[@#]|<!(?:here|channel|everyone|subteam\^|date\^)|<(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|javascript:|data:)|(?:^|\s)@(?:here|channel|everyone)\b/i;

type Style = {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
};

type Inline =
  | { type: "text"; text: string; style?: Style; literal?: true }
  | { type: "link"; url: string; text: string; style?: Style }
  | { type: "user"; user_id: string; style?: Style }
  | { type: "channel"; channel_id: string; style?: Style };

type Section = { type: "rich_text_section"; elements: Inline[] };

type Part =
  | Inline
  | Section
  | { type: "rich_text_quote" | "rich_text_preformatted"; elements: Inline[] }
  | {
      type: "rich_text_list";
      style: "ordered" | "bullet";
      indent: number;
      offset?: number;
      elements: Section[];
    };

function safeUrl(value: string) {
  if (/[\s<>|]/.test(value)) return false;

  try {
    const url = new URL(value);

    return (
      ["http:", "https:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function controls(elements: Inline[]): Inline[] {
  const clean = (element: Inline): Inline => {
    if (element.type !== "text") return element;
    const { literal: _literal, ...text } = element;

    return text;
  };

  // A streamed prefix may not have its closing code delimiter yet. Do not
  // Notify from a section whose backticks the parser left as ordinary text.
  if (
    elements.some(
      (element) =>
        element.type === "text" &&
        !element.style?.code &&
        element.text.includes("`"),
    )
  )
    return elements.map(clean);
  let inAngle = false;

  return elements.flatMap((element): Inline[] => {
    if (element.type !== "text" || element.style?.code || element.literal)
      return [clean(element)];
    const result: Inline[] = [];
    let start = 0;

    // Consume an entire angle group, including malformed nested controls. Never
    // Promote a valid-looking inner mention from an invalid outer control.
    for (const match of element.text.matchAll(/<[^>]*>|<[^>]*$|>/g)) {
      if (match[0] === ">") {
        inAngle = false;
        continue;
      }

      if (!match[0].endsWith(">")) {
        inAngle = true;
        continue;
      }

      if (inAngle) {
        inAngle = false;
        continue;
      }

      const token = match[0].slice(1, -1);
      let replacement: Inline | undefined;

      if (/^@[UW][A-Z0-9]{1,31}$/.test(token)) {
        replacement = { type: "user", user_id: token.slice(1) };
      } else if (/^#[CG][A-Z0-9]{1,31}(?:\|[^<>|\s]{1,80})?$/.test(token)) {
        replacement = {
          type: "channel",
          channel_id: token.slice(1).split("|")[0] ?? "",
        };
      } else {
        const [url = "", label] = token.split("|");

        if (
          safeUrl(url) &&
          !token.includes("<") &&
          token.split("|").length <= 2
        ) {
          replacement = {
            type: "link",
            url,
            text: label === undefined || label === "" ? url : label,
          };
        }
      }

      if (!replacement) continue;

      if (match.index > start)
        result.push({
          ...element,
          text: element.text.slice(start, match.index),
        });
      result.push({
        ...replacement,
        ...(element.style ? { style: element.style } : {}),
      });
      start = match.index + match[0].length;
    }

    if (start < element.text.length)
      result.push({ ...element, text: element.text.slice(start) });

    return result;
  });
}

function structuredMarkdown(text: string) {
  // Bun owns Markdown parsing. Callback results contain only arena indices,
  // Never source text, so source cannot forge an element or escape code style.
  const arena: Part[] = [];
  const put = (part: Part) => `${arena.push(part) - 1},`;

  const parts = (children: string): Part[] =>
    children.split(",").flatMap((id) => {
      // Bun emits soft/hard breaks directly, outside the text callback.
      const breaks = /^\n+/.exec(id)?.[0];
      const part = id.trim() === "" ? undefined : arena[Number(id)];

      return [
        ...(breaks ? [{ type: "text" as const, text: breaks }] : []),
        ...(part ? [part] : []),
      ];
    });

  const inline = (nodes: Part[]): Inline[] =>
    nodes.flatMap((node): Inline[] => {
      if (node.type === "rich_text_list")
        return node.elements.flatMap((section) => [
          ...section.elements,
          { type: "text", text: "\n" },
        ]);

      if (node.type === "rich_text_preformatted")
        return node.elements.map((element) => ({
          ...element,
          style: { ...element.style, code: true },
        }));

      if ("elements" in node) return node.elements;

      return [node];
    });

  const literal = (children: string) =>
    inline(parts(children))
      .map((node) => ("text" in node ? node.text : ""))
      .join("");

  const styled = (children: string, style: Style) =>
    inline(parts(children))
      .map((node) => put({ ...node, style: { ...node.style, ...style } }))
      .join("");

  const section = (children: string) =>
    put({ type: "rich_text_section", elements: inline(parts(children)) });

  const rendered = Bun.markdown.render(
    text,
    {
      text: (value) => put({ type: "text", text: value }),
      paragraph: section,
      heading: (children) => section(styled(children, { bold: true })),
      strong: (children) => styled(children, { bold: true }),
      emphasis: (children) => styled(children, { italic: true }),
      strikethrough: (children) => styled(children, { strike: true }),
      codespan: (children) =>
        put({ type: "text", text: literal(children), style: { code: true } }),
      code: (children) =>
        put({
          type: "rich_text_preformatted",
          elements: [{ type: "text", text: literal(children) }],
        }),
      blockquote: (children) =>
        put({
          type: "rich_text_quote",
          elements: parts(children).flatMap((node, index) => [
            ...(index ? [{ type: "text" as const, text: "\n" }] : []),
            ...inline([node]),
          ]),
        }),
      listItem: (children, meta) => {
        const nodes = parts(children);
        const nested = nodes.filter((node) => node.type === "rich_text_list");

        const content = nodes
          .filter((node) => node.type !== "rich_text_list")
          .flatMap((node, index, siblings) => {
            const previous = siblings[index - 1];

            return previous && ("elements" in previous || "elements" in node)
              ? [{ type: "text" as const, text: "\n" }, node]
              : [node];
          })
          .map(put)
          .join("");

        return (
          section(
            (meta.checked === undefined
              ? ""
              : put({ type: "text", text: meta.checked ? "☑ " : "☐ " })) +
              content,
          ) + nested.map(put).join("")
        );
      },
      list: (children, meta) => {
        let sections: Section[] = [];
        let offset = Math.max(0, (meta.start ?? 1) - 1);
        let result = "";

        const flush = () => {
          if (!sections.length) return;
          result += put({
            type: "rich_text_list",
            style: meta.ordered ? "ordered" : "bullet",
            indent: Math.min(meta.depth, 8),
            ...(meta.ordered ? { offset } : {}),
            elements: sections,
          });
          offset += sections.length;
          sections = [];
        };

        for (const node of parts(children)) {
          if (node.type === "rich_text_section") sections.push(node);
          else {
            flush();
            result += put(node);
          }
        }

        flush();

        return result;
      },
      link: (children, meta) =>
        safeUrl(meta.href)
          ? put({
              type: "link",
              url: meta.href,
              text: literal(children) || meta.href,
            })
          : children +
            put({ type: "text", text: ` (${meta.href})`, literal: true }),
      // Bun deliberately strips inline styles from image alt text before the
      // Callback. Treat all alt text as literal, not as a notification source.
      image: (children, meta) =>
        put({
          type: "text",
          text: literal(children)
            ? `${literal(children)} (${meta.src})`
            : meta.src,
          literal: true,
        }),
      th: (children) =>
        styled(children, { bold: true }) + put({ type: "text", text: " | " }),
      td: (children) => children + put({ type: "text", text: " | " }),
      tr: (children) => section(parts(children).slice(0, -1).map(put).join("")),
      hr: () => section(put({ type: "text", text: "———" })),
    },
    { noHtmlBlocks: true, noHtmlSpans: true },
  );

  const elements = parts(rendered).flatMap((part) =>
    "elements" in part
      ? [part]
      : [{ type: "rich_text_section" as const, elements: [part] }],
  );

  const nonempty = (items: Inline[]) =>
    items.filter((item) => !("text" in item) || item.text !== "");

  return {
    type: "rich_text" as const,
    elements: elements.flatMap((element): Exclude<Part, Inline>[] => {
      if (element.type === "rich_text_list") {
        const items = element.elements
          .map((item) => ({
            ...item,
            elements: controls(nonempty(item.elements)),
          }))
          .filter((item) => item.elements.length);

        return items.length ? [{ ...element, elements: items }] : [];
      }

      const content = nonempty(element.elements);

      return content.length
        ? [
            {
              ...element,
              elements:
                element.type === "rich_text_preformatted"
                  ? content
                  : controls(content),
            },
          ]
        : [];
    }),
  };
}

function uncertainFences(text: string) {
  let active: { marker: string; prefix: string } | undefined;

  for (const line of text.split(/\r?\n/)) {
    const match =
      /^([ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/.exec(
        line,
      );

    const prefix = match?.[1] ?? "";
    const marker = match?.[2];
    const info = match?.[3] ?? "";

    if (!marker) continue;

    if (!active && !(marker.startsWith("`") && info.includes("`")))
      active = { marker, prefix };
    else if (
      active &&
      prefix === active.prefix &&
      marker[0] === active.marker[0] &&
      marker.length >= active.marker.length &&
      !info.trim()
    )
      active = undefined;
  }

  return active !== undefined;
}

function uncertainInline(block: ReturnType<typeof structuredMarkdown>) {
  return block.elements.some((part) => {
    if (part.type === "rich_text_preformatted") return false;

    const elements =
      part.type === "rich_text_list"
        ? part.elements.flatMap((item) => item.elements)
        : part.elements;

    return elements.some(
      (element) =>
        element.type === "text" &&
        !element.style?.code &&
        element.text.includes("`"),
    );
  });
}

function classifyReply(text: string) {
  try {
    const block = structuredMarkdown(text);

    return uncertainFences(text) || uncertainInline(block) ? undefined : block;
  } catch {
    // Parser/resource failures must not turn uncertain source into mentions.
    return;
  }
}

function escaped(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plainContent(text: string) {
  return {
    text: escaped(text),
    blocks: [
      {
        type: "section" as const,
        text: { type: "plain_text" as const, text, emoji: false },
      },
    ],
  };
}

export function slackContent(
  text: string,
  format: "markdown" | "plain" = "markdown",
) {
  if (format === "plain") return plainContent(text);

  if (!slackControls.test(text))
    return {
      text: escaped(text),
      blocks: [{ type: "markdown" as const, text }],
    };
  const block = classifyReply(text);

  if (!block) return plainContent(text);

  return { text: escaped(text), blocks: [block] };
}

/** Literal controls built by trusted gateway UI, never classified model text. */
export type SlackPanelContent = {
  text: string;
  blocks: (
    | {
        type: "section";
        block_id?: string;
        text: { type: "plain_text"; text: string; emoji?: boolean };
      }
    | {
        type: "actions";
        block_id: string;
        elements: (
          | {
              type: "button";
              action_id: string;
              value: string;
              text: { type: "plain_text"; text: string; emoji?: boolean };
              accessibility_label?: string;
            }
          | {
              type: "checkboxes";
              action_id: string;
              options: {
                text: { type: "plain_text"; text: string; emoji?: boolean };
                value: string;
              }[];
            }
        )[];
      }
  )[];
};

export type SlackContent = ReturnType<typeof slackContent> | SlackPanelContent;

export type ReplyChunk =
  | string
  | { text: string; content: SlackContent; source?: string };

export function replyText(chunk: ReplyChunk) {
  return typeof chunk === "string" ? chunk : chunk.text;
}

/** Repair compares original Markdown, not formatted fallback text. */
export function replySource(chunks: ReplyChunk[]) {
  return chunks.some(
    (chunk) => typeof chunk !== "string" && chunk.source !== undefined,
  )
    ? chunks
        .map((chunk) =>
          typeof chunk === "string" ? chunk : (chunk.source ?? chunk.text),
        )
        .join("")
    : chunks.map(replyText).join("\n");
}

/** Split literal source, without interpreting code state in any chunk. */
function literalChunks(text: string) {
  const points = Array.from(text);
  const chunks: string[] = [];

  for (let start = 0; start < points.length;) {
    let end = Math.min(start + 2800, points.length);
    const opening = points.lastIndexOf("<", end - 1);

    if (opening > start && end - opening < 256) {
      const token = points
        .slice(opening, opening + 257)
        .join("")
        .match(/^<[@#][^<>\n]{1,254}>/u)?.[0];

      if (token && opening + Array.from(token).length > end) end = opening;
    }

    chunks.push(points.slice(start, end).join(""));
    start = end;
  }

  return chunks;
}

type RichBlock = ReturnType<typeof structuredMarkdown>;

type RichPart = RichBlock["elements"][number];

/** Parse and promote once on the FULL clean reply. The following packer only
 * copies classified elements; it never parses source or promotes controls. */
export function prepareSlackReply(
  source: string,
  unbounded = false,
): ReplyChunk[] {
  let text = source.trim() ? source : "Agent finished without a text reply.";
  const points = Array.from(text);

  if (!unbounded && points.length > 60_000)
    text =
      points.slice(0, 60_000).join("") + "\n[Response truncated by Stargate.]";

  // Ordinary replies keep main's native Markdown payload exactly. With no
  // Slack controls in the full source, no chunk can notify a mention.
  if (!slackControls.test(text))
    return markdownChunks(Array.from(text.trim())).map((part, index) => ({
      text: part,
      source: index ? "" : text,
      content: {
        text: escaped(part),
        blocks: [{ type: "markdown" as const, text: part }],
      },
    }));

  const plain = () =>
    literalChunks(text).map((part, index) => ({
      text: part,
      source: index ? "" : text,
      content: plainContent(part),
    }));

  const block = classifyReply(text);

  if (!block) return plain();

  const units = block.elements.flatMap(
    (part): { part: RichPart; elements: Inline[] }[] => {
      if (part.type !== "rich_text_list")
        return [{ part, elements: part.elements }];

      return part.elements.map((item, index) => ({
        part: {
          ...part,
          ...(part.style === "ordered"
            ? { offset: (part.offset ?? 0) + index }
            : {}),
          elements: [item],
        },
        elements: item.elements,
      }));
    },
  );

  const tooLongLink = units.some((unit) =>
    unit.elements.some(
      (element) =>
        element.type === "link" &&
        Array.from(element.url).length + Array.from(element.text).length > 2800,
    ),
  );

  if (tooLongLink) return plain();
  const result: ReplyChunk[] = [];
  let current: RichPart[] = [];
  let fallback = "";
  let used = 0;

  const flush = () => {
    if (!current.length) return;
    result.push({
      text: fallback,
      content: {
        text: escaped(fallback),
        blocks: [{ type: "rich_text", elements: current }],
      },
    });
    current = [];
    fallback = "";
    used = 0;
  };

  const inlineText = (element: Inline) => {
    switch (element.type) {
      case "user":
        return `<@${element.user_id}>`;
      case "channel":
        return `<#${element.channel_id}>`;
      default:
        return element.text;
    }
  };

  for (const unit of units) {
    let elements: Inline[] = [];

    const append = () => {
      if (!elements.length) return;

      const part: RichPart =
        unit.part.type === "rich_text_list"
          ? {
              ...unit.part,
              elements: [{ type: "rich_text_section", elements }],
            }
          : { ...unit.part, elements };

      current.push(part);
      elements = [];
    };

    if (used && used < 2800) {
      fallback += "\n";
      used++;
    }

    for (const element of unit.elements) {
      const value = inlineText(element);
      const chars = Array.from(value);

      if (element.type !== "text") {
        const cost =
          chars.length +
          (element.type === "link" ? Array.from(element.url).length : 0);

        if (used + cost > 2800) {
          append();
          flush();
        }

        elements.push(element);
        fallback += value;
        used += cost;
        continue;
      }

      for (let offset = 0; offset < chars.length;) {
        if (used === 2800) {
          append();
          flush();
        }

        const end = Math.min(chars.length, offset + 2800 - used);
        const piece = chars.slice(offset, end).join("");
        elements.push({ ...element, text: piece });
        fallback += piece;
        used += end - offset;
        offset = end;
      }
    }

    append();
  }

  flush();

  return result.length
    ? result.map((chunk, index) =>
        typeof chunk === "string"
          ? chunk
          : { ...chunk, source: index ? "" : text },
      )
    : plain();
}
