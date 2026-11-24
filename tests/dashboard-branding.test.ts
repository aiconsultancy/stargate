import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import pino from "pino";
import { dashboardHandler } from "../src/observability/dashboard/dashboard";
import { dashboardBranding } from "../src/observability/dashboard/dashboard-branding";
import type { DashboardSource } from "../src/observability/dashboard/dashboard-model";

const source: DashboardSource = {
  fleet: async () => ({ generatedAt: 1, ships: [] }),
  ship: async () => undefined,
  children: async () => undefined,
  entries: async () => undefined,
};

function handler(html: string) {
  return dashboardHandler({
    html,
    source,
    signal: new AbortController().signal,
    log: pino({ enabled: false }),
  });
}

async function icon(name: string) {
  return `data:image/png;base64,${(await readFile(new URL(`../assets/icons/${name}`, import.meta.url))).toString("base64")}`;
}

function link(href: string, extra = "") {
  return `<link rel="icon" type="image/png" sizes="32x32" href="${href}"${extra}>`;
}

test("dashboard branding reuses exact packaged pixels and keeps both themes self-contained", async () => {
  const template = await readFile(
    new URL("../templates/dashboard/index.html", import.meta.url),
    "utf8",
  );

  const get = handler(template);
  const page = await get(new Request("http://dashboard/"));
  const html = await page.text();
  expect(page.status).toBe(200);
  expect(html).not.toContain("{{stargate-");
  expect(html).toContain('class="brand" href="#/" aria-label="Stargate fleet"');

  for (const variant of ["dark", "light"]) {
    expect(html).toContain(
      `class="brand-${variant}" src="${await icon(`stargate-${variant}-64.png`)}" width="32" height="32" alt=""`,
    );
    expect(html).toContain(
      `href="${await icon(`stargate-${variant}-32.png`)}"`,
    );
  }

  const policy = page.headers.get("Content-Security-Policy");
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("img-src 'self' data:");
  expect(policy).not.toContain("unsafe-inline");
  const head = await get(new Request("http://dashboard/", { method: "HEAD" }));
  expect([...head.headers]).toEqual([...page.headers]);
  expect(await head.text()).toBe("");

  for (const path of ["/favicon.ico", "/assets/icons/stargate-dark-32.png"]) {
    const response = await get(new Request(`http://dashboard${path}`));
    expect(response.status).toBe(404);
  }
});

test("favicon admission permits only the two exact bundled 32px icons with controlled attributes", async () => {
  for (const variant of ["dark", "light"]) {
    const png = await icon(`stargate-${variant}-32.png`);

    for (const media of ["", ' media="(prefers-color-scheme: dark)"']) {
      const html = link(png, media);
      const response = await handler(html)(new Request("http://dashboard/"));
      expect(await response.text()).toBe(html);
    }
  }
});

test("favicon admission never permits arbitrary data URLs, local paths, links or new attributes", async () => {
  const png = await icon("stargate-dark-32.png");
  const allowed = link(png);

  const refused = [
    link("/favicon.ico"),
    link("https://outside/icon.png"),
    link("data:image/png;base64,dW50cnVzdGVk"),
    link("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"),
    link(await icon("stargate-dark-64.png")),
    link(`${png}#different`),
    allowed.replace('rel="icon"', 'rel="stylesheet"'),
    allowed.replace('rel="icon"', 'rel="shortcut icon"'),
    allowed.replace('type="image/png"', 'type="image/svg+xml"'),
    allowed.replace('sizes="32x32"', 'sizes="64x64"'),
    link(png, ' media="all"'),
    link(png, ' src="/other"'),
    link(png, ' nonce="other"'),
    link(png, ' onload="bad()"'),
    `<link rel="stylesheet" href="${png}">`,
  ];

  for (const html of refused) {
    expect(() => handler(html), html).toThrow("self-contained");
  }
});

test("branding leaves custom self-contained HTML untouched and expands only known tokens", () => {
  const html = "<!doctype html><title>Local operator view</title>";
  expect(dashboardBranding(html)).toBe(html);
  expect(dashboardBranding("{{other-icon}}")).toBe("{{other-icon}}");
});

test("the social preview embeds the unchanged SVG and includes a local 1280x640 rendering", async () => {
  const svg = await readFile(
    new URL("../assets/icons/stargate-social-preview.svg", import.meta.url),
    "utf8",
  );

  const embedded = /href="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/.exec(
    svg,
  )?.[1];

  if (!embedded) {
    throw new Error("Social preview has no embedded source logo");
  }

  expect(Buffer.from(embedded, "base64")).toEqual(
    await readFile(
      new URL("../assets/icons/stargate-dark.svg", import.meta.url),
    ),
  );

  const png = await readFile(
    new URL("../assets/icons/stargate-social-preview.png", import.meta.url),
  );

  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 640]);
});
