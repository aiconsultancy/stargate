import { z } from "zod";
import { fetchJSON, StepError } from "../exec";
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

const packument = z.object({
  "dist-tags": z.record(z.string(), z.string()),
  time: z.record(z.string(), z.string()),
  versions: z.record(
    z.string(),
    z.object({ deprecated: z.unknown().optional() }),
  ),
});

/**
 * Newest stable npm version, not above `dist-tags.latest`, not deprecated,
 * published at least `hours` ago. Null when none qualifies.
 */
export function selectNpmVersion(raw: unknown, now: number, hours: number) {
  const parsed = packument.safeParse(raw);
  if (!parsed.success) throw new StepError("network");
  const data = parsed.data;
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
    .sort((a, b) => compareVersions(b, a));
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
  const parsed = packument.safeParse(raw);
  const time = parsed.success ? parsed.data.time[version] : undefined;
  return time && Number.isFinite(Date.parse(time)) ? time : null;
}

export const githubReleaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  author: z
    .object({ login: z.string(), type: z.string().optional() })
    .nullable(),
  assets: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        size: z.number(),
        url: z.string(),
        browser_download_url: z.string().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
        /** `sha256:<hex>` when GitHub computed it. */
        digest: z.string().nullable().optional(),
        uploader: z.object({ login: z.string() }).nullable().optional(),
      }),
    )
    .default([]),
});
export type GitHubRelease = z.infer<typeof githubReleaseSchema>;

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
  const parsed = z.array(githubReleaseSchema).safeParse(raw);
  if (!parsed.success) throw new StepError("network");
  return (
    parsed.data
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
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
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
