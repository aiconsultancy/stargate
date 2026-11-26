export async function readAttachmentResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");

  if (
    response.status !== 200 ||
    !response.body ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
  ) {
    await response.body?.cancel();
    throw new Error("Teams attachment download unavailable or too large");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      total += chunk.value.length;

      if (total > limit) {
        throw new Error("Teams attachment exceeds the file size limit");
      }

      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (
    !total ||
    (declared !== null &&
      !response.headers.has("content-encoding") &&
      total !== Number(declared))
  ) {
    throw new Error("Incomplete Teams attachment");
  }

  return Buffer.concat(chunks, total);
}
