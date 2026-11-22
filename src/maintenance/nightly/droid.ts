import { Database } from "bun:sqlite";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../../config";
import { redactCredentials } from "../../lib/credentials";
import type { MaintenanceConfig } from "./config";
import { type DroidAgent, type DroidTools, openPiDroid } from "./droid-agent";
import {
  collectFacts,
  type DroidFacts,
  type Finding,
  findings,
  type ReportDigest,
  readUnit,
  runningUnit,
} from "./droid-facts";
import type { Reason } from "./exec";
import { atomicWrite, readOptional } from "./files";
import { queuedTaskAction } from "./schedule/idle";
import { Journal } from "./journal";
import { maintenanceDirectory } from "./paths";
import { noticeSchemaID, queueNotice, type Report, summary } from "./report";
import {
  type Dependencies,
  defaultDependencies,
  nothingToRecover,
  recoverWhenIdle,
  runMaintenance,
} from "./run";

/**
 * stargate-maintenance-droid: a Pi Durable agent that explains maintenance and
 * escalates through the report bot. Stargate decides when to check, collects the
 * facts, computes the findings, enforces every precondition and limit, and
 * writes the post's actions, findings and operator commands itself; the
 * model only chooses among the tools and writes the explanation. Without a
 * model answer the post falls back to a deterministic summary.
 */

export type DroidSettings = NonNullable<MaintenanceConfig["droid"]>;
export type DroidDependencies = Dependencies & {
  openAgent: (
    settings: DroidSettings,
    directory: string,
  ) => Promise<DroidAgent>;
};
export const defaultDroidDependencies: DroidDependencies = {
  ...defaultDependencies,
  openAgent: (settings, directory) => openPiDroid(settings.backend, directory),
};

export const droidDirectory = (dataDirectory: string) =>
  join(maintenanceDirectory(dataDirectory), "droid");

type Trigger = "after-run" | "health";
type AuditEntry = {
  at: string;
  checkID: string;
  trigger: Trigger;
  kind: "check" | "action" | "model" | "post";
  action?: "plan" | "recover";
  status:
    | "started"
    | "ok"
    | "failed"
    | "refused"
    | "silent"
    | "fallback"
    | "deferred"
    | "posted";
  detail?: string;
  findings?: string[];
};
const auditPath = (directory: string) => join(directory, "audit.jsonl");

/** Append-only JSON lines (0600); trimmed to the newest entries when large. */
async function audit(directory: string, entry: AuditEntry) {
  const path = auditPath(directory);
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  if (((await stat(path).catch(() => null))?.size ?? 0) > 512 * 1024) {
    const lines = ((await readOptional(path)) ?? "").trimEnd().split("\n");
    await atomicWrite(path, `${lines.slice(-1000).join("\n")}\n`, 0o600);
  }
}

const stateSchema = z.strictObject({
  schema: z.literal("stargate.maintenance.droid.v1"),
  lastReport: z.string().max(200).nullable(),
  /**
   * Recover requests per local day in the window's time zone, counted
   * before each one runs. The audit log is a record, not the counter: it is
   * trimmed, this is not for the current day.
   */
  recovers: z
    .record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.number().int().min(0))
    .default({}),
});
type DroidState = z.infer<typeof stateSchema>;
const statePath = (directory: string) => join(directory, "state.json");

/** `undefined`: no state yet. `null`: unreadable; callers fail closed. */
async function readDroidState(
  directory: string,
): Promise<DroidState | null | undefined> {
  const text = await readOptional(statePath(directory)).catch(() => "");
  if (text === null) return undefined;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Read-modify-write under the droid lock. An unreadable state is replaced
 * with today's recover budget spent, so a damaged file never resets the
 * limit. Today's count is never pruned; at most six older days are kept.
 */
async function updateDroidState(
  directory: string,
  today: string,
  spent: number,
  change: (state: DroidState) => void,
) {
  const current = await readDroidState(directory);
  const state: DroidState = current ?? {
    schema: "stargate.maintenance.droid.v1",
    lastReport: null,
    recovers: current === null ? { [today]: spent } : {},
  };
  change(state);
  const older = Object.keys(state.recovers)
    .filter((day) => day !== today)
    .sort()
    .reverse()
    .slice(0, 6);
  state.recovers = Object.fromEntries(
    [today, ...older].flatMap((day) => {
      const count = state.recovers[day];
      return count === undefined ? [] : [[day, count]];
    }),
  );
  await atomicWrite(statePath(directory), `${JSON.stringify(state)}\n`, 0o600);
}

export function localDay(now: number, timeZone: string) {
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

function localTime(now: number, timeZone: string) {
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toString({ smallestUnit: "minute" });
}

/** A held lock, or undefined when another droid check runs. */
function lockDroid(directory: string) {
  const db = new Database(join(directory, "lock.sqlite"), { create: true });
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    return db;
  } catch {
    db.close();
    return undefined;
  }
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Every environment variable the configuration names (`…Env` keys), and the native provider keys. */
function secretNames(config: Config) {
  const names = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  const walk = (value: unknown, env: boolean) => {
    if (typeof value === "string") {
      if (env && /^[A-Z_][A-Z0-9_]*$/.test(value)) names.add(value);
    } else if (Array.isArray(value)) for (const item of value) walk(item, env);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        walk(item, env || key.endsWith("Env"));
  };
  walk(config, false);
  return names;
}

/**
 * Scrubbing for everything that reaches the model or Slack: the values of
 * every configured secret variable are removed first, then credential-looking
 * text (keys, tokens, `Bearer …`, `token=…`) and control characters.
 */
export function droidScrubber(config: Config, env: NodeJS.ProcessEnv) {
  const values = [...secretNames(config)]
    .flatMap((name) => {
      const value = env[name]?.trim();
      return value && value.length >= 8 ? [value] : [];
    })
    .sort((a, b) => b.length - a.length);
  // Defence in depth for text that was cut before it reached Stargate (the
  // report writer marks its cuts with "…"): a prefix of 12 or more
  // characters of a configured secret, at a cut (end of text or line, or
  // "…"), is removed too. Longest prefix first.
  const cuts = values
    .filter((value) => value.length > 12)
    .map((value) => {
      const prefixes: string[] = [];
      for (let length = value.length - 1; length >= 12; length--)
        prefixes.push(
          value.slice(0, length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        );
      return new RegExp(`(?:${prefixes.join("|")})(?=…|\\r?\\n|$)`, "g");
    });
  const text = (input: string) => {
    let clean = input;
    for (const value of values) clean = clean.replaceAll(value, "[REDACTED]");
    clean = redactCredentials(clean, 64_000);
    for (const cut of cuts) clean = clean.replace(cut, "[REDACTED]");
    return clean;
  };
  const value = (input: unknown): unknown =>
    typeof input === "string"
      ? text(input)
      : Array.isArray(input)
        ? input.map(value)
        : input && typeof input === "object"
          ? Object.fromEntries(
              Object.entries(input).map(([key, item]) => [key, value(item)]),
            )
          : input;
  /** Model text for Slack: scrubbed, whitespace tidied, bounded. */
  const post = (input: string, max: number) =>
    cut(
      text(input)
        .replace(/\r|\t/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
      max,
    );
  return { text, value, post };
}
type Scrubber = ReturnType<typeof droidScrubber>;

const busyUnit = (state: Awaited<ReturnType<typeof readUnit>>) =>
  runningUnit(state) || state === "activating" || state === "deactivating";

/** The droid's two actions, with Stargate's preconditions, limits and audit. */
class Actions {
  /** What happened, for the post: every request, refused ones too. */
  readonly done: string[] = [];
  private readonly used = new Set<"plan" | "recover">();
  private readonly running = new Set<Promise<unknown>>();

  /**
   * An action outlives a model timeout: the tool call is abandoned, the
   * action is not. The check waits for it before it posts or exits, so a
   * recover is never cut off by the droid itself.
   */
  track<T>(action: Promise<T>) {
    this.running.add(action);
    void action.finally(() => this.running.delete(action)).catch(() => {});
    return action;
  }

  async settled() {
    await Promise.allSettled([...this.running]);
  }

  constructor(
    private readonly c: {
      config: Config;
      configPath: string;
      deps: DroidDependencies;
      settings: DroidSettings;
      directory: string;
      checkID: string;
      trigger: Trigger;
      signal: AbortSignal;
      scrub: Scrubber;
    },
  ) {}

  private log(
    action: "plan" | "recover",
    status: AuditEntry["status"],
    detail?: string,
  ) {
    return audit(this.c.directory, {
      at: new Date(this.c.deps.clock.now()).toISOString(),
      checkID: this.c.checkID,
      trigger: this.c.trigger,
      kind: "action",
      action,
      status,
      ...(detail ? { detail: cut(detail, 400) } : {}),
    });
  }

  private async refuse(action: "plan" | "recover", reason: string) {
    await this.log(action, "refused", reason);
    this.done.push(`${action} refused (${reason})`);
    return `Refused by Stargate: ${reason}. Nothing was done. Do not ask again in this check.`;
  }

  private runActive() {
    return readUnit(
      this.c.deps.runner,
      `${this.c.settings.timer}.service`,
    ).then(busyUnit);
  }

  /**
   * Why `recover` may not run now, or undefined. The idle check is not here:
   * it runs under the run lock, in the engine's leftover recovery.
   */
  /** The local date in the window's time zone, now. */
  private today() {
    return localDay(
      this.c.deps.clock.now(),
      this.c.config.maintenance?.window.timeZone ?? "UTC",
    );
  }

  async recoverBlocked() {
    const { config, deps, settings, directory } = this.c;
    const day = this.today();
    const state = await readDroidState(directory);
    if (state === null) return "the droid state is unreadable";
    if ((state?.recovers[day] ?? 0) >= settings.maxRecoversPerDay)
      return `the daily limit of ${settings.maxRecoversPerDay} recover(s) is reached`;
    if (await this.runActive()) return "a maintenance run is active";
    const journal = await Journal.read(config);
    const gateway = await readUnit(
      deps.runner,
      config.maintenance?.services.gateway ?? "stargate.service",
    );
    if (
      journal.kind === "none" &&
      gateway !== "inactive" &&
      gateway !== "failed"
    )
      return "there is no leftover journal and the gateway is not stopped";
    return undefined;
  }

  async recover() {
    if (this.used.has("recover"))
      return this.refuse("recover", "already requested in this check");
    this.used.add("recover");
    const blocked = await this.recoverBlocked();
    if (blocked) return this.refuse("recover", blocked);
    // Admission: the day is the local date at this moment, checked and
    // counted in one state update, so a check that started before midnight
    // charges the day the recover actually runs.
    const { settings, directory } = this.c;
    const day = this.today();
    let admitted = false;
    await updateDroidState(
      directory,
      day,
      settings.maxRecoversPerDay,
      (state) => {
        const count = state.recovers[day] ?? 0;
        if (count >= settings.maxRecoversPerDay) return;
        // Counted before it runs, so a killed or deferred recover still counts.
        state.recovers[day] = count + 1;
        admitted = true;
      },
    );
    if (!admitted)
      return this.refuse(
        "recover",
        `the daily limit of ${settings.maxRecoversPerDay} recover(s) is reached`,
      );
    await this.log("recover", "started");
    const result: { ok: boolean; message: string; busy?: Reason } =
      await recoverWhenIdle(this.c.config, this.c.deps, this.c.signal).catch(
        () => ({ ok: false, message: "Recovery stopped unexpectedly." }),
      );
    const detail = cut(this.c.scrub.text(result.message), 400);
    await this.log(
      "recover",
      result.busy ? "deferred" : result.ok ? "ok" : "failed",
      detail,
    );
    const outcome = result.busy
      ? `deferred (the host is busy: ${result.busy})`
      : result.message === nothingToRecover
        ? "found nothing to recover"
        : result.ok
          ? "finished"
          : "did not finish";
    this.done.push(`recover ${outcome}`);
    return `Recover ${outcome}: ${detail}`;
  }

  async plan() {
    if (this.used.has("plan"))
      return this.refuse("plan", "already requested in this check");
    this.used.add("plan");
    if (await this.runActive())
      return this.refuse("plan", "a maintenance run is active");
    await this.log("plan", "started");
    try {
      const { report } = await runMaintenance(
        {
          config: this.c.config,
          configPath: this.c.configPath,
          mode: "plan",
          signal: AbortSignal.any([
            this.c.signal,
            AbortSignal.timeout(180_000),
          ]),
        },
        this.c.deps,
      );
      await this.log("plan", "ok", report.outcome);
      this.done.push(`plan ${report.outcome}`);
      // Scrubbed before summary() bounds its lines.
      return cut(
        summary(this.c.scrub.value(report) as Report, "not written (plan)"),
        1500,
      );
    } catch {
      await this.log("plan", "failed");
      this.done.push("plan failed");
      return "The plan could not be made. Nothing was changed.";
    }
  }
}

function describeReport(report: ReportDigest) {
  const changed = report.changed
    .slice(0, 6)
    .map(
      (c) =>
        `${c.id} ${c.status}${c.before || c.after ? ` ${c.before ?? "?"} → ${c.after ?? "?"}` : ""}${c.reason ? ` (${c.reason})` : ""}`,
    );
  return `Run started ${report.startedAt}: ${report.outcome}${report.reason ? ` (${report.reason})` : ""}.${changed.length ? ` ${changed.join("; ")}.` : ""}`;
}

/** One queued crew assignment and the captain action that resolves it. */
function queuedNote(task: DroidFacts["crewQueue"][number]) {
  const action = queuedTaskAction(task);
  return `Queued crew task ${task.taskID} (${task.crew}, ${task.originIsPin ? "from the pinned captain" : "from an earlier captain session"}): ${action.charAt(0).toLowerCase()}${action.slice(1)}`;
}

function fallbackBody(trigger: Trigger, facts: DroidFacts, list: Finding[]) {
  const lines: string[] = [];
  const newest = facts.reports[0];
  if (trigger === "after-run" && newest) lines.push(describeReport(newest));
  for (const finding of list) lines.push(`- ${finding.text}`);
  if (!list.length) lines.push("No problems found.");
  lines.push("(No model summary; this is Stargate's deterministic summary.)");
  return lines.join("\n");
}

function prompt(input: {
  checkID: string;
  trigger: Trigger;
  facts: DroidFacts;
  list: Finding[];
  recoverBlocked: string | undefined;
}) {
  const { facts } = input;
  const newest = facts.reports[0];
  return [
    `Maintenance check ${input.checkID}: ${input.trigger === "after-run" ? "after the nightly run" : "daily health check"}, ${facts.now} (window ${facts.window.localStart}-${facts.window.localEnd} ${facts.window.timeZone}).`,
    "Findings from Stargate's checks (authoritative; Stargate appends them with the operator commands):",
    ...(input.list.length
      ? input.list.map((finding) => `- ${finding.code}: ${finding.text}`)
      : ["- none"]),
    newest
      ? `Newest report ${newest.name}: ${describeReport(newest)}`
      : "No maintenance report exists yet.",
    ...facts.crewQueue.map(
      (task) =>
        `Note: ${queuedNote(task)}. ${task.report ? "It keeps maintenance busy (busy-crew) while queued." : "It does not block maintenance; it waits until the captain asks."}`,
    ),
    `maintenance_recover preconditions: ${input.recoverBlocked ? `not met (${input.recoverBlocked})` : "met, subject to the idle check"}.`,
    "Use the tools as needed, then write the Slack post body.",
  ].join("\n");
}

/** Every part is scrubbed before any cut. */
function composePost(input: {
  trigger: Trigger;
  facts: DroidFacts;
  list: Finding[];
  body: string;
  actions: readonly string[];
  now: number;
  scrub: Scrubber;
}) {
  const zone = input.facts.window.timeZone;
  const header =
    input.trigger === "after-run"
      ? `Maintenance droid: after the run of ${localDay(Date.parse(input.facts.reports[0]?.startedAt ?? input.facts.now), zone)}`
      : `Maintenance droid: health check ${localDay(input.now, zone)} ${localTime(input.now, zone)} ${zone}`;
  const commands = [
    ...new Set(input.list.flatMap((finding) => finding.commands)),
  ].slice(0, 6);
  const tail = input.scrub.text(
    [
      `Droid actions: ${input.actions.length ? input.actions.join("; ") : "none"}.`,
      `Checks: ${input.list.length ? input.list.map((finding) => finding.code).join(", ") : "all clear"}.`,
      ...input.facts.crewQueue
        .slice(0, 5)
        .map((task) => `${queuedNote(task)}.`),
      ...(commands.length
        ? ["Operator commands:", ...commands.map((command) => `  ${command}`)]
        : []),
    ].join("\n"),
  );
  const room = Math.max(200, 2800 - header.length - tail.length - 4);
  return cut(
    [
      input.scrub.text(header),
      input.scrub.post(input.body, Math.min(1800, room)),
      tail,
    ].join("\n"),
    2800,
  );
}

export type DroidResult = {
  trigger: Trigger;
  findings: string[];
  posted: boolean;
  /** The post, or in preview the deterministic post. */
  text?: string;
  /** The model answered; false: deterministic fallback (or not asked). */
  model: boolean;
  skipped?: "locked";
};

export async function runDroid(
  input: {
    config: Config;
    configPath: string;
    signal: AbortSignal;
    /** Facts and the deterministic post only: no model, actions or writes. */
    preview?: boolean;
  },
  deps: DroidDependencies = defaultDroidDependencies,
): Promise<DroidResult> {
  const { config, configPath, signal } = input;
  const m = config.maintenance;
  if (!m) throw new Error("No maintenance section in configuration.");
  const settings = m.droid;
  if (!settings)
    throw new Error("No maintenance.droid section in configuration.");
  if (!input.preview && !settings.enabled)
    throw new Error(
      "The maintenance droid is disabled. Set maintenance.droid.enabled to true.",
    );
  const report = m.report;
  if (!report)
    throw new Error("The maintenance droid needs maintenance.report.");
  const directory = droidDirectory(config.dataDirectory);
  const now = deps.clock.now();
  const zone = m.window.timeZone;
  const day = localDay(now, zone);
  const scrub = droidScrubber(config, deps.env);
  // Scrubbed once: findings, prompt, tool results and post all derive from it.
  const raw = await collectFacts({
    scrub: scrub.text,
    config,
    configPath,
    runner: deps.runner,
    now,
  });
  const facts = scrub.value(raw) as DroidFacts;
  const list = findings(facts, {
    configPath,
    failedNights: settings.failedNights,
  });
  const codes = list.map((finding) => finding.code);
  const newest = facts.reports[0];
  const stored = await readDroidState(directory);
  // A report not yet explained means a run finished since the last check.
  // Without droid state (first check), only a report of the last day counts.
  const trigger: Trigger =
    newest &&
    (stored
      ? newest.name > (stored.lastReport ?? "")
      : now - Date.parse(newest.startedAt) < 86_400_000)
      ? "after-run"
      : "health";
  if (input.preview)
    return {
      trigger,
      findings: codes,
      posted: false,
      model: false,
      text: composePost({
        trigger,
        facts,
        list,
        body: fallbackBody(trigger, facts, list),
        actions: [],
        now,
        scrub,
      }),
    };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const held = lockDroid(directory);
  if (!held)
    return {
      trigger,
      findings: codes,
      posted: false,
      model: false,
      skipped: "locked",
    };
  try {
    const checkID = deps.uuid();
    const at = () => new Date(deps.clock.now()).toISOString();
    await audit(directory, {
      at: at(),
      checkID,
      trigger,
      kind: "check",
      status: "started",
      findings: codes,
    });
    if (trigger === "health" && !list.length) {
      await audit(directory, {
        at: at(),
        checkID,
        trigger,
        kind: "post",
        status: "silent",
      });
      return { trigger, findings: codes, posted: false, model: false };
    }
    const actions = new Actions({
      config,
      configPath,
      deps,
      settings,
      directory,
      checkID,
      trigger,
      signal,
      scrub,
    });
    // Every tool result passes the scrubber on its way to the model.
    const tools: DroidTools = {
      status: async () => {
        const { reports: _reports, ...rest } = facts;
        return scrub.value({ ...rest, findings: list });
      },
      reports: async (limit) => scrub.value(facts.reports.slice(0, limit)),
      plan: async () => scrub.text(await actions.track(actions.plan())),
      recover: async () => scrub.text(await actions.track(actions.recover())),
    };
    let body = "";
    try {
      const agent = await deps.openAgent(settings, directory);
      try {
        body = scrub.post(
          await agent.ask({
            prompt: scrub.text(
              prompt({
                checkID,
                trigger,
                facts,
                list,
                recoverBlocked: await actions.recoverBlocked(),
              }),
            ),
            day,
            tools,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(settings.timeoutMinutes * 60_000),
            ]),
          }),
          1800,
        );
      } finally {
        await agent.close().catch(() => {});
      }
    } catch {
      // Never log the provider's error: it can carry request details.
      body = "";
    }
    await actions.settled();
    const model = body.length > 0;
    if (!model)
      await audit(directory, {
        at: at(),
        checkID,
        trigger,
        kind: "model",
        status: "fallback",
      });
    const text = scrub.text(
      composePost({
        trigger,
        facts,
        list,
        body: model
          ? body
          : scrub.post(fallbackBody(trigger, facts, list), 1800),
        actions: actions.done,
        now,
        scrub,
      }),
    );
    const stamp = new Date(now).toISOString().replace(/[^0-9TZ]/g, "");
    await queueNotice(config.dataDirectory, {
      schema: noticeSchemaID,
      channel: report.channel,
      text,
      report: `droid-${stamp}-${checkID}.json`,
    });
    await audit(directory, {
      at: at(),
      checkID,
      trigger,
      kind: "post",
      status: "posted",
      detail: model ? "model" : "fallback",
    });
    if (trigger === "after-run" && newest)
      await updateDroidState(
        directory,
        localDay(deps.clock.now(), zone),
        settings.maxRecoversPerDay,
        (state) => {
          state.lastReport = newest.name;
        },
      );
    return { trigger, findings: codes, posted: true, text, model };
  } finally {
    held.close();
  }
}
