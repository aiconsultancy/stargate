import { execFileSync } from "node:child_process";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { inspect, scoped } from "./hooks/touched-zod";
import { hardModeConfig, lintRoots } from "./hard-mode-config";

async function check() {
  const { zod } = await hardModeConfig();

  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...lintRoots], {
    encoding: "utf8",
  }).split("\0");

  const excluded = new Set(zod);

  const paths = [...new Set(tracked)].filter(
    (path) => scoped(path) || excluded.has(path),
  );

  const sources: Record<string, string> = {};
  const present = new Map<string, string>();

  for (const path of paths) {
    const file = Bun.file(path);

    if (!(await file.exists())) continue;
    const key = `/lint-zod/file-${present.size}.ts`;
    present.set(path, key);
    sources[key] = await file.text();
  }

  const config = "/lint-zod/tsconfig.json";

  const api = new API({
    cwd: "/",
    fs: createVirtualFileSystem({
      ...sources,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: Object.keys(sources),
      }),
    }),
  });

  const failures = zod
    .filter((path) => !present.has(path))
    .map((path) => `${path} is missing or untracked`);

  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });

    try {
      const program = snapshot.getProjects()[0]?.program;

      if (!program) throw new Error("cannot load TypeScript parser");

      for (const [path, key] of present) {
        const source = await program.getSourceFile(key);

        if (!source) throw new Error(`cannot parse ${path}`);
        const usesZod = inspect(source).zod;

        if (excluded.has(path) && !usesZod)
          failures.push(`${path} no longer imports Zod`);

        if (scoped(path) && usesZod && !excluded.has(path))
          failures.push(`${path} imports Zod but is not in the exclusions`);
      }
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }

  if (failures.length) throw new Error(failures.sort().join("\n"));
}

try {
  await check();
} catch (error) {
  console.error(
    `Zod lint exclusions: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
