import { expect, test } from "bun:test";
import { bumpFor, nextVersion, releaseNotes } from "../scripts/release-version";

test("conventional commit subjects select the bump", () => {
  expect(bumpFor("feat: add text mentions (#43)")).toBe("minor");
  expect(bumpFor("feat(slack): add pairing")).toBe("minor");
  expect(bumpFor("fix: keep cursor")).toBe("patch");
  expect(bumpFor("chore(deps): bump effect")).toBe("patch");
  expect(bumpFor("Merge branch main")).toBe("patch");
  expect(bumpFor("feat!: drop module backends")).toBe("major");
  expect(bumpFor("refactor(api)!: rename")).toBe("major");
  expect(bumpFor("fix: x\n\nBREAKING CHANGE: config moved")).toBe("major");
  expect(bumpFor("fix: mention BREAKING CHANGE: in prose")).toBe("patch");
});

test("the first release is v0.1.0; later releases follow the largest bump", () => {
  expect(nextVersion(undefined, ["fix: a"])).toBe("0.1.0");
  expect(nextVersion("v0.1.0", ["fix: a", "chore: b"])).toBe("0.1.1");
  expect(nextVersion("v0.1.4", ["fix: a", "feat: b"])).toBe("0.2.0");
  // Before 1.0.0, a breaking change bumps the minor version.
  expect(nextVersion("v0.2.3", ["feat!: c"])).toBe("0.3.0");
  expect(nextVersion("v1.2.3", ["feat!: c"])).toBe("2.0.0");
  expect(nextVersion("v1.2.3", ["docs: d"])).toBe("1.2.4");
  expect(() => nextVersion("latest", ["fix: a"])).toThrow();
});

test("release notes list commit subjects", () => {
  expect(releaseNotes(["feat: a (#2)\n\nbody", "fix: b (#1)"])).toBe(
    "- feat: a (#2)\n- fix: b (#1)",
  );
});
