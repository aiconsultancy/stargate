import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";

test("maintenance cleanup requires a dry-run flag and documents its scope", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runCli(["maintenance", "--help"]);
    expect(output.mock.calls.flat().join(" ")).toContain("cleanup --plan");
    await expect(
      runCli(["maintenance", "cleanup", "--config", "/missing/config"]),
    ).rejects.toThrow("--plan");
    await expect(
      runCli([
        "maintenance",
        "cleanup",
        "--plan",
        "/unexpected",
        "--config",
        "/missing/config",
      ]),
    ).rejects.toThrow();
  } finally {
    output.mockRestore();
  }
});

test("maintenance update parses its flags and keeps them off other commands", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runCli(["maintenance", "--help"]);
    expect(output.mock.calls.flat().join(" ")).toContain(
      "update          --version X.Y.Z with --plan or --now",
    );
    // The flags parse; the command then fails on the missing configuration.
    for (const flags of [
      ["--plan"],
      ["--now"],
      ["--now", "--retry-failed"],
      ["--now", "--foreground"],
    ])
      await expect(
        runCli([
          "maintenance",
          "update",
          "--version",
          "0.2.0",
          ...flags,
          "--config",
          "/missing/config",
        ]),
      ).rejects.toThrow(/config/i);
    for (const args of [
      ["maintenance", "run", "--now"],
      ["maintenance", "recover", "--retry-failed"],
      ["maintenance", "plan", "--foreground"],
      ["start", "--now"],
    ])
      await expect(
        runCli([...args, "--config", "/missing/config"]),
      ).rejects.toThrow("not supported");
  } finally {
    output.mockRestore();
  }
});

test("cron help documents operations and never reads config", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  expect(
    await runCli(["cron", "--help", "--config", "/missing/config"]),
  ).toEqual({ command: "exit" });
  expect(output.mock.calls.flat().join(" ")).toContain(
    "list|add|run|remove|report",
  );
  expect(output.mock.calls.flat().join(" ")).toContain("64 KiB");
  output.mockRestore();
});

test("crew cron binding requires both explicit options and documents them", async () => {
  for (const args of [
    ["--cron-config", "/missing/stargate.json"],
    ["--cron-bot", "helper"],
  ])
    await expect(runCli(["crew", "init", ...args])).rejects.toThrow(
      "must be supplied together",
    );
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runCli(["crew", "init", "--help"]);
    expect(output.mock.calls.flat().join(" ")).toContain("--cron-config");
    expect(output.mock.calls.flat().join(" ")).toContain("--cron-bot");
  } finally {
    output.mockRestore();
  }
});

test("cron rejects unsupported options and selectors before configuration or Slack", async () => {
  for (const args of [
    ["list"],
    ["unknown", "--bot", "helper"],
    ["list", "--bot", "helper", "--input", "/missing"],
    ["list", "--bot", "helper", "extra"],
    ["report", "--bot", "helper", "--name", "task"],
    ["add", "--bot", "helper"],
    ["run", "--bot", "helper"],
    ["run", "task", "--name", "task", "--bot", "helper"],
    ["remove", "not-uuid", "--bot", "helper"],
    ["run", "--bot", "helper", "--prompt", "secret"],
    ["list", "--bot", "helper", "--url", "http://localhost"],
  ])
    await expect(runCli(["cron", ...args])).rejects.toThrow();
});

test("cron add bounds JSON input and never exposes file contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-cron-cli-"));
  try {
    const path = join(directory, "input.json");
    for (const text of [
      "private invalid JSON",
      "x".repeat(65_537),
      "[]",
      '{"op":"list"}',
      '{"name":"private"}',
    ]) {
      await Bun.write(path, text);
      let message = "";
      try {
        await runCli(["cron", "add", "--bot", "helper", "--input", path]);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("private");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
