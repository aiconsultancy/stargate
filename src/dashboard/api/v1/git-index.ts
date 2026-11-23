/** Read only the split-index reference from a private, size-checked copy. */
function sharedIndexName(path: string, format: "sha1" | "sha256") {
  // The copy cannot change under this mapping. Map it without a second buffer.
  const mapped = Bun.mmap(path, { shared: false });

  const index = Buffer.from(
    mapped.buffer,
    mapped.byteOffset,
    mapped.byteLength,
  );

  const hashBytes = format === "sha1" ? 20 : 32;
  const end = index.length - hashBytes;
  const invalid = () => new Error("Invalid Git index");

  if (end < 12 || index.toString("ascii", 0, 4) !== "DIRC") throw invalid();
  const version = index.readUInt32BE(4);

  if (version < 2 || version > 4) throw invalid();
  const entries = index.readUInt32BE(8);

  // Gitformat-index defines 40 bytes of stat data before the object ID and flags.
  let offset = 12;

  for (let entry = 0; entry < entries; entry++) {
    const flagsAt = offset + 40 + hashBytes;

    if (flagsAt + 2 > end) throw invalid();
    const flags = index.readUInt16BE(flagsAt);
    const nameAt = flagsAt + 2 + (flags & 0x40_00 ? 2 : 0);

    if (version === 4) {
      // Skip the varint prefix, then the NUL-terminated suffix. V4 has no padding.
      let suffix = nameAt;

      while (suffix < end && (index[suffix] ?? 0) & 0x80) suffix++;
      const nul = index.indexOf(0, suffix + 1);

      if (nul < 0 || nul >= end) throw invalid();
      offset = nul + 1;
    } else {
      const length = flags & 0xf_ff;

      const nul =
        length === 0xf_ff ? index.indexOf(0, nameAt) : nameAt + length;

      if (nul < nameAt || nul >= end || index[nul] !== 0) throw invalid();
      offset += Math.ceil((nul + 1 - offset) / 8) * 8;
    }
  }

  if (offset > end) throw invalid();

  let shared: string | undefined;

  while (offset < end) {
    if (offset + 8 > end) throw invalid();
    const size = index.readUInt32BE(offset + 4);
    const data = offset + 8;

    if (data + size > end) throw invalid();

    if (index.toString("ascii", offset, offset + 4) === "link") {
      if (size < hashBytes) throw invalid();
      const hash = index.toString("hex", data, data + hashBytes);
      shared = /^0+$/.test(hash) ? undefined : `sharedindex.${hash}`;
    }

    offset = data + size;
  }

  return shared;
}

if (import.meta.main) {
  const [, , path, format] = process.argv;

  if (!path || (format !== "sha1" && format !== "sha256")) process.exit(1);
  const shared = sharedIndexName(path, format);

  if (shared) process.stdout.write(shared);
}
