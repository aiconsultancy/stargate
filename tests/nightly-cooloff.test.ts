import { afterAll, describe, expect, test } from "bun:test";
import {
  eligible,
  npmCandidate,
  selectGitHubRelease,
  selectNpmVersion,
} from "../src/maintenance/nightly/update/cooloff";

const now = Date.parse("2026-11-12T00:10:00Z");

const hoursAgo = (hours: number) =>
  new Date(now - hours * 3_600_000).toISOString();

const packument = {
  "dist-tags": { latest: "2.3.0", next: "2.4.0-beta.1" },
  time: {
    created: hoursAgo(5000),
    "2.1.0": hoursAgo(200),
    "2.2.0": hoursAgo(48),
    "2.2.1": hoursAgo(25),
    "2.2.2": hoursAgo(30),
    "2.3.0": hoursAgo(2),
    "2.4.0-beta.1": hoursAgo(72),
    "2.5.0": hoursAgo(100),
  },
  versions: {
    "2.1.0": {},
    "2.2.0": {},
    "2.2.1": { deprecated: "broken" },
    "2.2.2": {},
    "2.3.0": {},
    "2.4.0-beta.1": {},
    "2.5.0": {},
  },
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/@opencode%2Fcli") return Response.json(packument);

    return new Response("missing", { status: 404 });
  },
});

afterAll(() => server.stop(true));

describe("supply-chain cool-off", () => {
  test("eligibility is inclusive at exactly the cool-off", () => {
    expect(eligible(hoursAgo(24), now, 24)).toBe(true);
    expect(eligible(new Date(now - 86_399_999).toISOString(), now, 24)).toBe(
      false,
    );
    expect(eligible(undefined, now, 0)).toBe(false);
    expect(eligible("not a date", now, 0)).toBe(false);
  });

  test("npm: newest stable, not deprecated, not above latest, past cool-off", () => {
    expect(selectNpmVersion(packument, now, 24)).toBe("2.2.2");
    expect(selectNpmVersion(packument, now, 0)).toBe("2.3.0");
    expect(selectNpmVersion(packument, now, 24 * 30)).toBeNull();
    expect(() => selectNpmVersion({ nope: true }, now, 24)).toThrow();
  });

  test("npm registry fixture with a scoped package name", async () => {
    const registry = `http://127.0.0.1:${server.port}`;
    expect(await npmCandidate(registry, "@opencode/cli", now, 24)).toBe(
      "2.2.2",
    );
    await expect(
      npmCandidate(registry, "@missing/pkg", now, 24),
    ).rejects.toThrow("not-found");
  });

  test("GitHub: stable, published, past cool-off; drafts and pre-releases skipped", () => {
    const release = (
      tag: string,
      hours: number | null,
      extra: Record<string, unknown> = {},
    ) => ({
      id: 1,
      tag_name: tag,
      draft: false,
      prerelease: false,
      published_at: hours === null ? null : hoursAgo(hours),
      author: { login: "github-actions[bot]" },
      assets: [],
      ...extra,
    });

    const releases = [
      release("v8.0.60", 1),
      release("v8.0.59", 30, { draft: true }),
      release("v8.0.58", 30, { prerelease: true }),
      release("v8.0.57-rc.1", 30),
      release("v8.0.56", null),
      release("v8.0.55", 26),
      release("nightly", 100),
      release("v8.0.54", 400),
    ];

    expect(selectGitHubRelease(releases, now, 24)?.version).toBe("8.0.55");
    expect(selectGitHubRelease(releases, now, 0)?.version).toBe("8.0.60");
    expect(selectGitHubRelease([], now, 0)).toBeNull();
  });

  test("GitHub: a replaced asset restarts the cool-off for its release", () => {
    const asset = (created: number, updated: number) => ({
      id: 1,
      name: "CLIProxyAPI_8.0.60_linux_amd64.tar.gz",
      size: 1,
      url: "https://api.github.com/a",
      created_at: hoursAgo(created),
      updated_at: hoursAgo(updated),
    });

    const release = (tag: string, assets: unknown[]) => ({
      id: 1,
      tag_name: tag,
      draft: false,
      prerelease: false,
      published_at: hoursAgo(100),
      author: { login: "github-actions[bot]" },
      assets,
    });

    const releases = [
      release("v8.0.60", [asset(100, 2)]),
      release("v8.0.59", [asset(1, 1)]),
      release("v8.0.58", [{ ...asset(100, 100), updated_at: undefined }]),
      release("v8.0.57", [asset(90, 90)]),
    ];

    expect(selectGitHubRelease(releases, now, 24)?.version).toBe("8.0.57");
  });
});
