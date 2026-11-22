import { expect, test } from "bun:test";
import { compareJavaScript } from "../scripts/compare-js-emit";

test.each([
  ["changed numeric value", "f(10000);", "f(10001);"],
  ["changed string value", 'f("a");', 'f("b");'],
  ["changed tagged raw value", "tag`\\x41`;", "tag`\\u0041`;"],
  ["changed tagged raw segment", "tag`x${f()}\\x41`;", "tag`x${f()}\\u0041`;"],
  ["changed order", "f(); g();", "g(); f();"],
  ["changed unary operator", "f(+x);", "f(-x);"],
  [
    "changed directive spelling",
    '"use strict"; f();',
    '"use\\x20strict"; f();',
  ],
  ["changed identifier spelling", "f(value);", "f(valu\\u0065);"],
  ["array hole", "f([1]);", "f([1,,]);"],
  ["declaration kind", "const x = 1;", "let x = 1;"],
])("rejects %s", async (_reason, before, after) => {
  expect((await compareJavaScript(before, after)).equal).toBe(false);
});

test.each([
  ["numeric form", "f(1e4);", "f(10000);"],
  ["numeric form", "f(100_000n);", "f(100000n);"],
  ["escape form", 'f("\\x41");', 'f("\\u0041");'],
  ["escape form", "f(`a${g()}\\x41`);", "f(`a${g()}\\u0041`);"],
  ["layout", "f(1, 2);", "f(\n  1,\n  2\n);"],
  ["layout", "f({ a: [1, 2] });", "f({ a: [1, 2,], });"],
])("accepts %s without a printer", async (reason, before, after) => {
  const result = await compareJavaScript(before, after);
  expect(result.equal).toBe(true);
  expect(result.reasons).toContain(reason);
});

test("regex changes name both literal spellings for a reader", async () => {
  const result = await compareJavaScript("f(/\\x41/u);", "f(/\\u0041/u);");
  expect(result.equal).toBe(false);
  expect(result.differences).toContainEqual({
    reason: "regex",
    before: "/\\x41/u",
    after: "/\\u0041/u",
  });
});
