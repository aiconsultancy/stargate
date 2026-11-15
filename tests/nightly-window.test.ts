import { describe, expect, test } from "bun:test";
import { maintenanceSchema } from "../src/nightly/config";
import {
  currentWindow,
  nextWindow,
  occurrence,
  stableJitter,
  timerCalendar,
  windowMinutes,
} from "../src/nightly/window";

const london = {
  start: "00:00",
  end: "01:00",
  timeZone: "Europe/London",
  jitterMinutes: 15,
  reserveMinutes: 10,
};
const day = (text: string) => Temporal.PlainDate.from(text);
const iso = (ms: number) => new Date(ms).toISOString();

describe("stable jitter", () => {
  test("is deterministic, bounded and install-specific", () => {
    const values = ["galactica", "pegasus", "a", "b", "c", "d"].map((id) =>
      stableJitter(id, 15),
    );
    expect(stableJitter("galactica", 15)).toBe(values[0] ?? -1);
    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(15);
    }
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(stableJitter("galactica", 0)).toBe(0);
  });
});

describe("Europe/London window", () => {
  test("winter (GMT) and summer (BST) map local midnight to UTC", () => {
    const winter = occurrence(day("2026-01-15"), london, 7);
    expect(iso(winter.opens)).toBe("2026-01-15T00:00:00.000Z");
    expect(iso(winter.start)).toBe("2026-01-15T00:07:00.000Z");
    expect(iso(winter.deadline)).toBe("2026-01-15T00:50:00.000Z");
    expect(iso(winter.closes)).toBe("2026-01-15T01:00:00.000Z");
    const summer = occurrence(day("2026-07-15"), london, 7);
    expect(iso(summer.opens)).toBe("2026-07-14T23:00:00.000Z");
    expect(iso(summer.closes)).toBe("2026-07-15T00:00:00.000Z");
  });

  test("spring-forward night: a skipped end time moves forward", () => {
    // 2026-03-29: 01:00 GMT becomes 02:00 BST; 01:00 local never occurs.
    const night = occurrence(day("2026-03-29"), london, 0);
    expect(iso(night.opens)).toBe("2026-03-29T00:00:00.000Z");
    expect(iso(night.closes)).toBe("2026-03-29T01:00:00.000Z");
    // A window that starts inside the gap has no time at all that night.
    const gap = occurrence(
      day("2026-03-29"),
      { ...london, start: "01:00", end: "02:00" },
      5,
    );
    expect(gap.closes - gap.opens).toBe(0);
    expect(gap.start).toBe(gap.closes);
    expect(gap.deadline).toBe(gap.opens);
  });

  test("fall-back night: repeated times use the earlier instant", () => {
    // 2026-10-25: 02:00 BST becomes 01:00 GMT; 01:00-02:00 occurs twice.
    const night = occurrence(day("2026-10-25"), london, 0);
    expect(iso(night.opens)).toBe("2026-10-24T23:00:00.000Z");
    expect(iso(night.closes)).toBe("2026-10-25T00:00:00.000Z");
    const long = occurrence(
      day("2026-10-25"),
      { ...london, start: "01:00", end: "02:00" },
      0,
    );
    expect(iso(long.opens)).toBe("2026-10-25T00:00:00.000Z");
    expect((long.closes - long.opens) / 60_000).toBe(120);
  });

  test("current and next window, including a window across midnight", () => {
    const inside = Date.parse("2026-07-14T23:30:00Z");
    expect(currentWindow(inside, london, 3)?.date).toBe("2026-07-15");
    expect(currentWindow(Date.parse("2026-07-15T00:00:00Z"), london, 3)).toBe(
      undefined,
    );
    const next = nextWindow(Date.parse("2026-07-15T12:00:00Z"), london, 3);
    expect(iso(next.start)).toBe("2026-07-15T23:03:00.000Z");
    const late = { ...london, start: "23:30", end: "00:30" };
    const crossing = currentWindow(Date.parse("2026-01-16T00:10:00Z"), late, 0);
    expect(crossing?.date).toBe("2026-01-15");
    expect(iso(crossing?.closes ?? 0)).toBe("2026-01-16T00:30:00.000Z");
    expect(windowMinutes(late)).toBe(60);
  });

  test("timer calendar uses local wall time with the jitter", () => {
    expect(timerCalendar(london, 7)).toBe("*-*-* 00:07:00 Europe/London");
    expect(timerCalendar({ ...london, start: "23:55" }, 10)).toBe(
      "*-*-* 00:05:00 Europe/London",
    );
  });
});

describe("maintenance configuration", () => {
  test("release source defaults to the canonical public repository", () => {
    expect(
      maintenanceSchema.parse({ stargate: { root: "/release-root" } }).stargate
        ?.repository,
    ).toBe("aiconsultancy/stargate");
  });

  test("defaults are disabled, 00:00-01:00 Europe/London, all components off", () => {
    const parsed = maintenanceSchema.parse({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.window).toEqual(london);
    expect(Object.values(parsed.components)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("rejects unsafe or inconsistent settings", () => {
    const bad = [
      { window: { start: "01:00", end: "01:00" } },
      { window: { jitterMinutes: 55, reserveMinutes: 10 } },
      { window: { timeZone: "+01:00" } },
      { window: { timeZone: "Mars/Olympus" } },
      { components: { stargate: true } },
      { components: { models: true }, models: {} },
      { proxy: { url: "http://example.com:8317", clientKeyFile: "/k" } },
      { stargate: { root: "relative" } },
      { services: { openCodeRestart: ["systemctl", "bad\narg"] } },
      { unknown: true },
    ];
    for (const value of bad)
      expect(maintenanceSchema.safeParse(value).success).toBe(false);
    expect(
      maintenanceSchema.safeParse({
        enabled: true,
        components: { models: true },
        models: {},
        proxy: { clientKeyFile: "/home/me/.config/cliproxyapi/client.key" },
      }).success,
    ).toBe(true);
  });
});
