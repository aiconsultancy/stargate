/**
 * Next release version from Conventional Commit subjects since the last tag.
 * Every merge to main is released. Before 1.0.0 a breaking change bumps the
 * minor version, as SemVer allows for initial development.
 */
export const firstVersion = "0.1.0";

type Bump = "major" | "minor" | "patch";
const order: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

const subject = /^(?<type>[a-z]+)(?:\([^()\r\n]*\))?(?<breaking>!)?: \S/;

export function bumpFor(message: string): Bump {
  const [first = "", ...body] = message.split("\n");
  const parsed = subject.exec(first);
  if (
    parsed?.groups?.["breaking"] ||
    body.some((line) => /^BREAKING[ -]CHANGE: /.test(line))
  )
    return "major";
  if (parsed?.groups?.["type"] === "feat") return "minor";
  return "patch";
}

export function nextVersion(
  last: string | undefined,
  messages: readonly string[],
): string {
  if (last === undefined) return firstVersion;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(last);
  if (!match) throw new Error("Last release tag is not vMAJOR.MINOR.PATCH");
  let [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const bump = messages
    .map(bumpFor)
    .reduce<Bump>((a, b) => (order[b] > order[a] ? b : a), "patch");
  if (bump === "major" && major > 0) return `${major + 1}.0.0`;
  if (bump === "major" || bump === "minor") return `${major}.${minor + 1}.0`;
  patch += 1;
  return `${major}.${minor}.${patch}`;
}

/** Release notes: one line per commit subject, newest first. */
export function releaseNotes(messages: readonly string[]) {
  return messages
    .map((message) => `- ${message.split("\n")[0]?.trim()}`)
    .join("\n");
}

async function git(...args: string[]) {
  const process = Bun.spawn(["git", ...args], { stdout: "pipe" });
  const text = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error(`git ${args[0]} failed`);
  return text;
}

if (import.meta.main) {
  const tags = (await git("tag", "--list", "v*.*.*", "--sort=-v:refname"))
    .split("\n")
    .filter(Boolean);
  const last = tags[0];
  const range = last ? `${last}..HEAD` : "HEAD";
  const messages = (await git("log", "--format=%B%x00", range))
    .split("\0")
    .map((message) => message.trim())
    .filter(Boolean);
  if (last && messages.length === 0) {
    console.log("version=");
  } else {
    const version = nextVersion(last, messages);
    console.log(`version=${version}`);
    await Bun.write("release-notes.md", `${releaseNotes(messages)}\n`);
  }
}
