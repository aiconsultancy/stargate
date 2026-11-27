import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

export const previewNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const previewName = Schema.String.check(
  Schema.isPattern(previewNamePattern),
);

const segments = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/;

const assets =
  /\.(html|css|m?js|json|webmanifest|txt|svg|png|jpe?g|gif|webp|ico|avif|woff2?|ttf|mp4|webm|mp3|wav)$/i;

const maxFiles = 256;
const maxBytes = 10 * 1024 * 1024;
export const maxRequestBytes = Math.ceil((maxBytes * 4) / 3) + maxFiles * 1024;

export const bundleSchema = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    base64: Schema.String,
  }),
).check(Schema.isMaxLength(maxFiles));

type Bundle = typeof bundleSchema.Type;

export class PreviewRefused extends Error {}

function checkPath(path: string) {
  const parts = path.split("/");

  if (
    parts.length > 8 ||
    parts.some((part) => !segments.test(part)) ||
    !assets.test(path)
  ) {
    throw new PreviewRefused(
      "Use ordinary static asset names, with up to eight path components.",
    );
  }
}

export function decodeBundle(bundle: Bundle) {
  let total = 0;
  const files = new Map<string, Buffer>();

  for (const file of bundle) {
    checkPath(file.path);

    if (files.has(file.path)) {
      throw new PreviewRefused("The bundle contains a duplicate asset.");
    }

    if (
      !/^(?:[A-Za-z0-9+/]*={0,2})$/.test(file.base64) ||
      file.base64.length % 4
    ) {
      throw new PreviewRefused("The bundle contains invalid asset data.");
    }

    const data = Buffer.from(file.base64, "base64");
    total += data.length;

    if (total > maxBytes) {
      throw new PreviewRefused(
        "A preview can contain at most 10 MiB of assets.",
      );
    }

    files.set(file.path, data);
  }

  if (!files.get("index.html")?.length) {
    throw new PreviewRefused(
      "Put a non-empty index.html at the root of the bundle.",
    );
  }

  for (const path of files.keys()) {
    const parts = path.split("/");

    while (parts.length > 1) {
      parts.pop();

      if (files.has(parts.join("/"))) {
        throw new PreviewRefused("An asset name is also used as a directory.");
      }
    }
  }

  return files;
}

export async function readBundle(
  staging: string,
  name: string,
  signal: AbortSignal,
) {
  const root = join(staging, name);
  const files: Bundle[number][] = [];
  let total = 0;

  async function walk(directory: string, prefix: string, depth: number) {
    signal.throwIfAborted();

    if (depth > 7 || !(await lstat(directory)).isDirectory()) {
      throw new PreviewRefused(
        "Stage the bundle in a real directory, without symlinks.",
      );
    }

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const local = join(directory, entry.name);

      if (!segments.test(entry.name)) {
        throw new PreviewRefused(
          "Remove hidden files and directories from the staged bundle.",
        );
      }

      if (entry.isDirectory()) {
        await walk(local, path, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        throw new PreviewRefused(
          "The staged bundle must contain regular files and directories only.",
        );
      }

      // Source maps can embed the original source. Keep them out of the served copy.
      if (/\.(css|m?js)\.map$/i.test(path)) {
        continue;
      }

      checkPath(path);
      signal.throwIfAborted();

      if (files.length >= maxFiles) {
        throw new PreviewRefused("A preview can contain at most 256 assets.");
      }

      const file = await open(
        local,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );

      try {
        const info = await file.stat();

        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > maxBytes - total
        ) {
          throw new PreviewRefused(
            "Use regular files without hard links and keep the bundle under 10 MiB.",
          );
        }

        const data = Buffer.alloc(info.size + 1);
        const { bytesRead } = await file.read(data, 0, data.length, 0);

        if (bytesRead !== info.size) {
          throw new PreviewRefused(
            "A staged asset changed during publication. Try again after the build finishes.",
          );
        }

        total += bytesRead;
        files.push({
          path,
          base64: data.subarray(0, bytesRead).toString("base64"),
        });
      } finally {
        await file.close();
      }
    }
  }

  if (!(await lstat(staging)).isDirectory()) {
    throw new PreviewRefused(
      "The mockup staging directory must be a real directory.",
    );
  }

  await walk(root, "", 0);

  return files;
}
