import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetsDirectory } from "../../lib/installation-paths";

// Fixed package assets only. No configuration or request can select a file.
const png = (name: string) =>
  `data:image/png;base64,${readFileSync(join(assetsDirectory, "icons", name)).toString("base64")}`;

const artwork = {
  "{{stargate-logo-dark}}": png("stargate-dark-64.png"),
  "{{stargate-logo-light}}": png("stargate-light-64.png"),
  "{{stargate-favicon-dark}}": png("stargate-dark-32.png"),
  "{{stargate-favicon-light}}": png("stargate-light-32.png"),
};

const favicons = new Set([
  artwork["{{stargate-favicon-dark}}"],
  artwork["{{stargate-favicon-light}}"],
]);

/** Keep the dashboard self-contained without copying or redrawing its logo. */
export function dashboardBranding(htmlInput: string): string {
  let html = htmlInput;

  for (const [token, image] of Object.entries(artwork))
    html = html.replaceAll(token, image);

  return html;
}

/** This permits the two bundled icons, never arbitrary data URLs or files. */
export function isDashboardFavicon(value: string): boolean {
  return favicons.has(value);
}
