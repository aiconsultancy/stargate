import { describe, expect, test } from "bun:test";
import { validateCronInput } from "../src/cron/index";

const now = Date.parse("2026-01-01T00:00:00Z");

const input = {
  name: "Daily report",
  expression: "0 9 * * *",
  timezone: "UTC",
  prompt: "Prepare the report.",
};

describe("cron validation", () => {
  test("normalizes input and defaults to UTC", () => {
    const result = validateCronInput(
      {
        ...input,
        name: " Report ",
        expression: "0  9 * * *",
        timezone: undefined,
      },
      now,
    );

    expect(result.input.name).toBe("Report");
    expect(result.input.expression).toBe("0 9 * * *");
    expect(result.input.timezone).toBe("UTC");
    expect(result.nextAt).toBe(Date.parse("2026-01-01T09:00:00Z"));
  });

  test("rejects invalid fields without echoing supplied content", () => {
    for (const change of [
      { name: " " },
      { prompt: "" },
      { expression: "@daily" },
      { expression: "0 0 9 * * *" },
      { expression: "61 * * * *" },
      { expression: "0 0 31 2 *" },
      { timezone: "secret/invalid" },
      { timezone: "+01:00" },
      { extra: "unexpected" },
    ]) {
      expect(() => validateCronInput({ ...input, ...change }, now)).toThrow(
        /^Invalid cron /,
      );
    }

    expect(() => validateCronInput(input, Number.NaN)).toThrow();
  });

  test("uses IANA timezone offsets across spring and autumn DST", () => {
    const local = { ...input, timezone: "America/New_York" };
    expect(
      validateCronInput(local, Date.parse("2026-03-07T15:00:00Z")).nextAt,
    ).toBe(Date.parse("2026-03-08T13:00:00Z"));
    expect(
      validateCronInput(local, Date.parse("2026-10-31T15:00:00Z")).nextAt,
    ).toBe(Date.parse("2026-11-01T14:00:00Z"));
  });

  test("fixed-time fall-back runs once; spring gaps run at the first valid time", () => {
    const local = {
      ...input,
      expression: "30 1 * * *",
      timezone: "America/New_York",
    };

    const first = validateCronInput(
      local,
      Date.parse("2026-11-01T00:00:00Z"),
    ).nextAt;

    expect(first).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(validateCronInput(local, first).nextAt).toBe(
      Date.parse("2026-11-02T06:30:00Z"),
    );

    const spring = validateCronInput(
      { ...local, expression: "30 2 * * *" },
      Date.parse("2026-03-08T00:00:00Z"),
    ).nextAt;

    expect(spring).toBe(Date.parse("2026-03-08T07:00:00Z"));
  });

  test("interval schedules continue through the repeated autumn hour", () => {
    const interval = {
      ...input,
      expression: "*/15 * * * *",
      timezone: "America/New_York",
    };

    expect(
      validateCronInput(interval, Date.parse("2026-11-01T05:45:00Z")).nextAt,
    ).toBe(Date.parse("2026-11-01T06:00:00Z"));
  });
});
