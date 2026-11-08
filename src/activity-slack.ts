import type { ActivityView } from "./activity";
import { slackContent } from "./slack-format";

const statuses = {
  collecting: "Collecting activity",
  summarizing: "Preparing report",
  complete: "Report complete",
  unavailable: "Report unavailable",
  cancelled: "Report cancelled",
} satisfies Record<ActivityView["status"], string>;

function bounded(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 2).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

function plain(text: string, max = 3000) {
  return {
    type: "plain_text" as const,
    text: bounded(text, max),
    emoji: false,
  };
}

/** Crew/model text is always literal, never Slack markup or notification syntax. */
export function activityContent(view: ActivityView) {
  const status = statuses[view.status];
  const facts = view.entries
    .slice(-5)
    .map(
      (entry) =>
        `${entry.member}${entry.taskID ? ` (${entry.taskID})` : ""}: ${bounded(entry.text.replace(/\s+/g, " "), 350)}`,
    )
    .join("\n");
  const summary = bounded(
    view.summaryCurrent && view.summary
      ? view.summary
      : [facts, view.summary || `${status}.`].filter(Boolean).join("\n\n"),
    3000,
  );
  const details =
    view.detail === "detailed"
      ? view.entries
          .slice(0, 8)
          .map((entry) =>
            bounded(
              `${bounded(entry.member, 100)} — ${entry.kind}\n${bounded(entry.text, 1500)}`,
              3000,
            ),
          )
      : [];
  const context = `${status}.${view.truncated ? " Activity shortened; some details are omitted." : ""}`;
  // greybeard: bounded accessible fallback, not a second rich-text renderer.
  // 6500 characters remain below Slack's 40000 limit after entity escaping.
  const fallback = bounded(
    [
      `Crew activity — ${bounded(view.reporter, 100)} — ${status}`,
      summary,
      ...details,
      context,
    ].join("\n\n"),
    6500,
  );
  return {
    text: slackContent(fallback, "plain").text,
    blocks: [
      {
        type: "container" as const,
        title: plain("Crew activity", 150),
        subtitle: plain(`${bounded(view.reporter, 100)} — ${status}`, 150),
        is_collapsible: true,
        default_collapsed: true,
        child_blocks: [
          { type: "section" as const, text: plain(summary) },
          ...details.map((text) => ({
            type: "section" as const,
            text: plain(text),
          })),
          { type: "context" as const, elements: [plain(context)] },
        ],
      },
    ],
  };
}
