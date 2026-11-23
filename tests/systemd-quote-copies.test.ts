import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { quote as serviceQuote } from "../src/app/service";
import { quote as timerQuote } from "../src/automation/maintenance/nightly/schedule/timer";

const root = join(import.meta.dir, "..");

async function quoteSource(path: string) {
  const text = await readFile(join(root, path), "utf8");
  const start = text.indexOf("export function quote(");
  expect(start).toBeGreaterThanOrEqual(0);

  return text.slice(start, text.indexOf("\n}\n", start) + 3);
}

test("the nightly timer's systemd quote copy matches the service copy", async () => {
  expect(
    await quoteSource("src/automation/maintenance/nightly/schedule/timer.ts"),
  ).toBe(await quoteSource("src/app/service.ts"));

  for (const [value, command] of [
    ["/usr/bin/bun", true],
    ['a "b" \\c % $HOME', true],
    ['a "b" \\c % $HOME', false],
    ["PATH=/a b:/c", false],
  ] as const)
    expect(timerQuote(value, command)).toBe(serviceQuote(value, command));
  expect(() => timerQuote("a\nb")).toThrow(
    "Service paths cannot contain control characters.",
  );
});
