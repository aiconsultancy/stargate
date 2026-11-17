import { posix, win32 } from "node:path";
import { z } from "zod";

const metadataSchema = z.strictObject({
  instruction: z.strictObject({
    paths: z.array(z.string().min(1).max(4096)).min(1).max(32),
  }),
});

interface InstructionRecord {
  type: string;
  text?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

function pathFormat(path: string) {
  if (
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return;
  if (posix.isAbsolute(path) && posix.normalize(path) === path) return posix;
  if (win32.isAbsolute(path) && win32.normalize(path) === path) return win32;
  return;
}

function describes(path: string, description: string): boolean {
  const format = pathFormat(path);
  if (!format || !description) return false;
  if (description === path) return true;
  return (
    !format.isAbsolute(description) &&
    format.normalize(description) === description &&
    !description.split(/[\\/]/u).some((part) => !part || part === "..") &&
    path.endsWith(`${format.sep}${description}`)
  );
}

/** OpenCode 2.2.7 SessionInstructions.load wire shape, read from trusted history.
 * File contents remain opaque context, never a new assignment or authority.
 * This recognizes a native format; it does not authenticate repository text.
 */
export function isNativeInstructionContext(
  message: InstructionRecord,
): boolean {
  if (
    message.type !== "synthetic" ||
    typeof message.text !== "string" ||
    message.text.length > 1024 * 1024 ||
    typeof message.description !== "string" ||
    message.description.length > 16384 ||
    !message.description.startsWith("Loaded ")
  )
    return false;
  const parsed = metadataSchema.safeParse(message.metadata);
  if (!parsed.success) return false;
  const paths = parsed.data.instruction.paths;
  if (new Set(paths).size !== paths.length) return false;
  const descriptions = message.description.slice("Loaded ".length).split(", ");
  if (
    descriptions.length !== paths.length ||
    !paths.every((path, index) => describes(path, descriptions[index] ?? ""))
  )
    return false;
  const headers = [
    ...message.text.matchAll(/^Instructions from: ([^\n]*)\n/gmu),
  ];
  return (
    headers.length === paths.length &&
    headers.every(
      (header, index) =>
        header[1] === paths[index] &&
        (index === 0
          ? header.index === 0
          : message.text?.slice((header.index ?? 0) - 2, header.index) ===
            "\n\n"),
    )
  );
}
