import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonSchema, Predicate, Result, Schema } from "effect";
import { settingsAdvertisement } from "../../../../config/settings-legacy";
import {
  settingsDateTime,
  settingsPattern,
  settingsRecord,
  settingsStruct,
} from "../../../../config/settings-schema";
import { cleanupResultSchema } from "../cleanup/cleanup-config";
import { type Reason, reasons } from "../exec";
import { maintenanceDirectory } from "../paths";

/**
 * Versioned maintenance report. Consumers (for example a reporting droid)
 * must check `schema` and ignore unknown fields only within the same major
 * version. The report contains versions, reason codes and private local
 * paths; never raw errors, command output, prompts or credentials.
 */
export const reportSchemaID = "stargate.maintenance.report.v1";
const iso = settingsDateTime;
const reason = Schema.Literals(reasons);

// Zod counted code points for string bounds; keep that unit.
const text = (minimum: number, maximum: number) =>
  Schema.String.check(
    Schema.isMinCodePoints(minimum),
    Schema.isMaxCodePoints(maximum),
  );

const atMost = (maximum: number) =>
  Schema.String.check(Schema.isMaxCodePoints(maximum));

const version = Schema.NullOr(atMost(100));

const list = <S extends Schema.Top>(item: S, maximum: number) =>
  Schema.mutable(Schema.Array(item)).check(Schema.isMaxLength(maximum));

const int = (minimum: number) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum));

const notice = settingsStruct({
  sessionID: text(1, 256),
  status: Schema.Literals(["queued", "mail", "unchanged", "uncertain"]),
});

const pattern = (regex: RegExp) => Schema.String.check(settingsPattern(regex));

// Zod's `z.uuid()`: the same pattern and the same `uuid` advertisement.
const uuid =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

const straggler = settingsStruct({
  taskID: Schema.optional(atMost(256)),
  sessionID: Schema.optional(atMost(256)),
  reason: text(1, 100),
});

export const componentSchema = settingsStruct({
  /** `stargate`, `cliproxyapi`, or `npm:<package>`. */
  id: text(1, 250),
  before: version,
  after: version,
  /** Version selected after the cool-off, if any. */
  candidate: version,
  status: Schema.Literals([
    "unchanged",
    "planned",
    "updated",
    "rolled-back",
    "failed",
    "skipped",
    "deferred",
  ]),
  reason: Schema.optional(reason),
  /** Npm `--before` cutoff of this install, kept for an exact rollback. */
  cutoff: Schema.optional(iso),
  /** SHA-256 pinned for a downloaded binary asset. */
  digest: Schema.optional(pattern(/^[a-f0-9]{64}$/)),
});

export const modelChangeSchema = settingsStruct({
  /** `catalog`: an additive provider declaration or a rejected/reported candidate. */
  scope: Schema.Literals([
    "catalog",
    "agent-profile",
    "team-file",
    "opencode-config",
    "captain-session",
    "crew-session",
  ]),
  /** Profile route name, file path or session ID. */
  target: text(1, 4096),
  from: text(1, 300),
  to: text(1, 300),
  status: Schema.Literals([
    "planned",
    "applied",
    "rolled-back",
    "failed",
    "skipped",
  ]),
  reason: Schema.optional(reason),
});

export const stepSchema = settingsStruct({
  name: text(1, 100),
  status: Schema.Literals(["ok", "failed", "skipped"]),
  at: iso,
  reason: Schema.optional(reason),
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

/**
 * `no-op`: nothing to change. `completed`: every selected change applied.
 * `partial`: some applied, some failed or rolled back. `rolled-back`:
 * changes were attempted and every one was reverted. `deferred`: nothing
 * applied; retried next window. `failed`: the run could not proceed.
 * `planned`: plan mode only.
 */
export const reportOutcomes = [
  "planned",
  "no-op",
  "completed",
  "partial",
  "rolled-back",
  "deferred",
  "failed",
] as const;

export const reportSchema = settingsStruct({
  schema: Schema.Literal(reportSchemaID),
  runID: Schema.String.check(
    Schema.isPattern(uuid, {
      toJsonSchema: () => ({ format: "uuid", pattern: uuid.source }),
    }),
  ),
  installID: text(1, 100),
  mode: Schema.Literals(["plan", "run"]),
  outcome: Schema.Literals(reportOutcomes),
  reason: Schema.optional(reason),
  window: settingsStruct({
    timeZone: Schema.String,
    localStart: Schema.String,
    localEnd: Schema.String,
    opens: iso,
    plannedStart: iso,
    deadline: iso,
    closes: iso,
    jitterMinutes: int(0),
  }),
  startedAt: iso,
  finishedAt: iso,
  components: list(componentSchema, limits.components),
  cleanup: Schema.optional(cleanupResultSchema),
  models: list(modelChangeSchema, limits.models),
  drain: Schema.optional(
    settingsStruct({
      outcome: Schema.Literals(["idle", "deadline", "aborted"]),
      state: settingsStruct({
        schema: Schema.Literal("stargate.maintenance.drain.v1"),
        runID: text(1, 100),
        pid: Schema.Int.check(Schema.isGreaterThan(0)),
        job: Schema.Literals(["nightly", "outside-window", "operator-update"]),
        services: list(
          Schema.Literals(["gateway", "opencode", "cliproxyapi"]),
          3,
        ),
        startedAt: int(0),
        deadlineAt: int(0),
        phase: Schema.Literals([
          "draining",
          "restarting",
          "completed",
          "aborted",
        ]),
        stragglers: Schema.optional(list(straggler, 1000)),
      }),
      notices: list(notice, 1000),
    }),
  ),
  updateNotices: Schema.optional(list(notice, 1000)),
  steps: list(stepSchema, limits.steps),
  rollbacks: list(
    settingsStruct({
      component: text(1, 250),
      from: atMost(300),
      to: atMost(300),
      status: Schema.Literals(["ok", "failed"]),
      reason: Schema.optional(reason),
    }),
    limits.rollbacks,
  ),
  restarts: list(
    settingsStruct({
      service: Schema.Literals(["gateway", "opencode", "cliproxyapi"]),
      status: Schema.Literals(["ok", "failed"]),
      at: iso,
    }),
    limits.restarts,
  ),
  /**
   * Informational: queued crew assignments that keep the idle gate busy
   * until their captain resolves them. IDs and origins, never task text.
   */
  notes: Schema.optional(
    list(
      settingsStruct({
        kind: Schema.Literal("queued-crew-task"),
        taskID: pattern(/^[A-Za-z0-9_-]{1,100}$/),
        crew: pattern(/^[A-Za-z0-9_-]{1,100}$/),
        originCaptain: pattern(/^ses_[A-Za-z0-9]{1,250}$/),
        originIsPin: Schema.Boolean,
        /** An activity-report task, which blocks the idle gate while queued. */
        report: Schema.Boolean,
        action: atMost(200),
      }),
      limits.notes,
    ),
  ),
  /** Items dropped to keep the report bounded, per array. */
  truncated: Schema.optional(settingsRecord(Schema.String, int(1))),
});

export type Report = typeof reportSchema.Type;

export type ComponentReport = typeof componentSchema.Type;

export type ModelChange = typeof modelChangeSchema.Type;

const decodeReport = Schema.decodeUnknownResult(reportSchema);
const decodeReportSync = Schema.decodeUnknownSync(reportSchema);

// Keyword order of the Zod 4.6.7 advertisement; property names keep theirs.
const keywordOrder = [
  "$schema",
  "maxItems",
  "type",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "items",
  "enum",
  "const",
  "properties",
  "required",
  "propertyNames",
  "additionalProperties",
  "anyOf",
];

const rank = (key: string) => {
  const index = keywordOrder.indexOf(key);

  return index === -1 ? keywordOrder.length : index;
};

function zodKeyOrder(value: unknown, names = false): unknown {
  if (Array.isArray(value)) return value.map((item) => zodKeyOrder(item));

  if (!Predicate.isObject(value)) return value;
  const entries = Object.entries(value);

  if (!names) entries.sort(([a], [b]) => rank(a) - rank(b));

  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      zodKeyOrder(item, !names && key === "properties"),
    ]),
  );
}

/** The report's JSON Schema as `maintenance schema` prints it. */
export function reportJsonSchema() {
  return zodKeyOrder({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...settingsAdvertisement(reportSchema),
  });
}

export const noticeSchemaID = "stargate.maintenance.notice.v1";

export const noticeSchema = settingsStruct({
  schema: Schema.Literal(noticeSchemaID),
  channel: pattern(/^[CG][A-Z0-9]+$/),
  text: text(1, 2800),
  report: pattern(/^[A-Za-z0-9._-]+\.json$/),
});

export type Notice = typeof noticeSchema.Type;

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
    ...(report.notes && { notes: take("notes", report.notes) }),
  };

  if (Object.keys(truncated).length > 0) bounded.truncated = truncated;

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
  const parsed = decodeReport(boundReport(report));

  if (Result.isSuccess(parsed)) valid = parsed.success;
  else
    valid = decodeReportSync({
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
  const valid = Schema.decodeUnknownSync(noticeSchema)(notice);
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
      .toSorted();
  } catch {
    return [];
  }
}

const labels: Record<Reason, string> = Object.fromEntries(
  reasons.map((code) => [code, code.replaceAll("-", " ")]),
) as Record<Reason, string>;

const line = (text: string, max = 200) =>
  Array.from(text.replace(/[\r\n\t]+/g, " "))
    .slice(0, max)
    .join("");

/** One concise, bounded Slack summary. Only codes and versions; no errors. */
export function summary(report: Report, reportName: string) {
  const changed = report.components.filter((c) => c.status !== "unchanged");
  const result = `${report.outcome}${report.reason ? ` (${labels[report.reason]})` : ""}.`;

  const parts = [
    report.steps.some((step) => step.name === "operator-update")
      ? `Operator update of Stargate, outside the window${report.drain ? " with restart drain" : " and without the idle gate"}: ${result}`
      : `Nightly maintenance ${report.window.localStart}–${report.window.localEnd} ${report.window.timeZone}: ${result}`,
  ];

  if (report.drain) {
    const drain = report.drain;
    parts.push(
      `Restart drain: ${drain.state.phase}; ${drain.outcome}; deadline ${new Date(drain.state.deadlineAt).toISOString()}; ${drain.notices.length} notice receipts; ${drain.state.stragglers?.length ?? 0} stragglers.`,
    );

    for (const work of drain.state.stragglers?.slice(0, 8) ?? [])
      parts.push(
        line(
          `- drain straggler: ${work.taskID ?? "no task ID"} ${work.sessionID ?? "no session ID"} (${work.reason})`,
        ),
      );
  }

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

  if (report.rollbacks.length > 0)
    parts.push(
      `Rollbacks: ${report.rollbacks.map((r) => `${r.component} ${r.status}`).join(", ")}.`,
    );
  parts.push(`Private report: ${reportName}`);

  return Array.from(parts.join("\n")).slice(0, 2800).join("");
}
