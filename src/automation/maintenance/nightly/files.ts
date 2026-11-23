import {
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Replace a file's contents atomically. A symlinked path (for example a
 * dotfiles-managed config) is resolved first, so the link stays a link and
 * its real target receives the new contents with its existing mode.
 */
export async function atomicWrite(
  path: string,
  content: string,
  mode?: number,
) {
  const real = await realpath(path).catch(() => path);
  const current = await stat(real).catch(() => null);

  const temp = join(
    dirname(real),
    `.${basename(real)}.stargate-${process.pid}`,
  );

  await writeFile(temp, content, {
    flag: "w",
    mode: mode ?? (current ? current.mode & 0o777 : 0o600),
  });

  try {
    await rename(temp, real);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Atomically point `path` at `target` (a new symlink replaces the old one). */
export async function replaceLink(path: string, target: string) {
  const temp = `${path}.new-${process.pid}`;
  await unlink(temp).catch(() => {});
  await symlink(target, temp);

  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** ENOENT is the only "absent"; any other failure is reported to the caller. */
export async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
