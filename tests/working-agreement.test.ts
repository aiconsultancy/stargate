import { expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workingAgreementContext,
  workingAgreementNotice,
} from "../src/coordination/crew/instructions";

test("agreement changes produce one path-only notice per member/session and survive read failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-agreement-"));
  const path = join(directory, "WAYS_OF_WORKING.md");

  try {
    await writeFile(path, "PRIVATE RULE VERSION ONE");
    const notice = workingAgreementNotice(path);
    expect(await notice("captain:root-a")).toBeUndefined();
    expect(await notice("captain:root-a")).toBeUndefined();
    expect(await notice("chief:worker")).toBeUndefined();
    await writeFile(path, "PRIVATE RULE VERSION TWO");
    const changed = await notice("captain:root-a");
    expect(changed).toContain(path);
    expect(changed).toContain("Reread");
    expect(changed).not.toContain("PRIVATE RULE");
    expect(await notice("captain:root-a")).toBeUndefined();
    expect(await notice("chief:worker")).toBe(changed);
    expect(await notice("captain:root-b")).toBeUndefined();
    await writeFile(path, "PRIVATE RULE VERSION TWO");
    expect(await notice("captain:root-a")).toBeUndefined();
    await unlink(path);
    expect(await notice("captain:root-a")).toBeUndefined();
    expect(await notice("captain:root-a")).toBeUndefined();
    await writeFile(path, "PRIVATE RULE VERSION TWO");
    expect(await notice("captain:root-a")).toBeUndefined();
    await unlink(path);
    expect(await notice("captain:root-a")).toBeUndefined();
    await writeFile(path, "PRIVATE RULE VERSION THREE");
    expect(await notice("captain:root-a")).toBe(changed);
    expect(await notice("captain:root-a")).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenCode request hook advises reread only on change for an authorized current member", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-agreement-hook-"));
  const path = join(directory, "WAYS_OF_WORKING.md");

  try {
    await writeFile(path, "DO NOT INLINE ORIGINAL RULES");

    const hook = workingAgreementContext(path, async (caller) => {
      if (
        caller.sessionID !== "root-a" ||
        caller.agent !== "ship-captain-adama"
      )
        throw new Error("Not this member");
    });

    const request = () => ({
      sessionID: "root-a",
      agent: "ship-captain-adama",
      system: [] as { type: "text"; text: string }[],
    });

    const initial = request();
    await hook(initial);
    expect(initial.system).toEqual([]);
    const unchanged = request();
    await hook(unchanged);
    expect(unchanged.system).toEqual([]);
    await writeFile(path, "DO NOT INLINE UPDATED RULES");
    const foreign = { ...request(), sessionID: "foreign" };
    await hook(foreign);
    expect(foreign.system).toEqual([]);
    const changed = request();
    await hook(changed);
    expect(changed.system).toHaveLength(1);
    expect(changed.system[0]?.text).toContain(path);
    expect(changed.system[0]?.text).toContain("Reread");
    expect(JSON.stringify(changed.system)).not.toContain("DO NOT INLINE");
    const next = request();
    await hook(next);
    expect(next.system).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
