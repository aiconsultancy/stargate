import { expect, test } from "bun:test";
import { indexedPreview, previewHtml } from "../scripts/markdown-preview";

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
