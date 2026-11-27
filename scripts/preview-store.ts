import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DateTime } from "effect";
import { PreviewRefused } from "./preview-bundle";

const lifetime = 7 * 24 * 60 * 60 * 1000;
const supersededGrace = 60_000;
const maxPreviews = 20;

export function previewStore(root: string, baseUrl: string) {
  const bundles = join(root, "bundles");
  const publicPath = join(root, "public", "p");

  mkdirSync(bundles, { recursive: true });
  mkdirSync(publicPath, { recursive: true });

  function collect(now: number) {
    const active = new Set<string>();

    for (const owner of readdirSync(publicPath)) {
      const directory = join(publicPath, owner);

      for (const name of readdirSync(directory)) {
        const link = join(directory, name);

        if (lstatSync(link).mtimeMs + lifetime <= now) {
          rmSync(link);
        } else {
          active.add(basename(readlinkSync(link)));
        }
      }
    }

    for (const bundle of readdirSync(bundles)) {
      const path = join(bundles, bundle);

      if (
        !active.has(bundle) &&
        lstatSync(path).mtimeMs + supersededGrace <= now
      ) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  }

  function publish(
    owner: string,
    name: string,
    files: ReadonlyMap<string, Buffer>,
  ) {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    collect(now);
    const directory = join(publicPath, owner);
    mkdirSync(directory, { recursive: true });
    const active = readdirSync(directory);

    if (active.length >= maxPreviews && !active.includes(name)) {
      throw new PreviewRefused(
        "Unpublish one of your 20 live previews before publishing a new one.",
      );
    }

    const bundle = join(bundles, randomUUID());
    const pointer = `${bundle}.link`;
    const target = join(directory, name);

    try {
      for (const [path, data] of files) {
        const asset = join(bundle, path);
        mkdirSync(dirname(asset), { recursive: true });
        writeFileSync(asset, data, { flag: "wx" });
      }

      symlinkSync(relative(directory, bundle), pointer);

      if (active.includes(name)) {
        // Give any open Caddy reads a grace period starting at replacement.
        const old = join(directory, readlinkSync(target));
        utimesSync(old, now / 1000, now / 1000);
      }

      renameSync(pointer, target);
    } catch (error) {
      rmSync(pointer, { force: true });
      rmSync(bundle, { recursive: true, force: true });
      throw error;
    }

    const expires = lstatSync(target).mtimeMs + lifetime;

    return {
      url: new URL(`p/${owner}/${name}/`, baseUrl).href,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires)),
    };
  }

  function unpublish(owner: string, name: string) {
    rmSync(join(publicPath, owner, name), { force: true });

    return { unpublished: true };
  }

  return { collect, publish, unpublish };
}
