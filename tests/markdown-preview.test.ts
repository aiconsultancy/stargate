import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const testChromium = process.env["STARGATE_TEST_CHROMIUM"];

test.skipIf(!testChromium)(
  "Markdown table labels stay legible and dense values remain reachable",
  async () => {
    if (!testChromium) {
      throw new Error("Chromium is required for this test");
    }

    const { chromium } = await import("playwright-core");

    const browser = await chromium.launch({
      executablePath: testChromium,
      chromiumSandbox: true,
    });

    try {
      const page = await browser.newPage({
        viewport: { width: 880, height: 680 },
        javaScriptEnabled: false,
        offline: true,
      });

      const nested = [
        "> > > > | A | B | C | D |",
        "> > > > | --- | --- | --- | --- |",
        "> > > > | one | two | three | four |",
      ].join("\n");

      await page.setContent(previewHtml(nested, "nested.md", 1));

      const nestedFits = await page.evaluate(() => {
        const table = document.querySelector("blockquote table");
        const bounds = table?.parentElement?.getBoundingClientRect();

        return (
          !!bounds &&
          !!table &&
          table.getBoundingClientRect().right <= bounds.right + 1
        );
      });

      expect(nestedFits).toBe(true);

      // Long values in wider tables must fit within the 100-page limit.
      for (const columns of [4, 8, 12]) {
        const labels = [
          "Selector",
          "Property",
          ...Array<string>(columns - 2).fill("Value"),
        ];

        const row = [
          "code",
          "--accent",
          ...Array<string>(columns - 3).fill("x"),
          "W".repeat(30_000),
        ];

        const source = [
          labels,
          labels.map(() => "---"),
          row,
          labels.map(() => "last"),
        ]
          .map((cells) => `| ${cells.join(" | ")} |`)
          .join("\n");

        await page.setContent(previewHtml(source, "changes.md", 1));

        const layout = await page.evaluate(() => {
          const main = document.querySelector("main");
          const lastRow = document.querySelector("tbody tr:last-child");
          const headers = Array.from(document.querySelectorAll("th"));

          if (!main || !lastRow) {
            throw new Error("Missing table");
          }

          return {
            widths: headers.map((cell) => cell.getBoundingClientRect().width),
            fitsPage: main.scrollWidth === main.clientWidth,
            lastBottom:
              lastRow.getBoundingClientRect().bottom -
              main.getBoundingClientRect().top,
          };
        });

        expect(layout.fitsPage).toBe(true);
        expect(layout.widths).toHaveLength(columns);

        if (columns === 4) {
          expect(Math.min(...layout.widths)).toBeGreaterThan(140);
        }

        const lastPage = Math.ceil(layout.lastBottom / contentHeight);
        expect(lastPage).toBeGreaterThan(1);
        expect(lastPage).toBeLessThanOrEqual(100);

        const result = await renderMarkdownPreview(
          source,
          "changes.md",
          lastPage,
          {
            playwright: fileURLToPath(import.meta.resolve("playwright-core")),
            chromium: testChromium,
          },
        );

        expect(result.pages).toBe(lastPage);
        expect(result.preview.length).toBeLessThanOrEqual(22_000);
      }
    } finally {
      await browser.close();
    }
  },
  30_000,
);

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
