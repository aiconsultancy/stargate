import { expect, test } from "bun:test";
import { buildUnit, serviceName } from "../src/service";

test("unit uses private user service configuration and absolute commands", () => {
  const unit = buildUnit("/work/pogo.json", "/usr/bin/bun", "/app/src/main.ts");
  expect(unit).toContain(
    'ExecStart="/usr/bin/bun" "/app/src/main.ts" start --config "/work/pogo.json"',
  );
  expect(unit).toContain("WorkingDirectory=/work/");
  expect(unit).toContain("EnvironmentFile=-/work/pogo.json.env");
  expect(unit).toContain("UMask=0077");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("WantedBy=default.target");
});
test("systemd quoting prevents expansion and line injection", () => {
  const unit = buildUnit(
    '/work space/%h/$HOME/"pogo.json',
    "/usr/bin/bun",
    "/app/main.ts",
  );
  expect(unit).toContain(
    'EnvironmentFile=-/work space/%%h/$HOME/"pogo.json.env',
  );
  expect(unit).toContain('--config "/work space/%%h/$$HOME/\\"pogo.json"');
  expect(() => buildUnit("/work/\nExecStart=bad")).toThrow(
    "control characters",
  );
  expect(() => buildUnit("relative.json")).toThrow("absolute");
  expect(() => serviceName("../other")).toThrow("Invalid service name");
  expect(serviceName("pogo-team")).toBe("pogo-team.service");
});
