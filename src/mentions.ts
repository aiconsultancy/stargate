import { z } from "zod";

/**
 * Names that address a bot without a typed Slack mention, shared by spoken
 * and text mentions. Each name is literal; spelling variants must be listed.
 */
export const mentionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}' -]*$/u);
export const mentionNamesSchema = z.array(mentionNameSchema).min(1).max(20);

/** Channel IDs only: not DMs, which need no mention, and not `*`. */
export const mentionChannelsSchema = z
  .array(z.string().regex(/^[CG][A-Z0-9]+$/))
  .min(1)
  .max(50);

export const mentionRuleSchema = z.strictObject({
  channels: mentionChannelsSchema,
  names: mentionNamesSchema,
});

/** Wake phrases are only an explicit subset of existing Slack text aliases. */
export const textMentionRuleSchema = mentionRuleSchema
  .extend({ muteBypassNames: z.array(mentionNameSchema).max(20).optional() })
  .superRefine((rule, context) => {
    if (rule.muteBypassNames?.some((name) => !rule.names.includes(name)))
      context.addIssue({
        code: "custom",
        path: ["muteBypassNames"],
        message: "Mute bypass names must be configured text-mention names.",
      });
  });

const pattern = (name: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${name
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+")}(?![\\p{L}\\p{N}])`,
    "iu",
  );

/**
 * The configured name that the texts contain as whole words, in any letter
 * case. The longest match wins, so "all captains" beats "captains".
 */
export function findMention(
  texts: readonly string[],
  names: readonly string[],
): string | undefined {
  return [...names]
    .sort((a, b) => b.length - a.length)
    .find((name) => {
      const match = pattern(name);
      return texts.some((text) => match.test(text));
    });
}

/**
 * Slack message text as people read it: a link shows only its label, a bare
 * link, user/channel mention or special mention adds no words, and emoji
 * codes such as `:captains:` are not words.
 */
export function visibleText(text: string) {
  return text
    .replace(
      /<([^<>|]*)\|([^<>]*)>/g,
      (_match, target: string, label: string) =>
        /^[#@!]/.test(target) ? " " : ` ${label} `,
    )
    .replace(/<[^<>]*>/g, " ")
    .replace(/:[a-z0-9_+'-]+:/gi, " ");
}

/** Prompt marker for a message admitted because its text named the bot. */
export function textMentionNote(name: string) {
  return `[Admitted by text mention: ${name}]`;
}

/** Persistent captain instructions, never a per-message user prefix. */
export const textMentionInstructions = `Text mentions:
A message that starts with [Admitted by text mention: NAME] did not mention
you with a Slack mention. Its text contained NAME, for example a call to all
captains. Reply only if its content needs an answer from you. Otherwise
answer with [[stargate:silent]].`;
