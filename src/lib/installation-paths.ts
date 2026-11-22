import { join } from "node:path";
import { fileURLToPath } from "node:url";

export { default as packageManifest } from "../../package.json";

// Gateway/CLI paths only: import.meta must stay outside the crew plugin closure.
export const installationDirectory = fileURLToPath(
  new URL("../..", import.meta.url),
);

export const packageJsonPath = join(installationDirectory, "package.json");
export const templatesDirectory = join(installationDirectory, "templates");
export const assetsDirectory = join(installationDirectory, "assets");
export const mainEntrypoint = join(installationDirectory, "src", "main.ts");
