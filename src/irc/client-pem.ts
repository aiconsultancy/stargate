import { createPrivateKey, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** The secret must be a private, owned file and the first cert must match its key. */
export async function clientPem(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 64 * 1024
      )
        throw new Error();
      const pem = await file.readFile({ encoding: "utf8" });
      const certs = pem.match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
      );
      const key = pem.match(
        /-----BEGIN (PRIVATE KEY|EC PRIVATE KEY|RSA PRIVATE KEY)-----[\s\S]*?-----END \1-----/,
      )?.[0];
      const leaf = certs?.[0];
      if (
        !certs ||
        !leaf ||
        !key ||
        !new X509Certificate(leaf).checkPrivateKey(createPrivateKey(key))
      )
        throw new Error();
      return { cert: certs.join("\n"), key };
    } finally {
      await file.close();
    }
  } catch {
    // OpenSSL/FS errors can contain credentials or credential paths.
    throw new Error(
      "IRC client PEM must be a private, owned certificate and matching key file",
    );
  }
}
