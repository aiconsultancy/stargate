import { expect, test } from "bun:test";
import { configSchema } from "../src/config";
import { cleanupProtection } from "../src/nightly/cleanup-protection";
import { maintenanceSchema } from "../src/nightly/config";
import type { Crew } from "../src/nightly/crews";

test("maintenance cleanup is opt-in and strict at the real config boundary", () => {
  expect(maintenanceSchema.parse({}).cleanup).toBeUndefined();
  expect(maintenanceSchema.parse({ cleanup: {} }).cleanup?.enabled).toBe(false);
  expect(
    maintenanceSchema.parse({ cleanup: { enabled: true } }).cleanup
      ?.olderThanDays,
  ).toBe(5);
  expect(
    maintenanceSchema.safeParse({ cleanup: { scratchRoots: ["relative"] } })
      .success,
  ).toBe(false);
  expect(
    maintenanceSchema.safeParse({ cleanup: { enabled: true, force: true } })
      .success,
  ).toBe(false);
});

test("cleanup protects configuration, runtime and every permanent crew directory", () => {
  const config = configSchema.parse({
    dataDirectory: "/runtime/pogo",
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
        pluginPackage: "pogo",
      },
    ],
    worktreeDirectories: ["/projects/pi-worker", "/projects/code-worker"],
  };
  expect(cleanupProtection(config, "/config/pogo.json", [crew])).toEqual([
    "/config",
    "/runtime/pogo",
    "/projects/captain",
    "/runtime/crew",
    "/projects/captain",
    "/projects/pi-worker",
    "/projects/code-worker",
  ]);
});
