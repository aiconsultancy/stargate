import type { Database } from "bun:sqlite";

type ReportScope = { botKey: string; channel: string; user: string };

function checkReportDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid cron report date.");
  }

  const parsed = new Date(`${date}T00:00:00Z`);

  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Invalid cron report date.");
  }
}

export function claimDailyReport(
  db: Database,
  scope: ReportScope,
  date: string,
): boolean {
  checkReportDate(date);

  return (
    db
      .query(`INSERT OR IGNORE INTO cron_daily_reports
    (botKey,channel,user,date) VALUES (?,?,?,?)`)
      .run(scope.botKey, scope.channel, scope.user, date).changes > 0
  );
}

export function finishDailyReport(
  db: Database,
  scope: ReportScope,
  date: string,
  status: "done" | "failed",
): void {
  checkReportDate(date);

  if (status !== "done" && status !== "failed") {
    throw new Error("Invalid cron report status.");
  }

  db.query(`UPDATE cron_daily_reports SET status=?
    WHERE botKey=? AND channel=? AND user=? AND date=? AND status='announcing'`).run(
    status,
    scope.botKey,
    scope.channel,
    scope.user,
    date,
  );
}
