import { createHash, randomUUID } from "node:crypto";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type BotConfig, botSchema } from "./config";
import {
  addBot,
  buildManifest,
  checkCredentials,
  manifestUrl,
  readConfiguration,
} from "./setup";

const appIdSchema = botSchema.shape.slack.shape.appId;
const planBotSchema = botSchema.omit({ slack: true }).extend({
  name: z.string().trim().min(1).max(80),
  app: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("reuse"), appId: appIdSchema }),
    z.strictObject({ mode: z.literal("create") }),
  ]),
  slack: botSchema.shape.slack.omit({ appId: true }),
});
const planSchema = z.strictObject({
  version: z.literal(1),
  teamId: z.string().regex(/^T[A-Z0-9]+$/),
  configTokenEnv: botSchema.shape.slack.shape.appTokenEnv.default(
    "SLACK_APP_CONFIG_TOKEN",
  ),
  bots: z.array(planBotSchema).min(1),
});
const journalBotSchema = z
  .strictObject({
    id: botSchema.shape.id,
    state: z.enum([
      "pending",
      "creating",
      "created",
      "recorded",
      "outcome_unknown",
      "rate_limited",
      "failed",
    ]),
    appId: appIdSchema.optional(),
    retryAt: z.number().int().nonnegative().optional(),
  })
  .refine(
    (entry) =>
      Boolean(entry.appId) === ["created", "recorded"].includes(entry.state) &&
      (entry.state === "rate_limited") === (entry.retryAt !== undefined),
  );
const journalSchema = z.strictObject({
  version: z.literal(1),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  bots: z.array(journalBotSchema),
});
type Plan = z.infer<typeof planSchema>;
type Journal = z.infer<typeof journalSchema>;
type JournalBot = z.infer<typeof journalBotSchema>;

export interface ProvisionOptions {
  planPath: string;
  apply: boolean;
  configPath?: string;
  journalPath?: string;
  recordApp?: string;
}

interface ProvisionDependencies {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

async function optionalFile(path: string, privateFile = false) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (privateFile && (info.mode & 0o077) !== 0))
      throw new Error("Not a private regular file");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      "Cannot read provisioning file; use a regular private file.",
    );
  }
}

async function writeJournal(path: string, journal: Journal) {
  await optionalFile(path, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch(() => {});
  }
}

function stateFor(journal: Journal, id: string) {
  const entry = journal.bots.find((bot) => bot.id === id);
  if (!entry) throw new Error("Provision journal does not match the plan.");
  return entry;
}

function runtimeBot(entry: Plan["bots"][number], appId = "APLANNED") {
  const { name: _name, app: _app, ...runtime } = entry;
  return botSchema.parse({
    ...runtime,
    slack: { ...entry.slack, appId },
  });
}

async function preflight(plan: Plan, journal: Journal, configPath: string) {
  const exists = (await optionalFile(configPath)) !== undefined;
  const existing = exists ? (await readConfiguration(configPath)).bots : [];
  const ids = new Set<string>();
  const apps = new Set(existing.map((bot) => bot.slack.appId));
  const names = new Set(
    existing.flatMap((bot) => [bot.slack.appTokenEnv, bot.slack.botTokenEnv]),
  );
  if (names.size !== existing.length * 2 || names.has(plan.configTokenEnv))
    throw new Error("Configuration token-reference conflict.");
  names.add(plan.configTokenEnv);
  for (const entry of plan.bots) {
    if (ids.has(entry.id)) throw new Error("Provisioning bot ID conflict.");
    ids.add(entry.id);
    const appId = stateFor(journal, entry.id).appId;
    const intended = runtimeBot(entry, appId);
    const previous = existing.find((bot) => bot.id === entry.id);
    if (previous) {
      if (!appId || !isDeepStrictEqual(previous, intended))
        throw new Error("Existing registration conflict; nothing overwritten.");
      continue;
    }
    if (appId && apps.has(appId))
      throw new Error("Slack App ID conflict; nothing overwritten.");
    if (appId) apps.add(appId);
    for (const name of [entry.slack.appTokenEnv, entry.slack.botTokenEnv]) {
      if (names.has(name)) throw new Error("Token-reference conflict.");
      names.add(name);
    }
  }
  return existing;
}

const rejectedWithoutCreation = new Set([
  "invalid_auth",
  "not_authed",
  "missing_scope",
  "token_expired",
  "token_revoked",
  "invalid_manifest",
  "invalid_arguments",
  "access_denied",
  "no_permission",
  "not_allowed_token_type",
  "team_access_not_granted",
  "not_in_team",
  "two_factor_setup_required",
]);

async function createApp(
  manifest: ReturnType<typeof buildManifest>,
  token: string,
  request: NonNullable<ProvisionDependencies["fetch"]>,
  now: () => number,
): Promise<Omit<JournalBot, "id">> {
  try {
    const response = await request(
      "https://slack.com/api/apps.manifest.create",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: new URLSearchParams({ manifest: JSON.stringify(manifest) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const retryAt = now() + seconds * 1000;
      return {
        state: "rate_limited",
        retryAt:
          seconds > 0 && Number.isSafeInteger(retryAt)
            ? retryAt
            : now() + 60_000,
      };
    }
    if (response.status >= 500) return { state: "outcome_unknown" };
    const parsed = z
      .object({
        ok: z.boolean(),
        app_id: appIdSchema.optional(),
        error: z.string().optional(),
      })
      .safeParse(await response.json());
    if (parsed.success) {
      if (response.ok && parsed.data.ok && parsed.data.app_id)
        return { state: "created", appId: parsed.data.app_id };
      if (
        !parsed.data.ok &&
        rejectedWithoutCreation.has(parsed.data.error ?? "")
      )
        return { state: "failed" };
    }
  } catch {
    // A sent request can succeed even when its response is lost. Never replay it.
  }
  return { state: "outcome_unknown" };
}

export async function provisionBots(
  options: ProvisionOptions,
  dependencies: ProvisionDependencies = {},
) {
  const planPath = resolve(options.planPath);
  const configPath = resolve(options.configPath ?? "pogo.json");
  const journalPath = resolve(
    options.journalPath ??
      resolve(dirname(configPath), ".local/provision/bots.json"),
  );
  const reserved = [
    planPath,
    configPath,
    `${configPath}.env`,
    `${configPath}.lock`,
  ];
  if (
    reserved.includes(journalPath) ||
    reserved.includes(`${journalPath}.lock`)
  )
    throw new Error("Provision journal must use a separate path.");
  let plan: Plan;
  try {
    plan = planSchema.parse(JSON.parse((await optionalFile(planPath)) ?? ""));
  } catch {
    throw new Error(
      "Invalid provisioning plan; check version, fields, and bots.",
    );
  }
  const environment = dependencies.environment ?? process.env;
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const planHash = createHash("sha256")
    .update(JSON.stringify({ plan, configPath }))
    .digest("hex");

  const prepare = async () => {
    const contents = await optionalFile(journalPath, true);
    let journal: Journal;
    try {
      journal =
        contents !== undefined
          ? journalSchema.parse(JSON.parse(contents))
          : {
              version: 1,
              planHash,
              bots: plan.bots.map((entry) => ({
                id: entry.id,
                state: entry.app.mode === "reuse" ? "recorded" : "pending",
                ...(entry.app.mode === "reuse"
                  ? { appId: entry.app.appId }
                  : {}),
              })),
            };
    } catch {
      throw new Error(
        "Invalid provision journal; reconcile before continuing.",
      );
    }
    if (
      journal.planHash !== planHash ||
      journal.bots.length !== plan.bots.length ||
      new Set(journal.bots.map((entry) => entry.id)).size !==
        journal.bots.length
    )
      throw new Error(
        "Provision journal does not match the original plan/config.",
      );
    for (const entry of plan.bots) {
      const state = stateFor(journal, entry.id);
      if (entry.app.mode === "reuse" && state.appId !== entry.app.appId)
        throw new Error("Provision journal reuse identity conflict.");
      if (state.state === "creating") state.state = "outcome_unknown";
    }
    if (options.recordApp !== undefined) {
      const match = /^([a-z0-9][a-z0-9_-]{0,63})=(A[A-Z0-9]+)$/.exec(
        options.recordApp,
      );
      const entry = plan.bots.find((bot) => bot.id === match?.[1]);
      const appId = match?.[2];
      if (entry?.app.mode !== "create" || !appId)
        throw new Error(
          "Invalid record-app; use a planned create BOT_ID=APP_ID.",
        );
      const state = stateFor(journal, entry.id);
      if (state.appId && state.appId !== appId)
        throw new Error("record-app cannot replace an already known App ID.");
      Object.assign(state, { state: "recorded", appId });
      delete state.retryAt;
    }
    await preflight(plan, journal, configPath);
    return journal;
  };

  const registrations = new Map<string, "added" | "unchanged">();
  const report = async (journal: Journal) => {
    const existing = await preflight(plan, journal, configPath);
    const bots = await Promise.all(
      plan.bots.map(async (entry) => {
        const state = stateFor(journal, entry.id);
        let credentials: "present" | "missing" = "present";
        try {
          await checkCredentials(
            configPath,
            [runtimeBot(entry, state.appId)],
            environment,
          );
        } catch {
          credentials = "missing";
        }
        const needsHuman = [
          "verify_workspace_installation",
          "verify_live_reply",
        ];
        if (!state.appId)
          needsHuman.unshift(
            state.state === "outcome_unknown"
              ? "reconcile_app_id_with_record_app"
              : "create_app_or_record_browser_created_app",
          );
        if (credentials === "missing")
          needsHuman.push("store_runtime_tokens_privately");
        if (state.state === "failed")
          needsHuman.push("review_configuration_token_and_manifest");
        if (state.state === "rate_limited")
          needsHuman.push("wait_before_retrying_create");
        if (state.appId) needsHuman.push("invite_bot_to_allowed_channels");
        return {
          id: entry.id,
          name: entry.name,
          ...(state.appId ? { appId: state.appId } : {}),
          app:
            entry.app.mode === "reuse"
              ? "reused"
              : state.state === "pending"
                ? "planned"
                : state.state,
          registration:
            registrations.get(entry.id) ??
            (existing.some((bot) => bot.id === entry.id)
              ? "unchanged"
              : "pending"),
          credentials,
          needsHuman,
          manifest: buildManifest(entry.name),
          url: state.appId
            ? `https://api.slack.com/apps/${state.appId}`
            : state.state === "outcome_unknown"
              ? "https://api.slack.com/apps"
              : manifestUrl(entry.name),
          ...(state.retryAt !== undefined
            ? {
                retryAfterSeconds: Math.max(
                  0,
                  Math.ceil((state.retryAt - now()) / 1000),
                ),
              }
            : {}),
        };
      }),
    );
    return { teamId: plan.teamId, configPath, journalPath, bots };
  };

  const initial = await prepare();
  if (!options.apply && options.recordApp === undefined) return report(initial);
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  let lock: FileHandle;
  try {
    lock = await open(`${journalPath}.lock`, "wx", 0o600);
  } catch {
    throw new Error("Provision journal is locked or not writable.");
  }
  try {
    const journal = await prepare();
    await writeJournal(journalPath, journal);
    if (options.apply) {
      const coolingDown = journal.bots.some(
        (entry) => entry.retryAt !== undefined && entry.retryAt > now(),
      );
      for (const entry of plan.bots) {
        if (coolingDown) break;
        const state = stateFor(journal, entry.id);
        if (
          state.appId ||
          state.state === "outcome_unknown" ||
          (state.retryAt !== undefined && state.retryAt > now())
        )
          continue;
        const token = environment[plan.configTokenEnv];
        if (!token?.trim()) continue;
        await preflight(plan, journal, configPath);
        state.state = "creating";
        delete state.retryAt;
        await writeJournal(journalPath, journal);
        const result = await createApp(
          buildManifest(entry.name),
          token,
          request,
          now,
        );
        Object.assign(state, result);
        await writeJournal(journalPath, journal);
        if (result.state === "rate_limited") break;
      }
      await preflight(plan, journal, configPath);
      for (const entry of plan.bots) {
        const appId = stateFor(journal, entry.id).appId;
        if (!appId) continue;
        const existing: BotConfig[] = await preflight(
          plan,
          journal,
          configPath,
        );
        if (existing.some((bot) => bot.id === entry.id)) {
          registrations.set(entry.id, "unchanged");
        } else {
          await addBot(configPath, runtimeBot(entry, appId));
          registrations.set(entry.id, "added");
        }
      }
    }
    return await report(journal);
  } finally {
    await lock.close();
    await unlink(`${journalPath}.lock`);
  }
}
