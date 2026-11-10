import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type CronjobDefinition,
  cronjobNameSchema,
  listCronjobNames,
  parseCronjob,
  readCronjob,
  renderCronjob,
  writeCronjob,
} from "../src/cronjob-files";

const now = Date.parse("2026-01-01T00:00:00Z");
const basic = `---
name: daily-report
description: Prepare the daily report
schedule: '0 9 * * *' # YAML comments are accepted
---
# Report

Read supporting files and prepare the report.`;
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp("/tmp/opencode/cronjob-files-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("cronjob files", () => {
  test("parses Markdown, YAML comments, defaults, skills and Slack", () => {
    const def = parseCronjob(basic, "daily-report", now);
    expect(def).toMatchObject({
      name: "daily-report",
      timezone: "UTC",
      skills: [],
      enabled: true,
      report: "immediate",
      prompt: "# Report\n\nRead supporting files and prepare the report.",
    });
    const full = parseCronjob(
      basic.replace(
        "---\n# Report",
        "timezone: America/New_York\nskills: [local-doc-search, report]\nenabled: false\nslack:\n  channel: C123ABC\n  user: U123ABC\n---\n# Report",
      ),
      "daily-report",
      now,
    );
    expect(full.skills).toEqual(["local-doc-search", "report"]);
    expect(full.enabled).toBe(false);
    expect(full.slack).toEqual({ channel: "C123ABC", user: "U123ABC" });
    expect(parseCronjob(renderCronjob(full), full.name, now)).toEqual(full);
    expect(
      parseCronjob(basic.replaceAll("\n", "\r\n"), def.name, now).name,
    ).toBe(def.name);
  });

  test("defaults report mode, preserves daily and rejects unknown modes", () => {
    const definition = parseCronjob(basic, "daily-report", now);
    const { report, ...legacy } = definition;
    expect(report).toBe("immediate");
    expect(parseCronjob(renderCronjob(legacy), legacy.name, now).report).toBe(
      "immediate",
    );
    const daily = parseCronjob(
      basic.replace("---\n# Report", "report: daily\n---\n# Report"),
      definition.name,
      now,
    );
    expect(daily.report).toBe("daily");
    expect(parseCronjob(renderCronjob(daily), daily.name, now)).toEqual(daily);
    expect(() =>
      parseCronjob(
        basic.replace("---\n# Report", "report: weekly\n---\n# Report"),
        definition.name,
        now,
      ),
    ).toThrow("Invalid cronjob frontmatter fields.");
  });

  test("rejects unsafe and reserved names before resolving paths", () => {
    for (const name of [
      "",
      ".",
      "..",
      "../escape",
      "/absolute",
      "a/b",
      "a\\b",
      ".hidden",
      "UPPER",
      "two--parts",
      "trailing-",
      "con",
      "nul",
      "com1",
      "a".repeat(65),
    ]) {
      expect(cronjobNameSchema.safeParse(name).success).toBe(false);
      expect(() => parseCronjob(basic, name, now)).toThrow(
        "Invalid cronjob name",
      );
    }
    expect(cronjobNameSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(() => parseCronjob(basic, "different-name", now)).toThrow(
      "mismatch",
    );
  });

  test("rejects invalid fields, schedules, timezones and bodies", () => {
    for (const extra of [
      "unknown: private-secret",
      "skills: [../escape]",
      "skills: [UPPER]",
      "skills: report",
      "enabled: yes",
      "slack: {channel: nope, user: U123}",
      "slack: {channel: C123, user: U123, extra: secret}",
    ]) {
      expect(() =>
        parseCronjob(
          basic.replace("---\n#", `${extra}\n---\n#`),
          "daily-report",
          now,
        ),
      ).toThrow();
    }
    for (const schedule of [
      "@daily",
      "0 0 9 * * *",
      "61 * * * *",
      "0 0 31 2 *",
    ])
      expect(() =>
        parseCronjob(basic.replace("0 9 * * *", schedule), "daily-report", now),
      ).toThrow();
    expect(() =>
      parseCronjob(
        basic.replace("---\n#", "timezone: secret/invalid\n---\n#"),
        "daily-report",
        now,
      ),
    ).toThrow("Invalid cron timezone");
    expect(() =>
      parseCronjob(`${basic.split("---\n#")[0]}---\n`, "daily-report", now),
    ).toThrow();
    expect(() =>
      parseCronjob(`${basic}\n${" ".repeat(12_000)}`, "daily-report", now),
    ).toThrow("prompt exceeds");
    expect(() => parseCronjob("x".repeat(65_537), "daily-report", now)).toThrow(
      "file exceeds",
    );
    expect(() => parseCronjob(basic, "daily-report", Number.NaN)).toThrow();
    expect(() => parseCronjob(`\n${basic}`, "daily-report", now)).toThrow(
      "delimiters",
    );
    expect(() =>
      parseCronjob(
        "---\nname: [private-secret\n---\nPrompt",
        "daily-report",
        now,
      ),
    ).toThrow(/^Invalid cronjob YAML\.$/);
  });

  test("writes private files, preserves supporting files and refuses replacement", async () => {
    const root = join(await fixture(), "cronjobs");
    const definition = parseCronjob(basic, "daily-report", now);
    const path = await writeCronjob(root, definition, now);
    expect(path).toBe(join(root, definition.name, "CRONJOB.md"));
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, definition.name))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const support = join(root, definition.name, "notes.md");
    await writeFile(support, "Keep this file.");
    expect(await writeCronjob(root, definition, now)).toBe(path);
    expect(await readCronjob(root, definition.name, now)).toEqual(definition);
    await expect(
      writeCronjob(root, { ...definition, prompt: "Different" }, now),
    ).rejects.toThrow("different definition");
    expect(await readFile(support, "utf8")).toBe("Keep this file.");
    expect((await readdir(join(root, definition.name))).sort()).toEqual([
      "CRONJOB.md",
      "notes.md",
    ]);
    expect(await listCronjobNames(root)).toEqual(["daily-report"]);
  });

  test("validates writes before creating directories", async () => {
    const root = join(await fixture(), "absent");
    const definition: CronjobDefinition = {
      ...parseCronjob(basic, "daily-report", now),
      schedule: "@daily",
    };
    await expect(writeCronjob(root, definition, now)).rejects.toThrow();
    expect(await listCronjobNames(root)).toEqual([]);
    await expect(lstat(root)).rejects.toThrow();
  });

  test("lists only valid immediate nonhidden directories with a hard limit", async () => {
    const root = await fixture();
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "INVALID"));
    await writeFile(join(root, "ordinary-file"), "not a directory");
    await mkdir(join(root, "valid-job"));
    await mkdir(join(root, "valid-job", "nested"));
    expect(await listCronjobNames(root)).toEqual(["valid-job"]);
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => mkdir(join(root, `job-${i}`))),
    );
    await expect(listCronjobNames(root)).rejects.toThrow("Too many");
  });

  test("refuses root, ancestor, job and definition symlinks", async () => {
    const parent = await fixture();
    const real = join(parent, "real");
    await mkdir(real);
    const alias = join(parent, "alias");
    await symlink(real, alias);
    const definition = parseCronjob(basic, "daily-report", now);
    for (const root of [alias, join(alias, "nested")]) {
      await expect(listCronjobNames(root)).rejects.toThrow("Unsafe");
      await expect(writeCronjob(root, definition, now)).rejects.toThrow(
        "Unsafe",
      );
      await expect(readCronjob(root, definition.name, now)).rejects.toThrow(
        "Unsafe",
      );
    }
    const root = join(parent, "jobs");
    await mkdir(root);
    const job = join(root, definition.name);
    await symlink(real, job);
    await expect(listCronjobNames(root)).rejects.toThrow("Unsafe");
    await expect(writeCronjob(root, definition, now)).rejects.toThrow("Unsafe");
    await expect(readCronjob(root, definition.name, now)).rejects.toThrow(
      "Unsafe",
    );
    await rm(job);
    await mkdir(job);
    const target = join(real, "target.md");
    await writeFile(target, basic);
    await symlink(target, join(job, "CRONJOB.md"));
    await expect(listCronjobNames(root)).rejects.toThrow("Unsafe");
    await expect(writeCronjob(root, definition, now)).rejects.toThrow("Unsafe");
    await expect(readCronjob(root, definition.name, now)).rejects.toThrow(
      "Unsafe",
    );
    expect(await readFile(target, "utf8")).toBe(basic);
    expect(await readdir(job)).toEqual(["CRONJOB.md"]);
  });

  test("bounds file reads and refuses nonregular definitions", async () => {
    const root = await fixture();
    const job = join(root, "daily-report");
    await mkdir(job);
    const path = join(job, "CRONJOB.md");
    await writeFile(path, "x".repeat(65_537));
    await expect(readCronjob(root, "daily-report", now)).rejects.toThrow(
      "size limit",
    );
    await rm(path);
    await mkdir(path);
    await expect(readCronjob(root, "daily-report", now)).rejects.toThrow(
      "Unsafe",
    );
  });
});
