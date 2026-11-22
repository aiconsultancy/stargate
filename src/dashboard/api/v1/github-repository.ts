import { containsCredential } from "../../../lib/credentials";

// config.ts imports this module, so it is part of the crew plugin's import
// closure. Keep it free of module-location lookups (the "import" + ".meta"
// form): the plugin digest treats any file containing that text as unknown.

export function githubRepository(remote: string): string | null {
  const scp = /^(?:[^@/:\s]+@)?github\.com:([^\s]+)$/i.exec(remote);
  const url = URL.parse(remote);
  const path =
    scp?.[1] ??
    (url &&
    ["https:", "ssh:", "git:", "http:"].includes(url.protocol) &&
    url.hostname.toLowerCase() === "github.com" &&
    !url.search &&
    !url.hash
      ? url.pathname.slice(1)
      : "");
  const repo = path.replace(/\/$/, "").replace(/\.git$/, "");
  return isGitHubRepositoryName(repo) ? repo : null;
}

export function isGitHubRepositoryName(repo: string) {
  return (
    /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repo) &&
    !/\/\.{1,2}$/.test(repo) &&
    !containsCredential(repo)
  );
}
