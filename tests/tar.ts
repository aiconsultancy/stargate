import { gzipSync } from "node:zlib";

/** Minimal ustar/pax writer for crafted (including hostile) test archives. */
export type TarEntry = {
  path: string;
  /** Any tar typeflag, including GNU ones ("L", "K", "S") for rejections. */
  type?: string;
  data?: string;
  link?: string;
  mode?: number;
  /** Per-file pax header ("x") before this entry. */
  pax?: Record<string, string>;
  /** Global pax header ("g") before this entry. */
  global?: Record<string, string>;
  /** Header magic and version; default POSIX "ustar\0" + "00". */
  magic?: string;
  /** Declared size, to craft headers whose data length differs. */
  size?: number;
  /** Set the old-GNU "isextended" sparse byte. */
  gnuSparse?: boolean;
};

const octal = (value: number, width: number) =>
  value.toString(8).padStart(width, "0");

function header(
  name: string,
  type: string,
  size: number,
  link = "",
  mode = 0o644,
  magic = "ustar\u000000",
) {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(`${octal(mode, 7)}\0`, 100);
  block.write(`${octal(0, 7)}\0`, 108);
  block.write(`${octal(0, 7)}\0`, 116);
  block.write(`${octal(size, 11)}\0`, 124);
  block.write(`${octal(0, 11)}\0`, 136);
  block.fill(" ", 148, 156);
  block.write(type, 156);
  block.write(link.slice(0, 100), 157);
  block.write(magic, 257, "latin1");
  let sum = 0;

  for (const byte of block) {
    sum += byte;
  }

  block.write(`${octal(sum, 6)}\0 `, 148);

  return block;
}

const pad = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

function paxBody(records: Record<string, string>) {
  return Buffer.from(
    Object.entries(records)
      .map(([key, value]) => {
        const body = ` ${key}=${value}\n`;
        let length = body.length + 1;

        while (`${length}${body}`.length !== length) {
          length++;
        }

        return `${length}${body}`;
      })
      .join(""),
  );
}

export function tarball(entries: TarEntry[], corrupt = false) {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    if (entry.global) {
      const body = paxBody(entry.global);
      blocks.push(header("pax_global_header", "g", body.length), pad(body));
    }

    if (entry.pax) {
      const body = paxBody(entry.pax);
      blocks.push(header("PaxHeader", "x", body.length), pad(body));
    }

    const type = entry.type ?? "0";
    const data = Buffer.from(type === "0" ? (entry.data ?? "") : "");

    const block = header(
      entry.path,
      type,
      entry.size ?? data.length,
      entry.link,
      entry.mode,
      entry.magic,
    );

    if (entry.gnuSparse) {
      block[482] = 1;
      block.fill(" ", 148, 156);
      let sum = 0;

      for (const byte of block) {
        sum += byte;
      }

      block.write(`${octal(sum, 6)}\0 `, 148);
    }

    if (corrupt) {
      block[0] = (block[0] ?? 0) ^ 1;
    }

    blocks.push(block, pad(data));
  }

  blocks.push(Buffer.alloc(1024));

  return new Uint8Array(
    gzipSync(Buffer.concat(blocks)),
  ) as Uint8Array<ArrayBuffer>;
}
