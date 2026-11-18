import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cleanupResultSchema } from "./cleanup-config";
import { type Reason, reasons } from "./exec";
import { maintenanceDirectory } from "./paths";

/**
 * Versioned maintenance report. Consumers (for example a reporting droid)
 * must check `schema` and ignore unknown fields only within the same major
 * version. The report contains versions, reason codes and private local
 * paths; never raw errors, command output, prompts or credentials.
 */
export const reportSchemaID = "stargate.maintenance.report.v1";
const iso = z.iso.datetime({ offset: true });
const reason = z.enum(reasons);
const version = z.string().max(100).nullable();

export const componentSchema = z.strictObject({
  /** `stargate`, `cliproxyapi`, or `npm:<package>`. */
  id: z.string().min(1).max(250),
  before: version,
  after: version,
  /** Version selected after the cool-off, if any. */
  candidate: version,
  status: z.enum([
    "unchanged",
    "planned",
    "updated",
    "rolled-back",
    "failed",
    "skipped",
    "deferred",
  ]),
  reason: reason.optional(),
  /** npm `--before` cutoff of this install, kept for an exact rollback. */
  cutoff: iso.optional(),
  /** SHA-256 pinned for a downloaded binary asset. */
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const modelChangeSchema = z.strictObject({
  /** `catalog`: an additive provider declaration or a rejected/reported candidate. */
  scope: z.enum([
    "catalog",
    "agent-profile",
    "team-file",
    "opencode-config",
    "captain-session",
    "crew-session",
  ]),
  /** Profile route name, file path or session ID. */
  target: z.string().min(1).max(4096),
  from: z.string().min(1).max(300),
  to: z.string().min(1).max(300),
  status: z.enum(["planned", "applied", "rolled-back", "failed", "skipped"]),
  reason: reason.optional(),
});
export const stepSchema = z.strictObject({
  name: z.string().min(1).max(100),
  status: z.enum(["ok", "failed", "skipped"]),
  at: iso,
  reason: reason.optional(),
});
/** Upper bounds per array; extra items are dropped and counted. */
export const limits = {
  components: 100,
  models: 1000,
  steps: 300,
  rollbacks: 300,
  restarts: 50,
  notes: 50,
};

export const reportSchema = z.strictObject({
  schema: z.literal(reportSchemaID),
  runID: z.uuid(),
  installID: z.string().min(1).max(100),
  mode: z.enum(["plan", "run"]),
  /**
   * `no-op`: nothing to change. `completed`: every selected change applied.
   * `partial`: some applied, some failed or rolled back. `rolled-back`:
   * changes were attempted and every one was reverted. `deferred`: nothing
   * applied; retried next window. `failed`: the run could not proceed.
   * `planned`: plan mode only.
   */
  outcome: z.enum([
    "planned",
    "no-op",
    "completed",
    "partial",
    "rolled-back",
    "deferred",
    "failed",
  ]),
  reason: reason.optional(),
  window: z.strictObject({
    timeZone: z.string(),
    localStart: z.string(),
    localEnd: z.string(),
    opens: iso,
    plannedStart: iso,
    deadline: iso,
    closes: iso,
    jitterMinutes: z.number().int().min(0),
  }),
  startedAt: iso,
  finishedAt: iso,
  components: z.array(componentSchema).max(limits.components),
  cleanup: cleanupResultSchema.optional(),
  models: z.array(modelChangeSchema).max(limits.models),
  updateNotices: z
    .array(
      z.strictObject({
        sessionID: z.string().min(1).max(256),
        status: z.enum(["queued", "mail", "unchanged", "uncertain"]),
      }),
    )
    .max(1000)
    .optional(),
  steps: z.array(stepSchema).max(limits.steps),
  rollbacks: z
    .array(
      z.strictObject({
        component: z.string().min(1).max(250),
        from: z.string().max(300),
        to: z.string().max(300),
        status: z.enum(["ok", "failed"]),
        reason: reason.optional(),
      }),
    )
    .max(limits.rollbacks),
  restarts: z
    .array(
      z.strictObject({
        service: z.enum(["gateway", "opencode", "cliproxyapi"]),
        status: z.enum(["ok", "failed"]),
        at: iso,
      }),
    )
    .max(limits.restarts),
  /**
   * Informational: queued crew assignments that keep the idle gate busy
   * until their captain resolves them. IDs and origins, never task text.
   */
  notes: z
    .array(
      z.strictObject({
        kind: z.literal("queued-crew-task"),
        taskID: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        crew: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        originCaptain: z.string().regex(/^ses_[A-Za-z0-9]{1,250}$/),
        originIsPin: z.boolean(),
        /** An activity-report task, which blocks the idle gate while queued. */
        report: z.boolean(),
        action: z.string().max(200),
      }),
    )
    .max(limits.notes)
    .optional(),
  /** Items dropped to keep the report bounded, per array. */
  truncated: z.record(z.string(), z.number().int().min(1)).optional(),
});
export type Report = z.infer<typeof reportSchema>;
export type ComponentReport = z.infer<typeof componentSchema>;
export type ModelChange = z.infer<typeof modelChangeSchema>;

export const noticeSchemaID = "stargate.maintenance.notice.v1";
export const noticeSchema = z.strictObject({
  schema: z.literal(noticeSchemaID),
  channel: z.string().regex(/^[CG][A-Z0-9]+$/),
  text: z.string().min(1).max(2800),
  report: z.string().regex(/^[A-Za-z0-9._-]+\.json$/),
});
export type Notice = z.infer<typeof noticeSchema>;

export { maintenanceDirectory };

async function writePrivate(path: string, text: string) {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, text, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Truncate arrays and free-text fields to the schema's bounds. */
export function boundReport(report: Report): Report {
  const truncated: Record<string, number> = { ...report.truncated };
  const take = <T>(key: keyof typeof limits, items: T[]) => {
    if (items.length > limits[key])
      truncated[key] = (truncated[key] ?? 0) + items.length - limits[key];
    return items.slice(0, limits[key]);
  };
  const bounded: Report = {
    ...report,
    components: take("components", report.components).map((c) => ({
      ...c,
      id: cut(c.id, 250),
    })),
    models: take("models", report.models).map((m) => ({
      ...m,
      target: cut(m.target, 4096),
      from: cut(m.from, 300),
      to: cut(m.to, 300),
    })),
    steps: take("steps", report.steps).map((s) => ({
      ...s,
      name: cut(s.name, 100),
    })),
    rollbacks: take("rollbacks", report.rollbacks).map((r) => ({
      ...r,
      component: cut(r.component, 250),
      from: cut(r.from, 300),
      to: cut(r.to, 300),
    })),
    restarts: take("restarts", report.restarts),
    ...(report.notes ? { notes: take("notes", report.notes) } : {}),
  };
  if (Object.keys(truncated).length) bounded.truncated = truncated;
  return bounded;
}

const withoutNotes = ({ notes: _notes, ...rest }: Report) => rest;

/**
 * Atomically writes `<data>/maintenance/reports/<timestamp>-<run>.json`.
 * A report that still fails validation after bounding is replaced by a
 * minimal one with the same outcome, so a report always exists.
 */
export async function writeReport(dataDirectory: string, report: Report) {
  let valid: Report;
  const parsed = reportSchema.safeParse(boundReport(report));
  if (parsed.success) valid = parsed.data;
  else
    valid = reportSchema.parse({
      ...withoutNotes(report),
      components: [],
      models: [],
      steps: [],
      rollbacks: [],
      restarts: [],
      truncated: { invalid: 1 },
    });
  const directory = join(maintenanceDirectory(dataDirectory), "reports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `${valid.startedAt.replace(/[^0-9TZ]/g, "")}-${valid.runID}.json`;
  await writePrivate(
    join(directory, name),
    `${JSON.stringify(valid, null, 2)}\n`,
  );
  return { name, path: join(directory, name), report: valid };
}

/**
 * Local alert for problems that need an operator even when the gateway
 * cannot deliver a Slack summary: failed outcome, an unrecovered journal,
 * a gateway that did not become ready, or a report that could not be written.
 */
export const alertSchemaID = "stargate.maintenance.alert.v1";
export async function writeAlert(
  dataDirectory: string,
  alert: {
    runID: string;
    at: string;
    outcome: Report["outcome"];
    reason?: Reason;
    report: string | null;
    journal: boolean;
  },
) {
  const directory = maintenanceDirectory(dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "ALERT.json");
  await writeFile(
    `${path}.tmp-${process.pid}`,
    `${JSON.stringify({ schema: alertSchemaID, ...alert }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(`${path}.tmp-${process.pid}`, path);
  return path;
}

/** Queues one summary for the gateway's delivery worker. */
export async function queueNotice(dataDirectory: string, notice: Notice) {
  const valid = noticeSchema.parse(notice);
  const directory = join(maintenanceDirectory(dataDirectory), "outbox");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writePrivate(
    join(directory, valid.report),
    `${JSON.stringify(valid)}\n`,
  );
}

export async function listReports(dataDirectory: string) {
  try {
    return (await readdir(join(maintenanceDirectory(dataDirectory), "reports")))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

const labels: Record<Reason, string> = Object.fromEntries(
  reasons.map((code) => [code, code.replaceAll("-", " ")]),
) as Record<Reason, string>;

/** One concise, bounded Slack summary. Only codes and versions; no errors. */
export function summary(report: Report, reportName: string) {
  const line = (text: string, max = 200) =>
    Array.from(text.replace(/[\r\n\t]+/g, " "))
      .slice(0, max)
      .join("");
  const changed = report.components.filter((c) => c.status !== "unchanged");
  const result = `${report.outcome}${report.reason ? ` (${labels[report.reason]})` : ""}.`;
  const parts = [
    report.steps.some((step) => step.name === "operator-update")
      ? `Operator update of Stargate, outside the window and without the idle gate: ${result}`
      : `Nightly maintenance ${report.window.localStart}–${report.window.localEnd} ${report.window.timeZone}: ${result}`,
  ];
  if (report.cleanup) {
    const items = report.cleanup.items;
    parts.push(
      `Cleanup: ${report.cleanup.freedBytes} bytes freed; ${items.filter((item) => item.status === "removed").length} removed, ${items.filter((item) => item.status === "skipped").length} kept, ${items.filter((item) => item.status === "failed").length} failed. Per-item paths and reasons are in the private report.`,
    );
  }
  for (const component of changed.slice(0, 12))
    parts.push(
      line(
        `- ${component.id}: ${component.status}${component.before || component.after ? ` ${component.before ?? "?"} → ${component.after ?? component.candidate ?? "?"}` : ""}${component.reason ? ` (${labels[component.reason]})` : ""}`,
      ),
    );
  const unchanged = report.components.length - changed.length;
  if (unchanged) parts.push(`Unchanged: ${unchanged} component(s).`);
  const models = new Map<string, { applied: number; other: number }>();
  for (const change of report.models) {
    const key = `${change.from} → ${change.to}`;
    const entry = models.get(key) ?? { applied: 0, other: 0 };
    if (change.status === "applied") entry.applied++;
    else entry.other++;
    models.set(key, entry);
  }
  for (const [key, entry] of [...models].slice(0, 8))
    parts.push(
      line(
        `- model ${key}: ${entry.applied} applied${entry.other ? `, ${entry.other} not applied` : ""}`,
      ),
    );
  for (const notice of (report.updateNotices ?? [])
    .filter((notice) => notice.status !== "unchanged")
    .slice(0, 8))
    parts.push(line(`- update notice ${notice.sessionID}: ${notice.status}`));
  for (const note of (report.notes ?? []).slice(0, 5))
    parts.push(
      line(
        `- crew task ${note.taskID} for ${note.crew} is queued (${note.originIsPin ? "from the pinned captain" : "from an earlier captain session"}): ${note.action.charAt(0).toLowerCase()}${note.action.slice(1)}`,
        300,
      ),
    );
  if (report.rollbacks.length)
    parts.push(
      `Rollbacks: ${report.rollbacks.map((r) => `${r.component} ${r.status}`).join(", ")}.`,
    );
  parts.push(`Private report: ${reportName}`);
  return Array.from(parts.join("\n")).slice(0, 2800).join("");
}
