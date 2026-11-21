import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { cronAdvancedFields } from "./cron-advanced";
import { validateCronInput } from "./cron-input";

const maxBytes = 64 * 1024;
const safeId = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const cronjobNameSchema = safeId.refine(
  (name) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name),
);
const frontmatterSchema = z.strictObject({
  name: cronjobNameSchema,
  description: z.string().trim().min(1).max(1000),
  schedule: z.string().optional(),
  ...cronAdvancedFields,
  timezone: z.string().default("UTC"),
  skills: z.array(safeId).max(100).default([]),
  enabled: z.boolean().default(true),
  report: z.enum(["immediate", "daily"]).default("immediate"),
  slack: z
    .strictObject({
      channel: z.string().regex(/^[CGD][A-Z0-9]+$/),
      user: z.string().regex(/^[UW][A-Z0-9]+$/),
    })
    .optional(),
});

export type CronjobDefinition = z.infer<typeof frontmatterSchema> & {
  prompt: string;
};

function validName(name: string): string {
  const result = cronjobNameSchema.safeParse(name);
  if (!result.success) throw new Error("Invalid cronjob name.");
  return result.data;
}

/** Parser failures never include supplied YAML or prompt text. */
export function parseCronjob(
  text: string,
  name: string,
  now: number,
): CronjobDefinition {
  validName(name);
  if (Buffer.byteLength(text) > maxBytes)
    throw new Error("Cronjob file exceeds size limit.");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Invalid cronjob frontmatter delimiters.");
  let yaml: unknown;
  try {
    yaml = Bun.YAML.parse(match[1] ?? "");
  } catch {
    throw new Error("Invalid cronjob YAML.");
  }
  const parsed = frontmatterSchema.safeParse(yaml);
  if (!parsed.success) throw new Error("Invalid cronjob frontmatter fields.");
  const metadata = parsed.data;
  if (metadata.name !== name) throw new Error("Cronjob folder name mismatch.");
  const body = text.slice(match[0].length);
  if (body.length > 12_000)
    throw new Error("Cronjob prompt exceeds size limit.");
  const { input } = validateCronInput(
    {
      name,
      expression: metadata.schedule ?? "",
      timezone: metadata.timezone,
      prompt: body,
      trigger: metadata.trigger,
      model: metadata.model,
      once: metadata.once,
      arbiter: metadata.arbiter,
    },
    now,
  );
  return {
    ...metadata,
    ...(input.expression ? { schedule: input.expression } : {}),
    timezone: input.timezone,
    prompt: input.prompt,
  };
}

export function renderCronjob(
  definition: Omit<CronjobDefinition, "report"> & {
    report?: CronjobDefinition["report"];
  },
): string {
  const { prompt, ...metadata } = definition;
  const parsed = frontmatterSchema.safeParse(metadata);
  if (!parsed.success || typeof prompt !== "string")
    throw new Error("Invalid cronjob definition.");
  // One delimiter newline belongs to the format, not to the Markdown body.
  return `---\n${Bun.YAML.stringify(parsed.data).trimEnd()}\n---\n${prompt}`;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Check every ancestor too: an ordinary final directory can hide a symlink. */
async function directory(path: string, create = false): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe cronjob directory.");
  }
}

export async function readCronjob(
  root: string,
  name: string,
  now: number,
): Promise<CronjobDefinition> {
  validName(name);
  const job = resolve(root, name);
  await directory(job);
  const path = join(job, "CRONJOB.md");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Unsafe cronjob file.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Unsafe cronjob file.");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("Cronjob file exceeds size limit.");
    return parseCronjob(buffer.subarray(0, length).toString("utf8"), name, now);
  } finally {
    await handle.close();
  }
}

export async function listCronjobNames(root: string): Promise<string[]> {
  try {
    await directory(root);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!cronjobNameSchema.safeParse(entry.name).success) continue;
    if (entry.isSymbolicLink()) throw new Error("Unsafe cronjob directory.");
    if (!entry.isDirectory()) continue;
    await directory(join(root, entry.name));
    try {
      const file = await lstat(join(root, entry.name, "CRONJOB.md"));
      if (file.isSymbolicLink() || !file.isFile())
        throw new Error("Unsafe cronjob file.");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    names.push(entry.name);
    if (names.length > 100) throw new Error("Too many cronjob directories.");
  }
  return names.sort();
}

export async function writeCronjob(
  root: string,
  definition: CronjobDefinition,
  now: number,
): Promise<string> {
  const text = renderCronjob(definition);
  const normalized = parseCronjob(text, definition.name, now);
  await directory(root, true);
  const job = resolve(root, normalized.name);
  await directory(job, true);
  const path = join(job, "CRONJOB.md");
  const temporary = join(dirname(path), `.cronjob-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(renderCronjob(normalized));
    } finally {
      await handle.close();
    }
    try {
      // Publish complete bytes without replacing an existing definition.
      await link(temporary, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await readCronjob(root, normalized.name, now);
      if (renderCronjob(existing) !== renderCronjob(normalized))
        throw new Error("Cronjob already exists with a different definition.");
    }
    return path;
  } finally {
    await unlink(temporary);
  }
}
