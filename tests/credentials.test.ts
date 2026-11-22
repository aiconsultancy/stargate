import { expect, test } from "bun:test";
import { containsCredential, redactCredentials } from "../src/lib/credentials";

const samples: [text: string, secret: string][] = [
  ["xoxb-111-slack", "111-slack"],
  ["Authorization: Bearer bearer-value", "bearer-value"],
  ["password='quoted value'", "quoted value"],
  ['"API_KEY": "json-value"', "json-value"],
];

test("redaction and detection use the same rules", () => {
  for (const [text, secret] of samples) {
    expect(containsCredential(text)).toBe(true);
    const redacted = redactCredentials(`before ${text} after`);
    expect(redacted).toContain("[REDACTED");
    expect(redacted).not.toContain(secret);
  }

  expect(containsCredential("an ordinary sentence")).toBe(false);
  expect(redactCredentials("an ordinary sentence")).toBe(
    "an ordinary sentence",
  );
});

test("redaction removes control characters and applies the limit", () => {
  expect(redactCredentials("a\u0000b\u001bc\td\ne\rf")).toBe("abc\td\ne\rf");
  expect(redactCredentials("x".repeat(2000))).toHaveLength(1500);
  expect(redactCredentials("x".repeat(2000), 10)).toHaveLength(10);
  // The limit applies after redaction: a credential at the cut never leaks.
  expect(redactCredentials(`${"x".repeat(1495)} xoxb-111-slack`)).not.toContain(
    "xoxb",
  );
});
