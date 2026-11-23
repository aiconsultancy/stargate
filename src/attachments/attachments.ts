import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  open,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Result, Schema } from "effect";
import { settingsPattern, settingsStruct } from "../config/settings-schema";

/** Bound memory use at each media trust boundary, before admission or upload. */
export const maxAttachmentBytes = 10 * 1024 * 1024;
export const maxAttachments = 10;
export const maxAttachmentTotalBytes = 25 * 1024 * 1024;

export type Attachment = {
  name: string;
  mime: string;
  data: Uint8Array;
  /** Facts from the chat platform about an accepted input file. */
  source?: {
    id: string;
    durationMs?: number;
    /** Complete platform transcript of audio or video; never a preview. */
    transcript?: string;
  };
};

const mimePattern = /^[\w.+-]+\/[\w.+-]+$/;
const maxCaption = 1000;
const maxDestination = 4096;
const maxName = 255;

/** Control characters, NUL and both path separators are never valid names. */
function unsafeName(name: string) {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);

    if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c)
      return true;
  }

  return false;
}

export function checkAttachments(files: readonly Attachment[]) {
  if (files.length > maxAttachments) throw new Error("Too many attachments");
  let total = 0;

  for (const file of files) {
    if (
      !file.name ||
      file.name.length > maxName ||
      unsafeName(file.name) ||
      !mimePattern.test(file.mime) ||
      file.data.byteLength === 0 ||
      file.data.byteLength > maxAttachmentBytes
    )
      throw new Error("Invalid or oversized attachment");
    total += file.data.byteLength;

    if (total > maxAttachmentTotalBytes)
      throw new Error("Attachments exceed total size limit");
  }
}

/** A local file explicitly published by `![caption](file:///absolute/path)`. */
export type PublishedFile = { path: string; caption: string };

/** Durable, JSON-safe metadata; reading the bytes revalidates every field. */
export const preparedAttachmentSchema = settingsStruct({
  path: Schema.String.check(
    Schema.isMinCodePoints(2),
    Schema.isMaxCodePoints(maxDestination),
  ),
  caption: Schema.String.check(Schema.isMaxCodePoints(maxCaption)),
  name: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(maxName),
  ),
  mime: Schema.String.check(settingsPattern(mimePattern)),
  size: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maxAttachmentBytes),
  ),
  sha256: Schema.String.check(settingsPattern(/^[0-9a-f]{64}$/)),
});

export type PreparedAttachment = typeof preparedAttachmentSchema.Type;

/** Generic by design: messages never contain the requested path or its name. */
/**
 * An upload that certainly did not store the file: the host answered with
 * a refusal that rejects the request itself, or nothing was sent. Any
 * other upload failure is uncertain.
 */
export class UploadRefused extends Error {
  public constructor() {
    super("Upload refused");
  }
}

export class AttachmentUnavailable extends Error {
  public constructor(
    public readonly reason:
      | "invalid"
      | "denied"
      | "missing"
      | "type"
      | "size"
      | "changed",
  ) {
    super("Attachment unavailable");
    this.name = "AttachmentUnavailable";
  }
}

// ---------------------------------------------------------------------------
// Outbound publication markers
// ---------------------------------------------------------------------------

const redacted = "file:///…";

// Hide any file URL, complete or streamed. Angle forms may contain spaces;
// Bare forms end only at whitespace, quotes or tags, so `)` cannot cut a path.
const angledFileReference = /<file:[^>\n]*>?/gi;
const fileReference = /\bfile:\/[^\s<>"'`]*/gi;

function redact(text: string) {
  return text
    .replace(angledFileReference, `<${redacted}>`)
    .replace(fileReference, redacted);
}

function fileLike(destination: string) {
  const prefix = destination.toLowerCase();

  return "file:".startsWith(prefix) || prefix.startsWith("file:");
}

/** Strict absolute file URL: no authority, query, fragment or dot segments. */
function filePath(destination: string, angle: boolean): string | undefined {
  if (!/^file:\/\/\//i.test(destination)) return;
  const raw = destination.slice("file://".length);

  for (const character of raw) {
    const code = character.charCodeAt(0);

    if (
      code < 0x20 ||
      code === 0x7f ||
      character === "?" ||
      character === "#" ||
      character === "\\" ||
      (character === " " ? !angle : /\s/.test(character))
    )
      return;
  }

  const segments: string[] = [];

  for (const segment of raw.slice(1).split("/")) {
    let value: string;

    try {
      value = decodeURIComponent(segment);
    } catch {
      return;
    }

    if (!value || value === "." || value === ".." || unsafeName(value)) return;
    segments.push(value);
  }

  return `/${segments.join("/")}`;
}

function unescapeLabel(label: string) {
  return label.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

type Construct =
  | { kind: "none" }
  | { kind: "incomplete"; fileLike: boolean }
  | {
      kind: "link";
      end: number;
      label: string;
      destination: string;
      angle: boolean;
    };

/** One inline `[label](destination)` with no title, nesting or line breaks. */
function construct(text: string, bracket: number): Construct {
  let index = bracket + 1;

  for (;;) {
    if (index >= text.length) return { kind: "incomplete", fileLike: true };

    if (index - bracket > maxCaption) return { kind: "none" };
    const character = text[index];

    if (character === "\\") {
      index += 2;
      continue;
    }

    if (character === "]") break;

    if (character === "[" || character === "\n") return { kind: "none" };
    index++;
  }

  const label = text.slice(bracket + 1, index);
  const open = index + 1;

  if (open >= text.length) return { kind: "incomplete", fileLike: true };

  if (text[open] !== "(") return { kind: "none" };
  const angle = text[open + 1] === "<";
  const start = open + (angle ? 2 : 1);
  let end = start;

  for (;;) {
    if (end >= text.length)
      return {
        kind: "incomplete",
        fileLike: fileLike(text.slice(start, end)),
      };

    if (end - start > maxDestination) return { kind: "none" };
    const character = text[end] ?? "";

    if (angle) {
      if (character === ">") break;

      if (character === "<" || character === "\n") return { kind: "none" };
    } else {
      if (character === ")") break;

      if (character === "(" || character === "<" || /\s/.test(character))
        return { kind: "none" };
    }

    end++;
  }

  const destination = text.slice(start, end);

  if (!destination) return { kind: "none" };

  if (angle) {
    if (end + 1 >= text.length)
      return { kind: "incomplete", fileLike: fileLike(destination) };

    if (text[end + 1] !== ")") return { kind: "none" };
    end++;
  }

  return { kind: "link", end: end + 1, label, destination, angle };
}

type Segment = { code: boolean; text: string };

/** Fenced code is inert. An unclosed fence extends to the end of the text. */
function fencedSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let fence: { marker: string; length: number } | undefined;

  for (const line of text.split(/(?<=\n)/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r?\n$/, ""));
    const code = fence !== undefined;

    if (fence) {
      if (
        match?.[1]?.[0] === fence.marker &&
        match[1].length >= fence.length &&
        !match[2]?.trim()
      )
        fence = undefined;
    } else if (match?.[1] && !(match[1][0] === "`" && match[2]?.includes("`")))
      fence = { marker: match[1][0] ?? "`", length: match[1].length };
    const isCode = code || fence !== undefined;
    const last = segments.at(-1);

    if (last?.code === isCode) last.text += line;
    else segments.push({ code: isCode, text: line });
  }

  return segments;
}

/**
 * Extract explicit publications from settled assistant text and hide every
 * local file URL. Only `![caption](file:///absolute/path)` outside code
 * publishes; plain local links keep their label, and other URLs stay intact.
 * With `complete=false`, a trailing construct that may still become a local
 * reference is withheld until it closes, so previews never show its path.
 * Pure: no file is read or checked here.
 */
export function parseAttachments(
  text: string,
  complete = true,
): { text: string; files: PublishedFile[] } {
  const files: PublishedFile[] = [];
  const seen = new Set<string>();
  let output = "";

  for (const segment of fencedSegments(text)) {
    if (segment.code) {
      output += redact(segment.text);
      continue;
    }

    const prose = segment.text;
    let piece = "";
    let index = 0;
    let withheld = false;

    while (index < prose.length) {
      const character = prose[index];

      if (character === "\\" && index + 1 < prose.length) {
        piece += prose.slice(index, index + 2);
        index += 2;
        continue;
      }

      if (character === "`") {
        let run = index;

        while (prose[run] === "`") run++;
        const ticks = prose.slice(index, run);
        let close = prose.indexOf(ticks, run);

        while (close >= 0 && prose[close + ticks.length] === "`")
          close = prose.indexOf(ticks, close + ticks.length + 1);

        if (close >= 0) {
          piece += prose.slice(index, close + ticks.length);
          index = close + ticks.length;
          continue;
        }

        piece += ticks;
        index = run;
        continue;
      }

      const image = character === "!" && prose[index + 1] === "[";

      if (character === "[" || image) {
        const bracket = image ? index + 1 : index;
        const found = construct(prose, bracket);

        if (found.kind === "incomplete" && !complete) {
          if (found.fileLike) withheld = true;
          else piece += prose.slice(index);
          break;
        }

        if (found.kind === "link") {
          if (/^file:/i.test(found.destination)) {
            const caption = unescapeLabel(found.label);

            const path = image
              ? filePath(found.destination, found.angle)
              : undefined;

            if (path && !seen.has(path)) {
              seen.add(path);
              files.push({ path, caption });
            }

            piece += caption;
          } else piece += prose.slice(index, found.end);
          index = found.end;
          continue;
        }

        piece += prose.slice(index, bracket + 1);
        index = bracket + 1;
        continue;
      }

      piece += character;
      index++;
    }

    output += redact(piece);

    if (withheld) break;
  }

  return { text: output, files };
}

// ---------------------------------------------------------------------------
// Local file inspection
// ---------------------------------------------------------------------------

/** Evaluate OpenCode's scratch rule in this process, not at module load. */
export function opencodeScratchDirectory() {
  return join(tmpdir(), "opencode");
}

const deniedRoots = new Set([
  "boot",
  "dev",
  "etc",
  "proc",
  "root",
  "run",
  "sys",
]);

const deniedNames = [
  /\.(?:key|pem|p12|pfx|jks|keystore|kdbx|gpg|asc|ovpn)$/i,
  /^id_/i,
  /\.env$/i,
  /\.(?:sqlite\d*|db)(?:-(?:wal|shm|journal))?$/i,
  /^credentials?(?:[._-]|$)/i,
  /^(?:secrets?|tokens?|passwords?)(?:[._-]|$)/i,
  /^stargate\.json/i,
  /^pogo\.json/i,
  /^(?:auth|service)\.json$/i,
  /^kubeconfig/i,
  /^(?:netrc|pgpass|htpasswd)$/i,
];

/** Common credential and machine-state locations. Not a sandbox. */
/**
 * `root`: a canonical operator-chosen directory containing `path`. Hidden
 * segments are then checked only below it, so a root such as
 * `~/.cache/tmp/opencode` works while `.git` or `.ssh` beneath it stays denied.
 */
function deniedPath(path: string, root?: string) {
  const segments = path.split("/").slice(1);

  if (deniedRoots.has(segments[0] ?? "")) return true;
  const base = root?.replace(/\/+$/, "").split("/").slice(1).filter(Boolean);

  if (
    base &&
    (base.length >= segments.length ||
      base.some((segment, index) => segments[index] !== segment))
  )
    return true;

  if (
    segments.slice(base?.length ?? 0).some((segment) => segment.startsWith("."))
  )
    return true;
  const name = segments.at(-1) ?? "";

  return deniedNames.some((pattern) => pattern.test(name));
}

/** Absolute, already canonical text; no dot segments or empty components. */
function checkedPath(path: string, root?: string) {
  if (
    path.length < 2 ||
    path.length > maxDestination ||
    !path.startsWith("/") ||
    path
      .slice(1)
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);

      return code < 0x20 || code === 0x7f || character === "\\";
    })
  )
    throw new AttachmentUnavailable("invalid");

  if (deniedPath(path, root)) throw new AttachmentUnavailable("denied");

  return path;
}

function attachmentName(path: string) {
  let name = basename(path).replace(/[\\/]/g, "_");
  name = Array.from(name)
    .map((character) => {
      const code = character.charCodeAt(0);

      return code < 0x20 || code === 0x7f ? "_" : character;
    })
    .join("")
    .trim();

  if (name.length > maxName) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, maxName - extension.length) + extension;
  }

  return name || "attachment";
}

function attachmentMime(path: string) {
  const mime = Bun.file(path).type.split(";")[0]?.trim() ?? "";

  return mimePattern.test(mime) ? mime : "application/octet-stream";
}

function unavailable(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw signal.reason;

  if (error instanceof AttachmentUnavailable) throw error;

  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;

  // Raw filesystem errors include the path; never propagate them.
  throw new AttachmentUnavailable(
    code === "ELOOP" || code === "EACCES" || code === "EPERM"
      ? "denied"
      : "missing",
  );
}

/**
 * Open the exact canonical path without following a final symlink or blocking
 * on a FIFO/device, then prove the descriptor names that same regular file.
 */
async function openRegular(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();

  if ((await realpath(path)) !== path)
    throw new AttachmentUnavailable("denied");

  const handle = await open(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      constants.O_NOCTTY,
  );

  try {
    const info = await handle.stat();

    if (!info.isFile()) throw new AttachmentUnavailable("type");

    if (info.size <= 0 || info.size > maxAttachmentBytes)
      throw new AttachmentUnavailable("size");

    // A parent directory can be swapped after realpath; bind the descriptor.
    const linked = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => {});

    if (linked !== undefined) {
      if (linked !== path) throw new AttachmentUnavailable("denied");
    } else {
      const current = await stat(path);

      if (current.dev !== info.dev || current.ino !== info.ino)
        throw new AttachmentUnavailable("denied");
    }

    return { handle, size: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Read exactly `size` bytes; growth, truncation or abort fails closed. */
async function readExact(
  handle: FileHandle,
  size: number,
  keep: boolean,
  signal?: AbortSignal,
) {
  const hash = createHash("sha256");
  const data = keep ? new Uint8Array(size) : undefined;
  const chunk = new Uint8Array(Math.min(size + 1, 64 * 1024));
  let total = 0;

  for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);

    if (bytesRead === 0) break;

    if (total + bytesRead > size) throw new AttachmentUnavailable("changed");
    const bytes = chunk.subarray(0, bytesRead);
    hash.update(bytes);
    data?.set(bytes, total);
    total += bytesRead;
  }

  if (total !== size) throw new AttachmentUnavailable("changed");

  return { sha256: hash.digest("hex"), data };
}

/**
 * Validate one published file and record its durable identity. Reads only a
 * bounded regular file at the exact canonical path; denial happens before
 * any filesystem access. Trust ceiling: a published, non-denied file readable
 * by Stargate can be sent to the proven origin; this is not a sandbox.
 */
export async function inspectAttachment(
  file: PublishedFile,
  signal?: AbortSignal,
  root?: string,
): Promise<PreparedAttachment> {
  const path = checkedPath(file.path, root);

  if (file.caption.length > maxCaption)
    throw new AttachmentUnavailable("invalid");

  try {
    const { handle, size } = await openRegular(path, signal);

    try {
      const { sha256 } = await readExact(handle, size, false, signal);

      return {
        path,
        caption: file.caption,
        name: attachmentName(path),
        mime: attachmentMime(path),
        size,
        sha256,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    unavailable(error, signal);
  }
}

/** Reopen and return exactly the inspected bytes, or fail as changed. */
export async function readPreparedAttachment(
  input: PreparedAttachment,
  signal?: AbortSignal,
  root?: string,
): Promise<Attachment> {
  const parsed = Schema.decodeUnknownResult(preparedAttachmentSchema)(input);

  if (Result.isFailure(parsed)) throw new AttachmentUnavailable("invalid");
  const prepared = parsed.success;
  const path = checkedPath(prepared.path, root);

  try {
    const { handle, size } = await openRegular(path, signal);

    try {
      if (size !== prepared.size) throw new AttachmentUnavailable("changed");
      const { sha256, data } = await readExact(handle, size, true, signal);

      if (sha256 !== prepared.sha256 || !data)
        throw new AttachmentUnavailable("changed");
      const attachment = { name: prepared.name, mime: prepared.mime, data };
      checkAttachments([attachment]);

      return attachment;
    } finally {
      await handle.close();
    }
  } catch (error) {
    unavailable(error, signal);
  }
}

/** Batch limits from durable metadata, before any upload read. */
export function checkPreparedAttachments(files: readonly PreparedAttachment[]) {
  if (files.length > maxAttachments) throw new Error("Too many attachments");
  let total = 0;

  for (const file of files) {
    total += file.size;

    if (total > maxAttachmentTotalBytes)
      throw new Error("Attachments exceed total size limit");
  }
}
