/**
 * Next release version from Conventional Commit subjects since the last tag.
 * Only user-facing changes release: `feat`, `fix`, `perf`, `revert`, breaking
 * changes, reverts and runtime dependency updates (exactly the `(deps)`
 * scope; `(deps-dev)` does not release). Other commits wait for the
 * next release, unless a manual run forces one. Before 1.0.0 a breaking
 * change bumps the minor version, as SemVer allows for initial development.
 */
export const firstVersion = "0.20.3";

type Bump = "none" | "major" | "minor" | "patch";
const order: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };
const patchTypes = new Set(["fix", "perf", "revert"]);

const subject =
  /^(?<type>[a-z]+)(?:\((?<scope>[^()\r\n]*)\))?(?<breaking>!)?: \S/;

export function bumpFor(message: string): Bump {
  const [first = "", ...body] = message.split("\n");
  // GitHub's default revert title: `Revert "feat: x (#1)"`. Undoing a change
  // is at least a patch, and as large as the change it reverts.
  const reverted = /^Revert "(?<inner>.+)"/.exec(first)?.groups?.["inner"];
  if (reverted !== undefined) {
    const inner = bumpFor(reverted);
    return inner === "none" ? "patch" : inner;
  }
  const parsed = subject.exec(first);
  if (
    parsed?.groups?.["breaking"] ||
    body.some((line) => /^BREAKING[ -]CHANGE: /.test(line))
  )
    return "major";
  const type = parsed?.groups?.["type"];
  if (type === "feat") return "minor";
  if (type && patchTypes.has(type)) return "patch";
  if (parsed?.groups?.["scope"] === "deps") return "patch";
  return "none";
}

/**
 * Next version, or undefined when nothing since `last` needs a release.
 * `force` releases at least a patch, for an operator-requested release.
 */
export function nextVersion(
  last: string | undefined,
  messages: readonly string[],
  force = false,
): string | undefined {
  if (last === undefined) return firstVersion;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(last);
  if (!match) throw new Error("Last release tag is not vMAJOR.MINOR.PATCH");
  let [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  let bump = messages
    .map(bumpFor)
    .reduce<Bump>((a, b) => (order[b] > order[a] ? b : a), "none");
  if (bump === "none") {
    if (!force || messages.length === 0) return undefined;
    bump = "patch";
  }
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
  const version = nextVersion(
    last,
    messages,
    process.env["FORCE_RELEASE"] === "true",
  );
  console.log(`version=${version ?? ""}`);
  if (version) {
    const notes = last
      ? releaseNotes(messages)
      : "First public release of Stargate under the MIT License.";
    await Bun.write("release-notes.md", `${notes}\n`);
  }
}
