import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, readOptional } from "./files";
import { maintenanceDirectory } from "./paths";

/**
 * Durable facts that outlive one run: the npm `--before` cutoff that
 * produced each installed agent CLI (so a rollback reinstalls the same
 * dependency set), pinned CLIProxyAPI digests, Pogo releases that failed
 * after a switch (skipped until a newer release exists), and the release
 * whose crew plugin OpenCode loaded when a later update restarted only the
 * gateway (its directory must stay until OpenCode restarts).
 */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sections = {
  npm: z.record(
    z.string(),
    z.object({ version: z.string(), before: z.iso.datetime({ offset: true }) }),
  ),
  cliproxyapi: z.record(
    z.string(),
    z.object({ asset: sha256, binary: sha256 }),
  ),
  failedReleases: z.record(
    z.string(),
    z.object({ reason: z.string(), at: z.iso.datetime({ offset: true }) }),
  ),
  /** Null: OpenCode runs the plugin of the `current` release. */
  openCodeRelease: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
    .nullable(),
};
export type State = {
  [K in keyof typeof sections]: z.infer<(typeof sections)[K]>;
};

const statePath = (dataDirectory: string) =>
  join(maintenanceDirectory(dataDirectory), "state.json");

/** Tolerant: a damaged section is dropped, never the whole file's meaning. */
export async function readState(dataDirectory: string): Promise<State> {
  const state: State = {
    npm: {},
    cliproxyapi: {},
    failedReleases: {},
    openCodeRelease: null,
  };
  const text = await readOptional(statePath(dataDirectory)).catch(() => null);
  if (!text) return state;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return state;
  }
  if (typeof raw !== "object" || raw === null) return state;
  const record = raw as Record<string, unknown>;
  const npm = sections.npm.safeParse(record["npm"]);
  if (npm.success) state.npm = npm.data;
  const proxy = sections.cliproxyapi.safeParse(record["cliproxyapi"]);
  if (proxy.success) state.cliproxyapi = proxy.data;
  const failed = sections.failedReleases.safeParse(record["failedReleases"]);
  if (failed.success) state.failedReleases = failed.data;
  const loaded = sections.openCodeRelease.safeParse(record["openCodeRelease"]);
  if (loaded.success) state.openCodeRelease = loaded.data;
  return state;
}

export async function updateState(
  dataDirectory: string,
  change: (state: State) => void,
) {
  const state = await readState(dataDirectory);
  change(state);
  await mkdir(maintenanceDirectory(dataDirectory), {
    recursive: true,
    mode: 0o700,
  });
  await atomicWrite(
    statePath(dataDirectory),
    `${JSON.stringify({ schema: "pogo.maintenance.state.v1", ...state }, null, 2)}\n`,
    0o600,
  );
}
