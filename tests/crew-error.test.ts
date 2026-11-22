import { describe, expect, test } from "bun:test";
import { HistoryError } from "../src/crew/history/history";
import { CrewError } from "../src/crew/pending";
import { MissingTaskResult } from "../src/crew/result";
import { CrewError as StateCrewError } from "../src/crew/state";

describe("canonical crew error", () => {
  test("the state export and both subclasses use the leaf constructor", () => {
    expect(StateCrewError).toBe(CrewError);
    expect(Object.getPrototypeOf(CrewError)).toBe(Error);
    expect(Object.getPrototypeOf(CrewError.prototype)).toBe(Error.prototype);
    for (const Subclass of [HistoryError, MissingTaskResult]) {
      expect(Object.getPrototypeOf(Subclass)).toBe(CrewError);
      expect(Object.getPrototypeOf(Subclass.prototype)).toBe(
        CrewError.prototype,
      );
      expect(new Subclass("probe")).toBeInstanceOf(StateCrewError);
    }
  });

  test("default Error fields and serialization stay unchanged", () => {
    const cause = new Error("cause");
    const error = new StateCrewError("probe", { cause });
    expect(error).toBeInstanceOf(CrewError);
    expect(error).toBeInstanceOf(Error);
    expect(error.constructor).toBe(CrewError);
    expect(error.name).toBe("Error");
    expect(error.message).toBe("probe");
    expect(error.cause).toBe(cause);
    expect("code" in error).toBe(false);
    expect("toJSON" in error).toBe(false);
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe("{}");
    expect(String(error)).toBe("Error: probe");
    expect(Object.getOwnPropertyDescriptor(error, "message")).toEqual({
      value: "probe",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  });

  test("captureStackTrace still omits the requested constructor frame", () => {
    function captureCaller() {
      const error = new CrewError("probe");
      Error.captureStackTrace(error, captureCaller);
      return error;
    }
    const error = captureCaller();
    expect(error.stack).toContain("Error: probe");
    expect(error.stack).not.toContain("at captureCaller");
    expect(error).toBeInstanceOf(StateCrewError);
    expect(Object.getOwnPropertyDescriptor(error, "stack")?.enumerable).toBe(
      false,
    );
  });
});
