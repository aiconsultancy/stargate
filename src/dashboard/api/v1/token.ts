import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readToken(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });

  if (!file) return undefined;

  try {
    const info = await file.stat();

    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o600 ||
      info.size < 43 ||
      info.size > 44
    )
      throw new Error("Unsafe Fleet API token file");
    const buffer = Buffer.alloc(45);
    const { bytesRead } = await file.read(buffer);
    const contents = buffer.subarray(0, bytesRead).toString("utf8");

    if (!/^[A-Za-z0-9_-]{43}\n?$/.test(contents))
      throw new Error("Invalid Fleet API token file");

    return contents.slice(0, 43);
  } finally {
    await file.close();
  }
}

/** Create once across concurrent CLI and service starts, or atomically rotate. */
export async function apiToken(dataDirectory: string, rotate = false) {
  const path = join(dataDirectory, "api-token");

  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const parent = await stat(dataDirectory);

    if (
      !parent.isDirectory() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o022) !== 0
    )
      throw new Error("Unsafe Fleet API data directory");

    if (!rotate) {
      const existing = await readToken(path);

      if (existing) return existing;
    }

    const token = randomBytes(32).toString("base64url");
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);

    try {
      try {
        await file.chmod(0o600);
        await file.writeFile(`${token}\n`);
        await file.sync();
      } finally {
        await file.close();
      }

      if (rotate) await rename(temporary, path);
      else {
        try {
          await link(temporary, path);
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          const existing = await readToken(path);

          if (!existing) throw error;

          return existing;
        }
      }

      return token;
    } finally {
      await rm(temporary, { force: true });
    }
  } catch {
    throw new Error(
      "Cannot use Fleet API token. Check that dataDirectory is writable by the service user and api-token is a private mode-0600 file, or run stargate api token --rotate.",
    );
  }
}
