#!/usr/bin/env bun
import { runCli } from "./cli";
import { RuntimeStopped, start } from "./runtime";

const result = await runCli(process.argv.slice(2)).catch((error: unknown) => {
  // CLI helpers sanitize errors; never expose raw SDK or credential failures.
  console.error(
    error instanceof Error ? error.message : "Stargate CLI failed.",
  );
  process.exitCode = 1;
});

if (result?.command === "start") {
  try {
    await start(result.configPath);
  } catch (error) {
    // SDK failures can include tokens or prompts. Never echo their errors.
    console.error(
      error instanceof RuntimeStopped
        ? "Stargate stopped after a runtime failure. Check the service log; the service manager may restart it."
        : "Stargate could not start. Run stargate config check, then check backend credentials and service connectivity. Another process may own the data directory.",
    );
    process.exitCode = 1;
  }
}
