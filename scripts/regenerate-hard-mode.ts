import { execFileSync } from "node:child_process";

function git(...args: string[]) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

const [, , option, patch, ...extra] = process.argv;

if (
  (option !== undefined && (option !== "--tool-patch" || !patch)) ||
  extra.length > 0
) {
  throw new Error(
    "Usage: bun scripts/regenerate-hard-mode.ts [--tool-patch /path/to/tool.patch]",
  );
}

if (git("rev-parse", "--show-prefix").trim())
  throw new Error("Run from the repository root");

const branch = git("branch", "--show-current").trim();

if (!branch || branch === "main" || branch === "master")
  throw new Error("Use a feature branch");

const status = ["status", "--porcelain=v1", "--untracked-files=all"];

if (git(...status))
  throw new Error("Refusing to regenerate from a dirty checkout");

if (patch) {
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    throw new Error(
      "Fetch origin/main and start the feature branch at that exact revision",
    );
  }

  git("apply", "--check", "--index", "--", patch);
  git("apply", "--index", "--", patch);
}

const bun = (...args: string[]) =>
  execFileSync(process.execPath, args, { stdio: "inherit" });

const format = () => bun("run", "format");

const diff = () => git("diff", "--no-ext-diff", "--no-textconv", "--binary");
const index = git("write-tree");

format();

const first = diff();
const firstStatus = git(...status);

format();

if (
  first !== diff() ||
  firstStatus !== git(...status) ||
  index !== git("write-tree")
) {
  throw new Error("The second format run changed the candidate");
}

if (firstStatus.split("\n").some((line) => line.startsWith("?? "))) {
  throw new Error("Formatting created untracked paths");
}

git("diff", "--check");

const folders = new Map<
  string,
  { files: number; added: number; removed: number }
>();

for (const row of git("diff", "--numstat", "--no-renames", "-z")
  .split("\0")
  .filter(Boolean)) {
  const match = /^(\d+)\t(\d+)\t(.+)$/s.exec(row);

  if (!match?.[3]) throw new Error(`Unexpected non-text change: ${row}`);
  const folder = match[3].includes("/") ? (match[3].split("/")[0] ?? ".") : ".";
  const counts = folders.get(folder) ?? { files: 0, added: 0, removed: 0 };
  counts.files++;
  counts.added += Number(match[1]);
  counts.removed += Number(match[2]);
  folders.set(folder, counts);
}

for (const [folder, { files, added, removed }] of [...folders].toSorted()) {
  console.log(`${folder}: ${files} files, +${added}/-${removed}`);
}

console.log(
  "Second format run made no changes. Review and stage the sweep separately.",
);
