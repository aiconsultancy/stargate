import { lstat, mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

/** Keep default/no-root attachment checks outside hidden staging ancestors. */
export async function ordinaryFileDirectory(prefix: string) {
  let parent = await realpath(tmpdir());

  while (parent.split(sep).some((part) => part.startsWith(".")))
    parent = dirname(parent);
  const info = await stat(parent);

  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error("File fixtures require an owned nonhidden temp ancestor");

  return mkdtemp(join(parent, prefix));
}

/** Prepare only a private run's scratch child, never shared /tmp/opencode. */
export async function publishedFileDirectory(prefix: string) {
  const parent = await realpath(tmpdir());
  const info = await stat(parent);

  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Publisher fixtures require a private owned TMPDIR");
  const scratch = join(parent, "opencode");
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const child = await lstat(scratch);

  if (
    !child.isDirectory() ||
    child.uid !== info.uid ||
    (child.mode & 0o077) !== 0
  )
    throw new Error("Publisher scratch must be a private owned directory");

  return mkdtemp(join(scratch, prefix));
}
