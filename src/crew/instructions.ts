import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CrewMember } from "./team";

export function managedPrompt(text: string) {
  const start = "<!-- STARGATE:START -->";
  const end = "<!-- STARGATE:END -->";
  if (text.includes(start) || text.includes(end)) {
    throw new Error("Instructions contain reserved managed-prompt markers.");
  }
  const frontmatter =
    text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
  const body = text.slice(frontmatter.length).trim();
  const block = `${start}\n${body}\n${end}\n`;
  return frontmatter
    ? `${frontmatter}${frontmatter.endsWith("\n") ? "\n" : "\n\n"}${block}`
    : block;
}

/** Small local file: compare content, not timestamps. Never publish its text. */
export function workingAgreementNotice(path: string) {
  const seen = new Map<string, string>();
  return async (key: string): Promise<string | undefined> => {
    try {
      const hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      const previous = seen.get(key);
      seen.set(key, hash);
      return previous && previous !== hash
        ? `Shared working agreement changed: ${JSON.stringify(path)}. Reread this file before continuing.`
        : undefined;
    } catch {
      // Missing/unreadable files do not erase the last successful observation.
      return undefined;
    }
  };
}

export function workingAgreementContext(
  path: string,
  authorize: (caller: {
    sessionID: string;
    agent: string;
    signal: AbortSignal;
  }) => Promise<void>,
) {
  const notice = workingAgreementNotice(path);
  return async (event: {
    sessionID: string;
    agent: string;
    system: { type: "text"; text: string }[];
  }) => {
    try {
      await authorize({
        sessionID: event.sessionID,
        agent: event.agent,
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      return;
    }
    const changed = await notice(`${event.agent}:${event.sessionID}`);
    if (changed) event.system.push({ type: "text", text: changed });
  };
}

export function piDefinitionPath(captainDirectory: string, member: CrewMember) {
  return join(
    captainDirectory,
    ".local",
    "ship",
    "definitions",
    `${member.agent ?? member.id}.md`,
  );
}

export function piMemberDefinition(
  member: CrewMember,
  directory: string,
  captainDirectory: string,
  /** Rendered nightly maintenance paragraph; empty when not configured. */
  nightly = "",
) {
  return managedPrompt(
    [
      `# ${member.name ?? member.id}`,
      `Stargate address: ${member.id}\nDefinition: ${member.agent ?? member.id}\nRole: ${member.role}\nWorktree: ${directory}`,
      `Use this one permanent worktree: ${directory}. Do not switch worktrees or move this durable session for a task. Create or switch task branches inside this worktree. Temporary work in tmp directories is allowed; use explicit command paths without changing the session's worktree. Report directory drift to the captain.`,
      `Before project work, read ${join(directory, "AGENTS.md")}, applicable nested project instructions, relevant guides and required skills. Follow the project's implementation, verification and delivery rules; ship coordination does not replace them.`,
      "Child agents use their own standard tools, never Stargate tools or prefixed names; do not nest children.",
      "Reply on IRC only when tagged, asked directly, or once per all-call.",
      `Shared working agreement: ${join(captainDirectory, "WAYS_OF_WORKING.md")}. Read it initially and reread it when updated. Captain maintains it; propose edits by mail. Prefer Stargate coordination tools; use authenticated native APIs within your existing authority for gaps and record useful workarounds with stargate_journal. pi_history reads your own native history. Mail never wakes; only explicit DM does. Final answers remain task results, not peer replies.`,
      nightly,
      member.instructions,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}
