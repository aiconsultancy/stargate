import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";

test("backend contract has no executable dependency on adapters or factory", async () => {
  const source = await readFile(
    new URL("../src/backend.ts", import.meta.url),
    "utf8",
  );
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const imports = transpiler.scanImports(transpiler.transformSync(source));
  expect(
    imports.some(
      ({ path }) =>
        path.includes("backends/") || path.includes("backend-factory"),
    ),
  ).toBe(false);
});
