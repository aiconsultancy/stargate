import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { configSchema } from "../src/config";
import { cleanupProtection } from "../src/nightly/cleanup-protection";
import { maintenanceSchema } from "../src/nightly/config";
import type { Crew } from "../src/nightly/crews";

test("maintenance cleanup is opt-in and strict at the real config boundary", () => {
  expect(
    Schema.decodeUnknownSync(maintenanceSchema)({}).cleanup,
  ).toBeUndefined();
  expect(
    Schema.decodeUnknownSync(maintenanceSchema)({ cleanup: {} }).cleanup
      ?.enabled,
  ).toBe(false);
  expect(
    Schema.decodeUnknownSync(maintenanceSchema)({ cleanup: { enabled: true } })
      .cleanup?.olderThanDays,
  ).toBe(5);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(maintenanceSchema)({
        cleanup: { scratchRoots: ["relative"] },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(maintenanceSchema)({
        cleanup: { enabled: true, force: true },
      }),
    ),
  ).toBe(false);
});

test("cleanup protects configuration, runtime and every permanent crew directory", () => {
  const config = Schema.decodeUnknownSync(configSchema)({
    dataDirectory: "/runtime/stargate",
    bots: [
      {
        id: "captain",
        slack: { appId: "A1", appTokenEnv: "APP", botTokenEnv: "BOT" },
        access: { users: ["U1"], channels: ["C1"] },
        backend: {
          type: "opencode",
          url: "http://127.0.0.1:4096",
          directory: "/projects/captain",
        },
      },
    ],
  });
  const crew: Crew = {
    namespace: "ship",
    captainDirectory: "/projects/captain",
    piMembers: ["twiki"],
    stateDirectory: "/runtime/crew",
    captainSessionID: "ses_captain",
    roots: [
      {
        directory: "/projects/captain",
        configPath: "/projects/captain/opencode.json",
        pluginPackage: "stargate",
      },
    ],
    worktreeDirectories: ["/projects/pi-worker", "/projects/code-worker"],
  };
  expect(cleanupProtection(config, "/config/stargate.json", [crew])).toEqual([
    "/config",
    "/runtime/stargate",
    "/projects/captain",
    "/runtime/crew",
    "/projects/captain",
    "/projects/pi-worker",
    "/projects/code-worker",
  ]);
});
