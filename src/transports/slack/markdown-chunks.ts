type Fence = { opening: string; marker: string };

type FenceLine = { start: number; end: number; after: Fence | undefined };

function scanFences(points: string[]): FenceLine[] {
  const fences: FenceLine[] = [];
  let active: Fence | undefined;
  let offset = 0;

  for (const line of points.join("").split(/(?<=\n)/u)) {
    const length = Array.from(line).length;
    const content = line.replace(/\r?\n$/, "");

    if (length <= 512) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
      const marker = match?.[1];
      const info = match?.[2] ?? "";

      if (
        marker &&
        !active &&
        !(marker.startsWith("`") && info.includes("`"))
      ) {
        active = { opening: content, marker };
        fences.push({ start: offset, end: offset + length, after: active });
      } else if (
        marker &&
        active &&
        marker[0] === active.marker[0] &&
        marker.length >= active.marker.length &&
        /^[\t ]*$/.test(info)
      ) {
        active = undefined;
        fences.push({ start: offset, end: offset + length, after: active });
      }
    }

    offset += length;
  }

  return fences;
}

// Greybeard: balance ordinary top-level fences, not a Markdown AST. Fence
// Lines over 512 codepoints fall back to plain splitting so wrappers cannot
// Consume the message budget. Nested containers, tables and inline constructs
// Need a Markdown parser if preserving their structure becomes a requirement.
export function markdownChunks(points: string[]): string[] {
  const fences = scanFences(points);

  const stateAt = (position: number) => {
    let state: Fence | undefined;

    for (const line of fences) {
      if (line.end > position) {
        break;
      }

      state = line.after;
    }

    return state;
  };

  const result: string[] = [];

  for (let start = 0; start < points.length;) {
    const before = stateAt(start);
    const prefix = before ? `${before.opening}\n` : "";
    const capacity = 2800 - Array.from(prefix).length;
    let end = Math.min(points.length, start + capacity);
    let suffix = "";

    for (;;) {
      // Never cut a recognized opening or closing line in half.
      const crossing = fences.find(
        (line) => line.start < end && end < line.end,
      );

      if (crossing) {
        end = crossing.start;
      }

      if (end < points.length) {
        const minimum = start + Math.floor((end - start) / 2);
        let newline = 0;
        let space = 0;

        for (let i = end - 1; i >= minimum; i--) {
          if (points[i] === "\n") {
            newline ||= i + 1;

            if (points[i - 1] === "\n") {
              newline = i + 1;
              break;
            }
          } else if (points[i] === " " || points[i] === "\t") {
            space ||= i + 1;
          }
        }

        end = newline || (stateAt(end) ? 0 : space) || end;
      }

      const after = stateAt(end);
      suffix = after
        ? `${points[end - 1] === "\n" ? "" : "\n"}${after.marker}`
        : "";
      const overflow = end - start + Array.from(suffix).length - capacity;

      if (overflow <= 0) {
        break;
      }

      end -= overflow;
    }

    result.push(prefix + points.slice(start, end).join("") + suffix);
    start = end;
  }

  return result;
}
