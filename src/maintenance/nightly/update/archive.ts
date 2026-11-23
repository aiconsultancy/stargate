import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { StepError } from "../exec";

/**
 * Release archives are validated from their own headers before `tar` sees
 * them. Only what `git archive` and Go's tar writer produce is accepted:
 * POSIX ustar (or old-GNU headers with an empty GNU area) for regular
 * files, directories and contained symlinks; per-file pax headers with `path`/`linkpath` only; and, as the
 * first header, git's global pax header carrying only a commit ID
 * `comment`. Global pax keys that tar would apply to later entries, GNU
 * long names, sparse files, hard links, devices, FIFOs, absolute paths,
 * `..`, duplicates, entries below a symlink and links that leave the root
 * are rejected. After extraction, `verifyExtracted` checks the tree again.
 */
export type ArchiveEntry = {
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  size: number;
  link?: string;
};

const invalid = () => new StepError("archive-invalid");
const maxUnpacked = 1024 * 1024 * 1024;

function text(block: Uint8Array, start: number, length: number) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);

  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

function octal(block: Uint8Array, start: number, length: number) {
  // Base-256 sizes (high bit set) only occur for files above 8 GiB.
  if ((block[start] ?? 0) & 0x80) throw invalid();

  const value = text(block, start, length)
    .replace(/[ \0]+$/, "")
    .trim();

  if (!/^[0-7]*$/.test(value)) throw invalid();

  return value ? Number.parseInt(value, 8) : 0;
}

function checksum(block: Uint8Array) {
  let sum = 0;

  for (let i = 0; i < 512; i++)
    sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);

  return sum;
}

function paxRecords(data: Uint8Array) {
  const records: Record<string, string> = {};

  if (data.at(-1) !== 10) throw invalid();
  let offset = 0;

  while (offset < data.length) {
    const space = data.indexOf(32, offset);

    if (space === -1) throw invalid();

    const length = Number(
      new TextDecoder().decode(data.subarray(offset, space)),
    );

    if (
      !Number.isInteger(length) ||
      length <= 0 ||
      offset + length > data.length
    )
      throw invalid();

    const record = new TextDecoder().decode(
      data.subarray(space + 1, offset + length - 1),
    );

    const equals = record.indexOf("=");

    if (equals === -1) throw invalid();
    const key = record.slice(0, equals);

    if (Object.hasOwn(records, key)) throw invalid();
    records[key] = record.slice(equals + 1);
    offset += length;
  }

  return records;
}

/** Parse a gzip-compressed ustar/pax archive. Never extracts anything. */
export function readArchive(
  compressed: Uint8Array,
  maxBytes = maxUnpacked,
): ArchiveEntry[] {
  let tar: Uint8Array;

  try {
    // Caps what tar can write: every entry's data must lie inside this
    // Stream, and pax keys or sparse headers that change sizes are refused.
    tar = gunzipSync(compressed, { maxOutputLength: maxBytes });
  } catch {
    throw invalid();
  }

  const entries: ArchiveEntry[] = [];
  let pax: Record<string, string> | undefined;
  let offset = 0;

  for (let index = 0; ; index++) {
    if (offset + 512 > tar.length) throw invalid();
    const block = tar.subarray(offset, offset + 512);

    if (block.every((byte) => byte === 0)) break;

    if (octal(block, 148, 8) !== checksum(block)) throw invalid();
    // POSIX ustar ("ustar\0" "00", git archive), or old GNU ("ustar  \0",
    // Go/GoReleaser) with its atime/ctime/sparse/realsize area all zero:
    // GNU tar reads sparse maps from that area.
    const magic = new TextDecoder("latin1").decode(block.subarray(257, 265));
    const gnu = magic === "ustar  \0";

    if (magic !== "ustar\u000000" && !gnu) throw invalid();

    if (gnu && block.subarray(345, 500).some((byte) => byte !== 0))
      throw invalid();
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const data = offset + 512;
    const next = data + Math.ceil(size / 512) * 512;

    if (next > tar.length) throw invalid();
    offset = next;

    if ((type === "g" || type === "x") && gnu) throw invalid();

    if (type === "g") {
      // Only git archive's leading commit comment; tar would apply any
      // Other global key (path, linkpath, size, GNU.sparse.*) to every entry.
      const records = paxRecords(tar.subarray(data, data + size));
      const keys = Object.keys(records);

      if (
        index !== 0 ||
        keys.length !== 1 ||
        keys[0] !== "comment" ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(records["comment"] ?? "")
      )
        throw invalid();
      continue;
    }

    if (type === "x") {
      if (pax) throw invalid();
      pax = paxRecords(tar.subarray(data, data + size));

      if (Object.keys(pax).some((key) => key !== "path" && key !== "linkpath"))
        throw invalid();
      continue;
    }

    const prefix = gnu ? "" : text(block, 345, 155);
    const name = text(block, 0, 100);
    const path = pax?.["path"] ?? (prefix ? `${prefix}/${name}` : name);
    const link = pax?.["linkpath"] ?? text(block, 157, 100);
    const own = pax;
    pax = undefined;
    const mode = octal(block, 100, 8);

    if (type === "0" || type === "\0") {
      if (own?.["linkpath"] !== undefined) throw invalid();
      entries.push({ path, type: "file", mode, size });
    } else if (type === "5" && size === 0 && own?.["linkpath"] === undefined)
      entries.push({ path, type: "directory", mode, size: 0 });
    else if (type === "2" && size === 0)
      entries.push({ path, type: "symlink", mode, size: 0, link });
    else throw invalid();
  }

  if (pax) throw invalid();

  return entries;
}

/** Normalised relative path, or an error for anything unsafe. */
function clean(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\")
  )
    throw invalid();
  const parts = path.replace(/\/+$/, "").split("/");

  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw invalid();

  return parts.join("/");
}

/**
 * `root`: every entry must be inside one real directory with this exact
 * name, and the archive must contain that directory entry itself.
 */
export function validateArchive(
  entries: readonly ArchiveEntry[],
  root?: string,
) {
  if (entries.length === 0) throw invalid();
  const seen = new Map<string, ArchiveEntry["type"]>();

  for (const entry of entries) {
    const path = clean(entry.path);

    if (seen.has(path)) throw invalid();
    seen.set(path, entry.type);

    if (root !== undefined && path !== root && !path.startsWith(`${root}/`))
      throw invalid();
  }

  if (root !== undefined && seen.get(root) !== "directory") throw invalid();

  for (const entry of entries) {
    const path = clean(entry.path);
    const parts = path.split("/");

    // Nothing may be written through a symlink created by the archive.
    for (let i = 1; i < parts.length; i++)
      if (seen.get(parts.slice(0, i).join("/")) === "symlink") throw invalid();

    if (entry.type !== "symlink") continue;
    const link = entry.link ?? "";

    if (!link || link.startsWith("/") || link.includes("\0")) throw invalid();
    const target = posix.normalize(posix.join(posix.dirname(path), link));

    if (target === ".." || target.startsWith("../") || target.startsWith("/"))
      throw invalid();

    if (root !== undefined && target !== root && !target.startsWith(`${root}/`))
      throw invalid();
  }

  return entries;
}

export async function inspectArchive(
  path: string,
  root?: string,
  maxBytes = maxUnpacked,
) {
  return validateArchive(
    readArchive(new Uint8Array(await Bun.file(path).arrayBuffer()), maxBytes),
    root,
  );
}

/**
 * After `tar` ran: the extracted tree under `directory` must contain only
 * validated entries (and directories that contain them), with the same
 * types, the same link targets and no hard links. Checked with lstat, so
 * nothing is followed. Then every link is resolved through its whole chain
 * (realpath): a chain of links that each look contained can still leave the
 * tree, and a dangling link may later point anywhere. Both are refused; the
 * release root must contain every link's final target.
 */
export async function verifyExtracted(
  directory: string,
  entries: readonly ArchiveEntry[],
  root?: string,
) {
  const links: string[] = [];
  const expected = new Map<string, ArchiveEntry>();
  const parents = new Set<string>();

  for (const entry of entries) {
    const path = clean(entry.path);
    expected.set(path, entry);
    const parts = path.split("/");

    for (let i = 1; i < parts.length; i++)
      parents.add(parts.slice(0, i).join("/"));
  }

  const walk = async (path: string): Promise<void> => {
    for (const name of await readdir(path)) {
      const full = join(path, name);
      const key = relative(directory, full).split(sep).join("/");
      const info = await lstat(full);
      const entry = expected.get(key);

      if (info.isDirectory()) {
        if (entry ? entry.type !== "directory" : !parents.has(key))
          throw invalid();
        await walk(full);
      } else if (info.isSymbolicLink()) {
        if (entry?.type !== "symlink" || (await readlink(full)) !== entry.link)
          throw invalid();
        links.push(full);
      } else if (info.isFile()) {
        if (
          entry?.type !== "file" ||
          info.nlink !== 1 ||
          info.size !== entry.size
        )
          throw invalid();
      } else throw invalid();
    }
  };

  await walk(directory);

  const top = await realpath(
    root === undefined ? directory : join(directory, root),
  );

  for (const link of links) {
    const target = await realpath(link).catch(() => null);

    if (!target || (target !== top && !target.startsWith(`${top}${sep}`)))
      throw invalid();
  }
}
