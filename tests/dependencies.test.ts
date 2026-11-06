import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { z } from "zod";

test("Pi runtime packages stay pinned to one release", async () => {
  const { dependencies } = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(await Bun.file(new URL("../package.json", import.meta.url)).json());
  const versions = [
    "@earendil-works/chord",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-durable",
  ].map((name) =>
    z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .parse(dependencies[name]),
  );
  expect(new Set(versions).size).toBe(1);
});

test("dependency provenance checks every page, signature, count, and current head", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        quality: z.object({
          steps: z.array(
            z.object({ name: z.string(), run: z.string().optional() }),
          ),
        }),
      }),
    })
    .parse(
      Bun.YAML.parse(
        await Bun.file(
          new URL("../.github/workflows/check.yml", import.meta.url),
        ).text(),
      ),
    );
  const script = workflow.jobs.quality.steps.find(
    ({ name }) => name === "Verify dependency commit provenance",
  )?.run;
  const filter = script?.split("jq -e")[1]?.match(/'([\s\S]+)'/)?.[1];
  if (!filter) throw new Error("Missing dependency provenance filter");
  const trusted = {
    sha: "head",
    author: { login: "dependabot[bot]" },
    commit: { verification: { verified: true } },
  };
  const first = { ...trusted, sha: "first" };
  const status = (pages: unknown[][], count: number, head = "head") =>
    spawnSync(
      "jq",
      [
        "-e",
        "--argjson",
        "count",
        String(count),
        "--arg",
        "head",
        head,
        filter,
      ],
      { input: JSON.stringify(pages), encoding: "utf8" },
    ).status;
  expect(status([[trusted]], 1)).toBe(0);
  expect(status([[first], [trusted]], 2)).toBe(0);
  expect(
    status([[first], [{ ...trusted, author: { login: "maintainer" } }]], 2),
  ).toBe(1);
  expect(
    status(
      [[{ ...trusted, commit: { verification: { verified: false } } }]],
      1,
    ),
  ).toBe(1);
  expect(status([[trusted]], 2)).toBe(1);
  expect(status([[trusted]], 1, "new-head")).toBe(1);
  expect(status([[]], 0)).toBe(1);
});
