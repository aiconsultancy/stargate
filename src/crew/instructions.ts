import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CrewCaller } from "./engine";
import type { CrewMember } from "./team";

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
  authorize: (caller: CrewCaller) => Promise<void>,
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
) {
  return (
    [
      `# ${member.name ?? member.id}`,
      `Pogo address: ${member.id}\nDefinition: ${member.agent ?? member.id}\nRole: ${member.role}\nWorktree: ${directory}`,
      `Shared working agreement: ${join(captainDirectory, "WAYS_OF_WORKING.md")}. Read it initially and reread it when updated. Captain maintains it; propose edits by mail. Prefer Pogo coordination tools; use authenticated native APIs within your existing authority for gaps and record useful workarounds with pogo_journal. pi_history reads your own native history. Mail never wakes; only explicit DM does. Final answers remain task results, not peer replies.`,
      member.instructions,
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
