import { expect, test } from "bun:test";
import { managedPrompt } from "../src/crew/instructions";

test("managed prompts use one valid HTML comment boundary pair", () => {
  expect(managedPrompt("# Pogo instructions\n\nKeep durable sessions.\n")).toBe(
    "<!-- POGO:START -->\n# Pogo instructions\n\nKeep durable sessions.\n<!-- POGO:END -->\n",
  );
});

test("managed prompt comments follow native YAML frontmatter", () => {
  for (const newline of ["\n", "\r\n"]) {
    const frontmatter = `---${newline}description: Captain${newline}mode: primary${newline}---${newline}`;
    expect(
      managedPrompt(`${frontmatter}${newline}Captain instructions.\n`),
    ).toBe(
      `${frontmatter}\n<!-- POGO:START -->\nCaptain instructions.\n<!-- POGO:END -->\n`,
    );
  }
});

test("managed prompt bodies cannot insert ambiguous boundary markers", () => {
  for (const marker of ["<!-- POGO:START -->", "<!-- POGO:END -->"]) {
    expect(() =>
      managedPrompt(`User instructions\n${marker}\nExtra text`),
    ).toThrow("reserved managed-prompt markers");
  }
});
