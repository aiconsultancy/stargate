import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  contentHeight,
  indexedPreview,
  previewHtml,
  renderMarkdownPreview,
} from "../scripts/markdown-preview";

test("Markdown previews label the source and isolate rendered content", () => {
  const body = previewHtml(
    "# Result\n\n- Verified\n\n<script>alert(4)</script>",
    "Example <notes>.md",
    2,
  );

  expect(body).toContain("Example &lt;notes&gt;.md");
  expect(body).toContain("Document preview · page 2");
  expect(body).toContain("<h1>Result</h1>");
  expect(body).toContain("<li>Verified</li>");
  expect(body).toContain("default-src 'none'");
  expect(body).not.toContain("<script>");
});

test("bounded Teams previews use indexed PNG output", async () => {
  const stub = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );

  const png = await indexedPreview(stub);

  expect(png.length).toBeLessThanOrEqual(22_000);
  expect(png[25]).toBe(3);
});

test("plain-text previews retain literal Markdown characters and whitespace", () => {
  const body = previewHtml(
    "# No heading\n  * literal\n<script>\n",
    "source.TXT",
    1,
  );

  expect(body).toContain(
    '<pre class="plain"># No heading\n  * literal\n&lt;script&gt;\n</pre>',
  );
  expect(body).not.toContain("<h1>");
  expect(body).not.toContain("<li>");
});

test("the short final page starts exactly one page lower with no preceding lines", async () => {
  const directory = mkdtempSync(join(tmpdir(), "preview-page-"));
  const browser = join(directory, "browser.ts");

  try {
    writeFileSync(
      browser,
      `export const chromium = { async launch() {
      return { async close(){}, async newContext() { return { async route() {},
        async newPage() { return { async setContent() {},
          async evaluate(operation, offset) {
            const style = {};
            const content = { style, getBoundingClientRect: () => ({ height: ${contentHeight + 25} }) };
            globalThis.document = { querySelector: (selector) => selector === "main" && content };
            try {
              const result = operation(offset);
              if (style.transform !== "translateY(-${contentHeight}px)") throw new Error("wrong page offset");
              return result;
            } finally { delete globalThis.document; }
          },
          async screenshot() { return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"); }
        }; }
      }; } };
    } };`,
    );
    expect(
      await renderMarkdownPreview("fixture", "fixture.txt", 2, {
        playwright: browser,
      }),
    ).toMatchObject({ pages: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
