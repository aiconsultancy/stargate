import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ErrorCode } from "@slack/web-api";
import {
  Effect,
  Result,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaParser,
} from "effect";
import {
  AttachmentUnavailable,
  checkPreparedAttachments,
  inspectAttachment,
  maxAttachments,
  type PreparedAttachment,
  preparedAttachmentSchema,
  readPreparedAttachment,
} from "../attachments/attachments";
import { botToken, botWebClient } from "../slack/bot-web";
import { type BotConfig, loadConfig } from "../config";
import { isAllowedChannel } from "../gateway/routing";
import {
  settingsCheck,
  settingsDefault,
  settingsPattern,
  settingsStruct,
} from "../config/settings-schema";
import { SlackFiles, type SlackFilesFetch } from "../slack/slack-files";
import { slackContent } from "../shared/slack-format";

/** One Slack message: the plain-text fallback section holds 3000 characters. */
export const maxPostLength = 3000;
const hourMs = 3_600_000;
/**
 * File upload ownership per post. Every file step renews it, and each Slack
 * file call is capped at 30 seconds, so a live owner never loses it mid-step.
 */
export const uploadLeaseMs = 300_000;

const postInput = settingsStruct({
  channel: Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]{2,40}$/)),
  thread_ts: Schema.optional(
    Schema.String.check(settingsPattern(/^\d{1,12}\.\d{1,12}$/)),
  ),
  text: Schema.String.check(
    Schema.makeFilter(
      (text) => text.trim() !== "" && Array.from(text).length <= maxPostLength,
      { message: `Use 1-${maxPostLength} characters of text` },
    ),
  ),
  files: Schema.mutable(
    Schema.Array(
      Schema.String.check(
        Schema.isMinCodePoints(2),
        Schema.isMaxCodePoints(4096),
      ),
    ),
  )
    .check(Schema.isMaxLength(maxAttachments))
    .pipe(settingsDefault([])),
  reply_broadcast: Schema.Boolean.pipe(settingsDefault(false)),
  /** Retry key; the captain tool defaults it to the host tool-call ID. */
  key: Schema.optional(
    Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(255)),
  ),
});
const broadcastCheck = settingsCheck<typeof postInput.Type>(
  (input, context) => {
    if (input.reply_broadcast && !input.thread_ts)
      context.addIssue({
        code: "custom",
        message: "reply_broadcast requires thread_ts",
        path: ["reply_broadcast"],
      });
  },
);
const checkedPostInput = postInput.check(broadcastCheck);
const decodePostInput = SchemaParser.decodeUnknownEffect(checkedPostInput);
const structuralPostInput = Schema.decodeUnknownResult(checkedPostInput, {
  disableChecks: true,
});

export const postInputSchema = Schema.Unknown.pipe(
  Schema.decodeTo(checkedPostInput, {
    decode: SchemaGetter.transformEffect((input, options) =>
      decodePostInput(input, options).pipe(
        Effect.catch((issue) => {
          if (
            issue._tag === "Composite" &&
            issue.issues.some(
              (child) =>
                child._tag === "Filter" && child.filter === broadcastCheck,
            )
          )
            return Effect.fail(issue);
          // Non-aborting field constraints must not hide the original post
          // refinement. Structural failures still stop it, as in Zod.
          const structural = structuralPostInput(input);
          if (Result.isFailure(structural)) return Effect.fail(issue);
          const diagnostic = broadcastCheck.run(
            structural.success,
            checkedPostInput.ast,
            options,
          );
          return Effect.fail(
            diagnostic
              ? new SchemaIssue.Composite(checkedPostInput.ast, [
                  issue,
                  new SchemaIssue.Filter(broadcastCheck, diagnostic),
                ])
              : issue,
          );
        }),
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);
export type PostInput = typeof postInputSchema.Type;

/** Safe, caller-facing message; never contains Slack payloads or text. */
export class CaptainPostError extends Error {}

export type PostBinding = {
  configPath: string;
  bot: string;
  expectedDirectory: string;
  captainSessionID?: string | undefined;
};

/** One audit line: identifiers and sizes, never message text or paths. */
export type PostAudit = {
  event: "stargate_post";
  bot: string;
  channel: string;
  thread: string | null;
  ts: string | null;
  length: number;
  files: number;
  status: PostStatus;
  replay: boolean;
};

type FileStatus =
  | "pending"
  | "uploading"
  | "completing"
  | "shared"
  | "unavailable"
  | "uncertain";
type FileState = {
  file: PreparedAttachment;
  status: FileStatus;
  fileID?: string;
};
type PostStatus = "sending" | "posted" | "failed" | "uncertain";
type PostRow = {
  channel: string;
  thread: string | null;
  length: number;
  status: PostStatus;
  ts: string | null;
  permalink: string | null;
  error: string | null;
  files: FileState[];
  fingerprint: string;
};

const fileStateSchema = settingsStruct({
  file: preparedAttachmentSchema,
  status: Schema.Literals([
    "pending",
    "uploading",
    "completing",
    "shared",
    "unavailable",
    "uncertain",
  ]),
  fileID: Schema.optional(Schema.String),
});

/** Private SQLite record of each post: persisted before Slack is called. */
export class CaptainPostStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Set privacy before SQLite creates WAL/SHM. Refuse symlink targets.
      const fd = openSync(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error("Invalid post database.");
        fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
    }
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS captain_posts (
        botKey TEXT NOT NULL, requestKey TEXT NOT NULL,
        fingerprint TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT,
        length INTEGER NOT NULL, status TEXT NOT NULL, ts TEXT,
        permalink TEXT, error TEXT, files TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        uploadOwner TEXT, uploadLeaseUntil INTEGER,
        PRIMARY KEY (botKey, requestKey)
      );
      CREATE INDEX IF NOT EXISTS captain_posts_window
        ON captain_posts(botKey, createdAt);
    `);
    this.db
      .transaction(() => {
        const columns = this.db
          .query<{ name: string }, []>("PRAGMA table_info(captain_posts)")
          .all()
          .map(({ name }) => name);
        if (!columns.includes("uploadOwner"))
          this.db.exec(`
            ALTER TABLE captain_posts ADD COLUMN uploadOwner TEXT;
            ALTER TABLE captain_posts ADD COLUMN uploadLeaseUntil INTEGER;
          `);
      })
      .immediate();
  }

  close() {
    this.db.close();
  }

  get(botKey: string, requestKey: string): PostRow | undefined {
    const row = this.db
      .query<Omit<PostRow, "files"> & { files: string }, [string, string]>(
        `SELECT channel, thread, length, status, ts, permalink, error, files,
          fingerprint FROM captain_posts WHERE botKey = ? AND requestKey = ?`,
      )
      .get(botKey, requestKey);
    if (!row) return;
    return {
      ...row,
      files: Schema.decodeUnknownSync(
        Schema.mutable(Schema.Array(fileStateSchema)),
      )(JSON.parse(row.files)),
    } as PostRow;
  }

  /**
   * Atomically return an existing record, refuse over the rolling hourly
   * limit, or insert a `sending` record. Retries do not count again.
   */
  admit(
    botKey: string,
    requestKey: string,
    draft: Omit<PostRow, "status" | "ts" | "permalink" | "error">,
    now: number,
    perHour: number,
    owner: string,
  ): { row: PostRow; created: boolean } | { limited: number; retryAt: number } {
    return this.db
      .transaction(() => {
        const existing = this.get(botKey, requestKey);
        if (existing) return { row: existing, created: false };
        const window = this.db
          .query<{ count: number; oldest: number | null }, [string, number]>(
            `SELECT count(*) AS count, min(createdAt) AS oldest
             FROM captain_posts WHERE botKey = ? AND createdAt > ?`,
          )
          .get(botKey, now - hourMs);
        if ((window?.count ?? 0) >= perHour)
          return {
            limited: perHour,
            retryAt: (window?.oldest ?? now) + hourMs,
          };
        this.db
          .query(
            `INSERT INTO captain_posts (botKey, requestKey, fingerprint,
              channel, thread, length, status, files, createdAt, updatedAt,
              uploadOwner, uploadLeaseUntil)
             VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?, ?)`,
          )
          .run(
            botKey,
            requestKey,
            draft.fingerprint,
            draft.channel,
            draft.thread,
            draft.length,
            JSON.stringify(draft.files),
            now,
            now,
            owner,
            now + uploadLeaseMs,
          );
        const row: PostRow = {
          ...draft,
          status: "sending",
          ts: null,
          permalink: null,
          error: null,
        };
        return { row, created: true };
      })
      .immediate();
  }

  /** Message outcome only; file states belong to the upload owner. */
  saveOutcome(botKey: string, requestKey: string, row: PostRow, now: number) {
    this.db
      .query(
        `UPDATE captain_posts SET status = ?, ts = ?, permalink = ?, error = ?,
          updatedAt = ? WHERE botKey = ? AND requestKey = ?`,
      )
      .run(
        row.status,
        row.ts,
        row.permalink,
        row.error,
        now,
        botKey,
        requestKey,
      );
  }

  /** Compare-and-set upload ownership: free, already ours, or expired. */
  claim(botKey: string, requestKey: string, owner: string, now: number) {
    return (
      this.db
        .query(
          `UPDATE captain_posts SET uploadOwner = ?, uploadLeaseUntil = ?
           WHERE botKey = ? AND requestKey = ? AND (uploadOwner IS NULL
             OR uploadOwner = ? OR uploadLeaseUntil < ?)`,
        )
        .run(owner, now + uploadLeaseMs, botKey, requestKey, owner, now)
        .changes === 1
    );
  }

  /** Owner-only file write that renews the lease; false means ownership lost. */
  saveFiles(
    botKey: string,
    requestKey: string,
    owner: string,
    files: FileState[],
    now: number,
  ) {
    return (
      this.db
        .query(
          `UPDATE captain_posts SET files = ?, updatedAt = ?,
            uploadLeaseUntil = ? WHERE botKey = ? AND requestKey = ?
            AND uploadOwner = ? AND uploadLeaseUntil >= ?`,
        )
        .run(
          JSON.stringify(files),
          now,
          now + uploadLeaseMs,
          botKey,
          requestKey,
          owner,
          now,
        ).changes === 1
    );
  }

  release(botKey: string, requestKey: string, owner: string) {
    this.db
      .query(
        `UPDATE captain_posts SET uploadOwner = NULL, uploadLeaseUntil = NULL
         WHERE botKey = ? AND requestKey = ? AND uploadOwner = ?`,
      )
      .run(botKey, requestKey, owner);
  }
}

/** Slack's `ok: false` or a rejected rate limit proves nothing was posted. */
function refusal(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return;
  if (error.code === ErrorCode.RateLimitedError) return "ratelimited";
  if (error.code !== ErrorCode.PlatformError) return;
  const code =
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "error" in error.data
      ? error.data.error
      : undefined;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code)
    ? code
    : "slack_error";
}

/**
 * Outbound posts are narrower than inbound access: the conversation must be
 * listed by ID in `captainPost.channels` and still pass `access` rules, where
 * `*` matches and denies override. DMs and group DMs are therefore allowed
 * only when listed explicitly; no Slack lookup is needed.
 */
export function postAllowed(bot: BotConfig, channel: string) {
  return (
    bot.captainPost?.channels.includes(channel) === true &&
    isAllowedChannel(bot, channel)
  );
}

async function canonicalRoots(roots: readonly string[]) {
  return (
    await Promise.all(roots.map((root) => realpath(root).catch(() => "")))
  ).filter(Boolean);
}

/** Current canonical root containing an absolute path, if any. */
function rootOf(roots: readonly string[], path: string) {
  return isAbsolute(path)
    ? roots.find((root) => inside(root, path))
    : undefined;
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function prepareFiles(
  paths: readonly string[],
  roots: readonly string[],
  signal: AbortSignal,
): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const [index, path] of paths.entries()) {
    // inspectAttachment requires the exact canonical path, so a lexical
    // check against canonical roots cannot be escaped through a symlink.
    const root = rootOf(roots, path);
    if (!root)
      throw new CaptainPostError(
        `File ${index + 1} is outside this captain's post directories; nothing was posted.`,
      );
    try {
      prepared.push(
        await inspectAttachment({ path, caption: "" }, signal, root),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new CaptainPostError(
        `File ${index + 1} unavailable (${error instanceof AttachmentUnavailable ? error.reason : "missing"}); nothing was posted.`,
      );
    }
  }
  try {
    checkPreparedAttachments(prepared);
  } catch {
    throw new CaptainPostError(
      "Files exceed the attachment limits; nothing was posted.",
    );
  }
  return prepared;
}

export type PostDependencies = {
  now(): number;
  token(bot: BotConfig, configPath: string): Promise<string>;
  /** Transport for Slack's Web API and file upload URLs. */
  fetch: SlackFilesFetch;
  audit(entry: PostAudit): void;
};

const defaults: PostDependencies = {
  now: Date.now,
  token: botToken,
  fetch: (url, init) => globalThis.fetch(url, init),
  audit: (entry) => console.error(JSON.stringify(entry)),
};

const settled = new Set<FileStatus>(["shared", "unavailable"]);

/**
 * Upload every unsettled file. Call only as the upload owner: `save` writes
 * file states and renews the lease, and returns false once ownership is lost.
 * `roots` are the current canonical post directories.
 */
async function uploadFiles(
  files: SlackFiles,
  row: PostRow,
  roots: readonly string[],
  save: () => boolean,
  signal: AbortSignal,
) {
  if (!row.ts) return;
  const thread = row.thread ?? row.ts;
  for (const state of row.files) {
    if (signal.aborted) return;
    if (settled.has(state.status)) continue;
    if (state.status === "completing" || state.status === "uncertain") {
      // Completion is one-shot. Only an observed share settles it.
      const shared =
        state.fileID !== undefined &&
        (await files
          .sharedIn(state.fileID, row.channel, thread, signal)
          .catch(() => false));
      state.status = shared ? "shared" : "uncertain";
      if (!save()) return;
      continue;
    }
    // Pending or interrupted before completion: nothing was shared yet.
    // Access is checked against current configuration, not admission roots.
    const root = rootOf(roots, state.file.path);
    let data: Uint8Array | undefined;
    if (root)
      try {
        data = (await readPreparedAttachment(state.file, signal, root)).data;
      } catch {
        if (signal.aborted) return;
      }
    if (!data) {
      state.status = "unavailable";
      delete state.fileID;
      if (!save()) return;
      continue;
    }
    try {
      const upload = await files.reserveUpload(
        state.file.name,
        data.byteLength,
        signal,
      );
      state.status = "uploading";
      state.fileID = upload.fileID;
      if (!save()) return;
      await files.putUpload(upload.url, data, signal);
    } catch {
      state.status = "pending";
      delete state.fileID;
      if (!save()) return;
      continue;
    }
    state.status = "completing";
    // Renewed immediately before the one-shot completion call.
    if (!save() || state.fileID === undefined) return;
    try {
      await files.completeUpload(
        row.channel,
        thread,
        state.fileID,
        state.file.name,
        signal,
      );
      state.status = "shared";
    } catch {
      state.status = "uncertain";
    }
    if (!save()) return;
  }
}

function result(row: PostRow, replay: boolean, busy = false) {
  const files = row.files.map(({ file, status }) => ({
    name: file.name,
    status:
      status === "shared"
        ? "shared"
        : status === "unavailable"
          ? "unavailable"
          : busy && status !== "uncertain"
            ? "in-progress"
            : status === "uncertain" || status === "completing"
              ? "unconfirmed"
              : "not-shared",
  }));
  const base = {
    channel: row.channel,
    ...(row.thread ? { thread_ts: row.thread } : {}),
    replay,
  };
  if (row.status === "posted")
    return {
      status: files.every((file) => file.status === "shared")
        ? ("posted" as const)
        : ("partial" as const),
      ...base,
      ts: row.ts,
      ...(row.permalink ? { permalink: row.permalink } : {}),
      files,
      effect: replay
        ? "already-posted-not-resent"
        : "posted-once-for-this-retry-key",
      ...(busy
        ? {
            note: "Another call is uploading these files. Retry later with the same key to read the outcome; nothing was uploaded twice.",
          }
        : files.some((file) => file.status !== "shared")
          ? {
              note: "Some files were not shared. Retry with the same key to resume not-shared files; unconfirmed files are checked, never completed again.",
            }
          : {}),
    };
  if (row.status === "failed")
    return {
      status: "failed" as const,
      ...base,
      error: row.error ?? "slack_error",
      effect: "slack-refused-nothing-posted",
    };
  return {
    status: "uncertain" as const,
    ...base,
    effect: "outcome-unconfirmed-not-resent",
    note: "The message may or may not be in Slack. Check the channel before posting again with a new call; this key never resends.",
  };
}

/** Captain post through the bound bot's own token, recorded before sending. */
export async function runCaptainPost(
  raw: unknown,
  binding: PostBinding,
  signal: AbortSignal,
  dependencies: PostDependencies = defaults,
): Promise<unknown> {
  const parsed = Schema.decodeUnknownResult(postInputSchema)(raw);
  if (Result.isFailure(parsed))
    throw new CaptainPostError(
      "Invalid stargate_post input; nothing was posted.",
    );
  const input = parsed.success;
  let admitted = false;
  let store: CaptainPostStore | undefined;
  let release: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const config = await loadConfig(binding.configPath);
    const bot = config.bots.find((bot) => bot.id === binding.bot);
    if (!bot?.captainPost)
      throw new CaptainPostError(
        "stargate_post is off for this bot; an operator must enable captainPost in its configuration.",
      );
    if (
      bot.backend.type !== "opencode" ||
      resolve(bot.backend.directory) !== resolve(binding.expectedDirectory) ||
      (binding.captainSessionID !== undefined &&
        bot.backend.sessionID !== undefined &&
        bot.backend.sessionID !== binding.captainSessionID)
    )
      throw new CaptainPostError(
        "Post binding does not match this captain's bot registration.",
      );
    if (!postAllowed(bot, input.channel))
      throw new CaptainPostError(
        "Channel is not allowed for this bot's posts; nothing was posted.",
      );
    // OpenCode's own scratch rule, read now so TMPDIR in this process applies.
    const roots = bot.captainPost.fileDirectories ?? [
      bot.backend.directory,
      join(tmpdir(), "opencode"),
    ];
    const token = await dependencies.token(bot, binding.configPath);
    const web = (stop: AbortSignal) =>
      botWebClient(token, stop, dependencies.fetch);
    const auth = await web(signal).auth.test();
    if (!auth.bot_id || !auth.team_id || !auth.user_id)
      throw new CaptainPostError("Workspace bot token required.");
    const currentRoots = await canonicalRoots(roots);
    store = new CaptainPostStore(
      join(config.dataDirectory, "captain-post.sqlite"),
    );
    const files = new SlackFiles(web, token, dependencies.fetch);
    const botKey = JSON.stringify([
      bot.id,
      bot.slack.appId,
      auth.team_id,
      auth.user_id,
    ]);
    const requestKey = input.key ?? randomUUID();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          input.channel,
          input.thread_ts ?? null,
          input.reply_broadcast,
          input.text,
          input.files,
        ]),
      )
      .digest("hex");
    const audit = (row: PostRow, replay: boolean) =>
      dependencies.audit({
        event: "stargate_post",
        bot: bot.id,
        channel: row.channel,
        thread: row.thread,
        ts: row.ts,
        length: row.length,
        files: row.files.length,
        status: row.status,
        replay,
      });
    const posts = store;
    const caller = randomUUID();
    const saveOutcome = (row: PostRow) =>
      posts.saveOutcome(botKey, requestKey, row, dependencies.now());
    const saveFiles = (row: PostRow) => () =>
      posts.saveFiles(
        botKey,
        requestKey,
        caller,
        row.files,
        dependencies.now(),
      );
    release = () => posts.release(botKey, requestKey, caller);
    const previous = store.get(botKey, requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new CaptainPostError(
          "This retry key belongs to a different post; nothing was posted.",
        );
      admitted = true;
      if (
        previous.status === "posted" &&
        previous.files.some(({ status }) => !settled.has(status))
      ) {
        if (!store.claim(botKey, requestKey, caller, dependencies.now())) {
          audit(previous, true);
          return result(previous, true, true);
        }
        // Owner now: read the latest file phases before resuming them.
        const current = store.get(botKey, requestKey) ?? previous;
        await uploadFiles(
          files,
          current,
          currentRoots,
          saveFiles(current),
          signal,
        );
        audit(current, true);
        return result(current, true);
      }
      audit(previous, true);
      return result(previous, true);
    }
    const prepared = await prepareFiles(input.files, currentRoots, signal);
    const content = slackContent(input.text, "markdown");
    signal.throwIfAborted();
    const admission = store.admit(
      botKey,
      requestKey,
      {
        channel: input.channel,
        thread: input.thread_ts ?? null,
        length: Array.from(input.text).length,
        files: prepared.map((file) => ({ file, status: "pending" })),
        fingerprint,
      },
      dependencies.now(),
      bot.captainPost.postsPerHour,
      caller,
    );
    if ("limited" in admission)
      throw new CaptainPostError(
        `Post rate limit reached (${admission.limited} per hour for this bot); nothing was posted. Try again after ${new Date(admission.retryAt).toISOString()}.`,
      );
    admitted = true;
    const { row, created } = admission;
    if (!created) {
      // A concurrent call with this key admitted first.
      if (row.fingerprint !== fingerprint)
        throw new CaptainPostError(
          "This retry key belongs to a different post; nothing was posted.",
        );
      audit(row, true);
      return result(row, true);
    }
    try {
      const chat = web(signal).chat;
      const message = {
        channel: input.channel,
        ...content,
        mrkdwn: false,
        parse: "none" as const,
        unfurl_links: false,
        unfurl_media: false,
      };
      const sent = await (input.thread_ts
        ? chat.postMessage({
            ...message,
            thread_ts: input.thread_ts,
            reply_broadcast: input.reply_broadcast,
          })
        : chat.postMessage(message));
      if (typeof sent.ts === "string" && sent.ts) {
        row.status = "posted";
        row.ts = sent.ts;
      } else row.status = "uncertain";
    } catch (error) {
      const code = refusal(error);
      row.status = code ? "failed" : "uncertain";
      row.error = code ?? null;
    }
    saveOutcome(row);
    if (row.status === "posted" && row.ts) {
      const link = await web(signal)
        .chat.getPermalink({ channel: row.channel, message_ts: row.ts })
        .catch(() => undefined);
      if (typeof link?.permalink === "string" && link.permalink.length < 2048) {
        row.permalink = link.permalink;
        saveOutcome(row);
      }
      await uploadFiles(files, row, currentRoots, saveFiles(row), signal);
    }
    audit(row, false);
    return result(row, false);
  } catch (error) {
    if (error instanceof CaptainPostError) throw error;
    throw new CaptainPostError(
      admitted
        ? "Post outcome unconfirmed; raw details withheld. Retry with the same key to read the recorded outcome."
        : "stargate_post failed before admission; nothing was posted. Check configuration, token and access.",
    );
  } finally {
    try {
      release?.();
    } catch {
      // An unreleased claim expires with its lease.
    }
    store?.close();
  }
}
