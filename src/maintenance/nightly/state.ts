import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Option, Schema } from "effect";
import {
  settingsDateTime,
  settingsPattern,
  settingsRecord,
} from "../../config/settings-schema";
import { atomicWrite, readOptional } from "./files";
import { maintenanceDirectory } from "./paths";

/**
 * Durable facts that outlive one run: the npm `--before` cutoff that
 * produced each installed agent CLI (so a rollback reinstalls the same
 * dependency set), pinned CLIProxyAPI digests, Stargate releases that failed
 * after a switch (skipped until a newer release exists), and the release
 * whose crew plugin OpenCode loaded when a later update restarted only the
 * gateway (its directory must stay until OpenCode restarts).
 */
const sha256 = Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/));

// Zod's plain objects stripped unknown keys; Effect structs do the same.
const sections = {
  npm: settingsRecord(
    Schema.String,
    Schema.Struct({ version: Schema.String, before: settingsDateTime }),
  ),
  cliproxyapi: settingsRecord(
    Schema.String,
    Schema.Struct({ asset: sha256, binary: sha256 }),
  ),
  failedReleases: settingsRecord(
    Schema.String,
    Schema.Struct({ reason: Schema.String, at: settingsDateTime }),
  ),
  /** Null: OpenCode runs the plugin of the `current` release. */
  openCodeRelease: Schema.NullOr(
    Schema.String.check(settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)),
  ),
};

export type State = {
  npm: Record<string, { version: string; before: string }>;
  cliproxyapi: Record<string, { asset: string; binary: string }>;
  failedReleases: Record<string, { reason: string; at: string }>;
  openCodeRelease: string | null;
};

const decode = {
  npm: Schema.decodeUnknownOption(sections.npm),
  cliproxyapi: Schema.decodeUnknownOption(sections.cliproxyapi),
  failedReleases: Schema.decodeUnknownOption(sections.failedReleases),
  openCodeRelease: Schema.decodeUnknownOption(sections.openCodeRelease),
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
  const npm = decode.npm(record["npm"]);

  if (Option.isSome(npm)) state.npm = npm.value;
  const proxy = decode.cliproxyapi(record["cliproxyapi"]);

  if (Option.isSome(proxy)) state.cliproxyapi = proxy.value;
  const failed = decode.failedReleases(record["failedReleases"]);

  if (Option.isSome(failed)) state.failedReleases = failed.value;
  const loaded = decode.openCodeRelease(record["openCodeRelease"]);

  if (Option.isSome(loaded)) state.openCodeRelease = loaded.value;

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
    `${JSON.stringify({ schema: "stargate.maintenance.state.v1", ...state }, null, 2)}\n`,
    0o600,
  );
}
