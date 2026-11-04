#!/usr/bin/env bun
import { runCli } from "./cli";
import { start } from "./runtime";

const result = await runCli(process.argv.slice(2)).catch((error: unknown) => {
  // CLI helpers sanitize validation/credential errors; they do not run SDKs.
  console.error(error instanceof Error ? error.message : "Pogo CLI failed.");
  process.exitCode = 1;
});

if (result?.command === "start") {
  try {
    await start(result.configPath);
  } catch {
    // SDK failures can include tokens or prompts. Never echo their errors.
    console.error(
      "Pogo could not start. Run pogo config check, then check backend credentials and service connectivity. Another process may own the data directory.",
    );
    process.exitCode = 1;
  }
}
