import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "../src/config/companion-environment";

test("the companion fills missing values without replacing the process environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-companion-"));
  const path = join(directory, "stargate.json");
  const existing = "STARGATE_TEST_COMPANION_EXISTING";
  const missing = "STARGATE_TEST_COMPANION_MISSING";

  const before = new Map(
    [existing, missing].map((key) => [key, process.env[key]]),
  );

  try {
    process.env[existing] = "";
    delete process.env[missing];

    await loadEnvironment(path);
    expect(process.env[missing]).toBeUndefined();

    await writeFile(`${path}.env`, `${existing}=file\n${missing}=companion\n`);
    await loadEnvironment(path);
    expect(process.env[existing]).toBe("");
    expect(process.env[missing]).toBe("companion");
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    await rm(directory, { recursive: true });
  }
});
