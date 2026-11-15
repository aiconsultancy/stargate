import { expect, test } from "bun:test";
import { buildUnit, serviceName } from "../src/service";

test("unit uses private user service configuration and absolute commands", () => {
  const unit = buildUnit(
    "/work/stargate.json",
    "/usr/bin/bun",
    "/app/src/main.ts",
  );
  expect(unit).toContain(
    'ExecStart="/usr/bin/bun" "/app/src/main.ts" start --config "/work/stargate.json"',
  );
  expect(unit).toContain("WorkingDirectory=/work/");
  expect(unit).toContain("EnvironmentFile=-/work/stargate.json.env");
  expect(unit).toContain("UMask=0077");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("WantedBy=default.target");
});
test("systemd quoting prevents expansion and line injection", () => {
  const unit = buildUnit(
    '/work space/%h/$HOME/"stargate.json',
    "/usr/bin/bun",
    "/app/main.ts",
  );
  expect(unit).toContain(
    'EnvironmentFile=-/work space/%%h/$HOME/"stargate.json.env',
  );
  expect(unit).toContain('--config "/work space/%%h/$$HOME/\\"stargate.json"');
  expect(() => buildUnit("/work/\nExecStart=bad")).toThrow(
    "control characters",
  );
  expect(() => buildUnit("relative.json")).toThrow("absolute");
  expect(() => serviceName("../other")).toThrow("Invalid service name");
  expect(serviceName("stargate-team")).toBe("stargate-team.service");
});
