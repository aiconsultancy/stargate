/** Keep Slack notification controls literal, including incomplete streamed ones. */
const slackControls =
  /<[@#]|<!(?:here|channel|everyone|subteam\^|date\^)|(?:^|\s)@(?:here|channel|everyone)\b/i;

export function slackContent(
  text: string,
  format: "markdown" | "plain" = "markdown",
) {
  // greybeard: use Slack's native Markdown renderer, not a second Markdown parser.
  // Chunks with Slack controls stay literal; mixed rich mentions need a structured renderer.
  const blocks =
    format === "markdown" && !slackControls.test(text)
      ? [{ type: "markdown" as const, text }]
      : [
          {
            type: "section" as const,
            text: { type: "plain_text" as const, text, emoji: false },
          },
        ];
  return {
    text: text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
    blocks,
  };
}
