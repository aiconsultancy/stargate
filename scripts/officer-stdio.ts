export async function* officerRequestLines(limit: number) {
  let pending = Buffer.alloc(0);
  const reader = Bun.stdin.stream().getReader();

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) {
        if (pending.length > 0) {
          yield pending.toString("utf8");
        }

        return;
      }

      const bytes = Buffer.from(chunk.value);
      let start = 0;

      while (start < bytes.length) {
        const end = bytes.indexOf(10, start) + 1;
        const piece = bytes.subarray(start, end === 0 ? bytes.length : end);

        if (pending.length + piece.length > limit) {
          await reader.cancel();

          return;
        }

        pending = Buffer.concat([pending, piece]);

        if (!end) {
          break;
        }

        yield pending.toString("utf8");
        pending = Buffer.alloc(0);
        start = end;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
