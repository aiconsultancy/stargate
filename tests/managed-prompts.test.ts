import { expect, test } from "bun:test";
import { managedPrompt } from "../src/crew/instructions";

test("managed prompts use one valid HTML comment boundary pair", () => {
  expect(
    managedPrompt("# Stargate instructions\n\nKeep durable sessions.\n"),
  ).toBe(
    "<!-- STARGATE:START -->\n# Stargate instructions\n\nKeep durable sessions.\n<!-- STARGATE:END -->\n",
  );
});

test("managed prompt comments follow native YAML frontmatter", () => {
  for (const newline of ["\n", "\r\n"]) {
    const frontmatter = `---${newline}description: Captain${newline}mode: primary${newline}---${newline}`;
    expect(
      managedPrompt(`${frontmatter}${newline}Captain instructions.\n`),
    ).toBe(
      `${frontmatter}\n<!-- STARGATE:START -->\nCaptain instructions.\n<!-- STARGATE:END -->\n`,
    );
  }
});

test("managed prompt bodies cannot insert ambiguous boundary markers", () => {
  for (const marker of ["<!-- STARGATE:START -->", "<!-- STARGATE:END -->"]) {
    expect(() =>
      managedPrompt(`User instructions\n${marker}\nExtra text`),
    ).toThrow("reserved managed-prompt markers");
  }
});
