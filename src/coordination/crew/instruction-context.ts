import { posix, win32 } from "node:path";
import { Result, Schema } from "effect";
import { settingsStruct } from "../../config/settings-schema";

const metadataSchema = settingsStruct({
  instruction: settingsStruct({
    paths: Schema.mutable(
      Schema.Array(
        Schema.String.check(
          Schema.isMinCodePoints(1),
          Schema.isMaxCodePoints(4096),
        ),
      ),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
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
 * This recognises a native format; it does not authenticate repository text.
 */
export function isNativeInstructionContext(
  message: InstructionRecord,
): boolean {
  if (
    message.type !== "synthetic" ||
    typeof message.text !== "string" ||
    message.text.length > 1024 * 1024 ||
    typeof message.description !== "string" ||
    message.description.length > 16_384 ||
    !message.description.startsWith("Loaded ")
  )
    return false;
  const parsed = Schema.decodeUnknownResult(metadataSchema)(message.metadata);

  if (Result.isFailure(parsed)) return false;
  const paths = parsed.success.instruction.paths;

  if (new Set(paths).size !== paths.length) return false;
  const descriptions = message.description.slice("Loaded ".length).split(", ");

  if (
    descriptions.length !== paths.length ||
    !paths.every((path, index) => describes(path, descriptions[index] ?? ""))
  )
    return false;
  // File bodies are opaque; a quoted header inside one is ordinary content.
  // Only the metadata-declared block markers must appear in their native order.
  let cursor = 0;

  for (const [index, path] of paths.entries()) {
    const header = `Instructions from: ${path}\n`;

    if (index === 0) {
      if (!message.text.startsWith(header)) return false;
      cursor = header.length;
    } else {
      const marker = `\n\n${header}`;
      const found = message.text.indexOf(marker, cursor);

      if (found === -1) return false;
      cursor = found + marker.length;
    }
  }

  return true;
}
