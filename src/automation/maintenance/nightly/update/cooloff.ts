import { Result, Schema } from "effect";
import {
  settingsDefault,
  settingsPlainRecord,
} from "../../../../config/settings-schema";
import { StepError, fetchJSON } from "../exec";
import { compareVersions, normalizeVersion, parseVersion } from "./versions";

/**
 * Supply-chain cool-off: a version is eligible only when its publication time
 * is at least `hours` before `now`. Unknown publication time is never eligible.
 */
export function eligible(
  published: string | undefined,
  now: number,
  hours: number,
) {
  if (!published) return false;
  const at = Date.parse(published);

  return Number.isFinite(at) && at <= now - hours * 3_600_000;
}

const packument = Schema.Struct({
  "dist-tags": settingsPlainRecord(Schema.String, Schema.String),
  time: settingsPlainRecord(Schema.String, Schema.String),
  versions: settingsPlainRecord(
    Schema.String,
    Schema.Struct({ deprecated: Schema.optional(Schema.Unknown) }),
  ),
});

const decodePackument = Schema.decodeUnknownResult(packument);

/**
 * Newest stable npm version, not above `dist-tags.latest`, not deprecated,
 * published at least `hours` ago. Null when none qualifies.
 */
export function selectNpmVersion(raw: unknown, now: number, hours: number) {
  const parsed = decodePackument(raw);

  if (Result.isFailure(parsed)) throw new StepError("network");
  const data = parsed.success;
  const latest = data["dist-tags"]["latest"];

  if (!latest || !parseVersion(latest)) return null;

  const candidates = Object.entries(data.versions)
    .filter(
      ([version, info]) =>
        parseVersion(version) &&
        info.deprecated === undefined &&
        compareVersions(version, latest) <= 0 &&
        eligible(data.time[version], now, hours),
    )
    .map(([version]) => version)
    .toSorted((a, b) => compareVersions(b, a));

  return candidates[0] ?? null;
}

export async function npmPackument(registry: string, name: string) {
  const base = registry.replace(/\/+$/, "");

  return fetchJSON(`${base}/${name.replace("/", "%2F")}`, {
    headers: { accept: "application/json" },
  });
}

export async function npmCandidate(
  registry: string,
  name: string,
  now: number,
  hours: number,
) {
  return selectNpmVersion(await npmPackument(registry, name), now, hours);
}

/** Registry publication time of one version, if recorded. */
export function publishedAt(raw: unknown, version: string) {
  const parsed = decodePackument(raw);

  const time = Result.isSuccess(parsed)
    ? parsed.success.time[version]
    : undefined;

  return time && Number.isFinite(Date.parse(time)) ? time : null;
}

export const githubReleaseSchema = Schema.Struct({
  id: Schema.Finite,
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  author: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      type: Schema.optional(Schema.String),
    }),
  ),
  assets: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      size: Schema.Finite,
      url: Schema.String,
      browser_download_url: Schema.optional(Schema.String),
      created_at: Schema.optional(Schema.String),
      updated_at: Schema.optional(Schema.String),
      /** `sha256:<hex>` when GitHub computed it. */
      digest: Schema.optional(Schema.NullOr(Schema.String)),
      uploader: Schema.optional(
        Schema.NullOr(Schema.Struct({ login: Schema.String })),
      ),
    }),
  ).pipe(settingsDefault([])),
});

export type GitHubRelease = typeof githubReleaseSchema.Type;

const decodeReleases = Schema.decodeUnknownResult(
  Schema.Array(githubReleaseSchema),
);

/**
 * Newest stable, non-draft, non-prerelease GitHub release past the cool-off.
 * Every asset must also be past the cool-off by its own creation and update
 * time: replacing an asset on an old release does not bypass the age rule.
 */
export function selectGitHubRelease(
  raw: unknown,
  now: number,
  hours: number,
): (GitHubRelease & { version: string }) | null {
  const parsed = decodeReleases(raw);

  if (Result.isFailure(parsed)) throw new StepError("network");

  return (
    parsed.success
      .flatMap((release) => {
        const version = normalizeVersion(release.tag_name);

        return version &&
          !release.draft &&
          !release.prerelease &&
          eligible(release.published_at ?? undefined, now, hours) &&
          release.assets.every(
            (asset) =>
              eligible(asset.created_at, now, hours) &&
              eligible(asset.updated_at, now, hours),
          )
          ? [{ ...release, version }]
          : [];
      })
      .toSorted((a, b) => compareVersions(b.version, a.version))[0] ?? null
  );
}

export async function githubReleases(
  apiURL: string,
  repository: string,
  headers: Record<string, string> = {},
) {
  return fetchJSON(
    `${apiURL.replace(/\/+$/, "")}/repos/${repository}/releases?per_page=30`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...headers,
      },
    },
  );
}
