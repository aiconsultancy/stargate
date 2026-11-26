import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type Browser = {
  newContext(options: {
    offline: boolean;
    javaScriptEnabled: boolean;
    serviceWorkers: "block";
    viewport: { width: number; height: number };
  }): Promise<{
    route(
      pattern: string,
      handler: (route: { abort(): Promise<void> }) => Promise<void>,
    ): Promise<void>;
    newPage(): Promise<{
      setContent(
        html: string,
        options: { waitUntil: "load"; timeout: number },
      ): Promise<void>;
      evaluate<T>(operation: (offset: number) => T, offset: number): Promise<T>;
      screenshot(options: {
        type: "png";
        animations: "disabled";
        timeout: number;
      }): Promise<Uint8Array>;
    }>;
  }>;
  close(): Promise<void>;
};

type Chromium = {
  launch(options: {
    executablePath?: string;
    headless: boolean;
    chromiumSandbox: boolean;
    timeout: number;
  }): Promise<Browser>;
};

const viewport = { width: 880, height: 680 };
export const contentHeight = viewport.height - 55;
const inputLimit = 32_000;
const previewLimit = 22_000;

function escaped(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function previewHtml(source: string, name: string, page: number) {
  const plain = /\.(?:txt|text)$/i.test(name);

  const content = plain
    ? `<pre class="plain">${escaped(source)}</pre>`
    : Bun.markdown.html(source, {
        noHtmlBlocks: true,
        noHtmlSpans: true,
        tagFilter: true,
      });

  return `<!doctype html><html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>Document preview</title>
<style>
html { color: #111; background: #fff; scrollbar-width:none }
body { margin:0; font:17px/1.35 Arial, sans-serif; overflow-wrap:anywhere }
header { position:fixed; inset:0 0 auto; height:43px; padding:0 36px; display:flex; align-items:center;
  justify-content:space-between; background:#fff; border-bottom:2px solid #444 }
section { position:fixed; inset:55px 0 0; overflow:hidden }
main { display:flow-root; padding:0 36px }
h1,h2,h3 { margin:0.7em 0 0.25em; line-height:1.1 }
p,pre,ul,ol,table { margin:0.35em 0 0.65em }
pre { white-space:pre-wrap; border:1px solid #aaa; padding:7px }
.plain { padding:0; border:0; margin:0 }
a { color:inherit; text-decoration:underline } img { display:none }
table { width:100%; border-collapse:collapse }
main,blockquote,li { container-type:inline-size }
table:not(:has(th:nth-child(5))) th { min-width:min(8em, max(0px, calc(25cqi - 16px))) }
table:has(th:nth-child(5)):not(:has(th:nth-child(9))) th { min-width:min(3.5em, max(0px, calc(12.5cqi - 16px))) }
td,th { padding:3px 7px; border:1px solid #999 }
</style>
<header><strong>${escaped(name)}</strong><span>Document preview · page ${page}</span></header>
<section><main>${content}</main></section></html>`;
}

export async function indexedPreview(raw: Uint8Array) {
  for (const colors of [8, 4, 2]) {
    const result = await new Bun.Image(raw, {
      maxPixels: viewport.width * viewport.height,
    })
      .png({ palette: true, colors, dither: false, compressionLevel: 9 })
      .bytes();

    if (result.length <= previewLimit) {
      return result;
    }
  }

  throw new Error(
    "Preview is too dense for Teams. Use a shorter Markdown excerpt.",
  );
}

async function sourceText() {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.length;

    if (size > inputLimit) {
      throw new Error(
        "Provide at most 32 KB of Markdown or plain text on stdin.",
      );
    }

    chunks.push(chunk);
  }

  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks, size),
  );

  if (!source.trim()) {
    throw new Error("Provide Markdown or plain text on stdin.");
  }

  return source;
}

export type PreviewBrowser = {
  playwright: string;
  chromium?: string;
  browserCache?: string;
};

export async function renderMarkdownPreview(
  source: string,
  name: string,
  pageNumber: number,
  settings: PreviewBrowser,
) {
  if (
    Buffer.byteLength(source) > inputLimit ||
    source.trim().length === 0 ||
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > 100
  ) {
    throw new Error("Provide a bounded text document and valid page number.");
  }

  if (settings.browserCache) {
    process.env["PLAYWRIGHT_BROWSERS_PATH"] = settings.browserCache;
  }

  const playwright: unknown = await import(
    pathToFileURL(settings.playwright).href
  );

  const module = playwright as { chromium: Chromium };

  const config: Parameters<Chromium["launch"]>[0] = {
    headless: true,
    chromiumSandbox: true,
    timeout: 30_000,
  };

  if (settings.chromium) {
    config.executablePath = settings.chromium;
  }

  const browser = await module.chromium.launch(config);

  try {
    const context = await browser.newContext({
      offline: true,
      javaScriptEnabled: false,
      serviceWorkers: "block",
      viewport,
    });

    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();

    await page.setContent(previewHtml(source, name, pageNumber), {
      waitUntil: "load",
      timeout: 10_000,
    });

    const total = await page.evaluate(
      (offset) => {
        const content = globalThis.document.querySelector("main");

        if (!content) {
          throw new Error("Document content is unavailable.");
        }

        const height = content.getBoundingClientRect().height;
        content.style.transform = `translateY(${-offset}px)`;

        return height;
      },
      (pageNumber - 1) * contentHeight,
    );

    const pages = Math.max(1, Math.ceil(total / contentHeight));

    if (pageNumber > pages) {
      throw new Error("The requested page is outside this document.");
    }

    const raw = await page.screenshot({
      type: "png",
      animations: "disabled",
      timeout: 10_000,
    });

    const preview = await indexedPreview(raw);

    return { preview, pages };
  } finally {
    await browser.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      playwright: { type: "string" },
      chromium: { type: "string" },
      output: { type: "string" },
      name: { type: "string" },
      page: { type: "string", default: "1" },
    },
  });

  const pageNumber = Number(values.page);

  if (
    !values.playwright?.startsWith("/") ||
    !values.output?.endsWith(".png") ||
    !values.name ||
    !/^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,119}$/.test(values.name) ||
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > 100
  ) {
    throw new Error(
      "Provide --playwright MODULE, --name FILE, --output PREVIEW.png and optional --page NUMBER.",
    );
  }

  const source = await sourceText();
  const settings: PreviewBrowser = { playwright: values.playwright };

  if (values.chromium) {
    settings.chromium = values.chromium;
  }

  const { preview, pages } = await renderMarkdownPreview(
    source,
    values.name,
    pageNumber,
    settings,
  );

  await writeFile(values.output, preview, { flag: "wx", mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({
      fileName: values.name,
      output: values.output,
      page: pageNumber,
      pages,
      sizeBytes: preview.length,
      contentType: "image/png",
    })}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    process.stderr.write(
      "Could not render the offline Markdown preview. Check the input, page and browser settings.\n",
    );
    process.exitCode = 1;
  }
}
