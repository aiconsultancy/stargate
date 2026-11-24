import { createHash } from "node:crypto";
import { hostname } from "node:os";

const pad = (n: number) => String(n).padStart(2, "0");

export type WindowSpec = {
  start: string;
  end: string;
  timeZone: string;
  jitterMinutes: number;
  reserveMinutes: number;
};

/** One night's window. All instants are epoch milliseconds. */
export type Occurrence = {
  /** Local calendar date on which the window opens (YYYY-MM-DD). */
  date: string;
  opens: number;
  /** Planned start: opening plus the stable jitter, never after `closes`. */
  start: number;
  /** No new change begins at or after this instant. */
  deadline: number;
  closes: number;
};

/** Default install identity: host plus resolved config path, hashed. */
export function defaultInstallID(configPath: string, host = hostname()) {
  return createHash("sha256")
    .update(`${host}\0${configPath}`)
    .digest("hex")
    .slice(0, 16);
}

/** Stable delay in whole minutes, 0..max, derived from the install identity. */
export function stableJitter(installID: string, max: number) {
  if (max <= 0) return 0;
  const digest = createHash("sha256").update(`jitter:${installID}`).digest();

  return digest.readUInt32BE(0) % (max + 1);
}

function clock(value: string) {
  const [hour = 0, minute = 0] = value.split(":").map(Number);

  return { hour, minute };
}

/**
 * Local wall time to an instant. Uses Temporal "compatible" disambiguation:
 * a time skipped by a DST gap moves forward; a repeated time picks the
 * earlier instant. This matches systemd calendar timers in practice.
 */
export function zonedInstant(
  date: Temporal.PlainDate,
  time: string,
  timeZone: string,
) {
  return date
    .toPlainDateTime(clock(time))
    .toZonedDateTime(timeZone, { disambiguation: "compatible" })
    .epochMilliseconds;
}

export function occurrence(
  date: Temporal.PlainDate,
  spec: WindowSpec,
  jitter: number,
): Occurrence {
  const crosses =
    clock(spec.end).hour * 60 + clock(spec.end).minute <=
    clock(spec.start).hour * 60 + clock(spec.start).minute;

  const opens = zonedInstant(date, spec.start, spec.timeZone);

  const closes = zonedInstant(
    crosses ? date.add({ days: 1 }) : date,
    spec.end,
    spec.timeZone,
  );

  return {
    date: date.toString(),
    opens,
    start: Math.min(opens + jitter * 60_000, closes),
    deadline: Math.max(opens, closes - spec.reserveMinutes * 60_000),
    closes,
  };
}

function localDate(now: number, timeZone: string) {
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
}

/** The window containing `now`, if any. */
export function currentWindow(now: number, spec: WindowSpec, jitter: number) {
  const today = localDate(now, spec.timeZone);

  for (const date of [today.subtract({ days: 1 }), today]) {
    const window = occurrence(date, spec, jitter);

    if (window.opens <= now && now < window.closes) return window;
  }

  return;
}

function adjacentWindow(
  now: number,
  spec: WindowSpec,
  jitter: number,
  step: 1 | -1,
) {
  let date = localDate(now, spec.timeZone).subtract({ days: step });

  for (let day = 0; day < 4; day++, date = date.add({ days: step })) {
    const window = occurrence(date, spec, jitter);

    if (step === 1 ? window.start > now : window.start <= now) return window;
  }

  throw new Error("No maintenance window found.");
}

/** The next window whose planned start is after `now`. */
export function nextWindow(now: number, spec: WindowSpec, jitter: number) {
  return adjacentWindow(now, spec, jitter, 1);
}

/** The latest window whose planned start is at or before `now`. */
export function previousWindow(now: number, spec: WindowSpec, jitter: number) {
  return adjacentWindow(now, spec, jitter, -1);
}

/** Local `HH:MM` plus minutes, wrapped to the day. */
export function addClock(time: string, minutes: number) {
  const { hour, minute } = clock(time);
  const total = (((hour * 60 + minute + minutes) % 1440) + 1440) % 1440;

  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Systemd OnCalendar for the planned start in the window's time zone. */
export function timerCalendar(spec: WindowSpec, jitter: number) {
  const { hour, minute } = clock(spec.start);
  const total = (hour * 60 + minute + jitter) % 1440;

  return `*-*-* ${pad(Math.floor(total / 60))}:${pad(total % 60)}:00 ${spec.timeZone}`;
}

/** Nominal window length in minutes (ignores DST changes on a given night). */
export function windowMinutes(spec: Pick<WindowSpec, "start" | "end">) {
  const s = clock(spec.start);
  const e = clock(spec.end);

  return (e.hour * 60 + e.minute - (s.hour * 60 + s.minute) + 1440) % 1440;
}
