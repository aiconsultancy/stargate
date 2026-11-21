/**
 * Fake Codex CLI for tests: reads the prompt on stdin, writes `codex exec`
 * JSONL events, records its arguments and environment in CODEX_HOME and
 * never contacts a provider. The prompt selects the behaviour: `hang`,
 * `fail`, `crash`, `linger`, `rethread`, otherwise a two-message answer.
 * `stubborn` first starts a tool process that ignores SIGTERM; `detached`
 * puts it in its own session. `deaf` makes the CLI itself ignore SIGTERM;
 * `hold` leaves its stdout open in a process without the turn marker.
 * `swap` retargets the link `STARGATE_TEST_LINK` to `STARGATE_TEST_TARGET`, as a
 * sandboxed agent could inside its workspace, then runs `git` from `PATH`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const home = process.env["CODEX_HOME"] ?? "";
const args = process.argv.slice(2);
const log = (entry: object) =>
  appendFileSync(join(home, "fixture.jsonl"), `${JSON.stringify(entry)}\n`);
const write = (event: object) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);
const resumeAt = args.indexOf("resume");
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
const images = args.flatMap((argument, index) =>
  argument === "--image" ? [args[index + 1] ?? ""] : [],
);

async function stubborn(detached: boolean) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
    ],
    { stdio: ["ignore", "pipe", "ignore"], detached },
  );
  await new Promise((resolve) => child.stdout.once("data", resolve));
  log({ grandchild: child.pid });
}

let prompt = "";
let deaf = false;
// Decided before any input: the CLI's own SIGTERM handling.
process.on("SIGTERM", () => {
  if (!deaf) process.exit(143);
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  void (async () => {
    deaf = prompt.includes("deaf");
    log({ pid: process.pid, argv: args, env: process.env, cwd: process.cwd() });
    log({ prompt, images: images.map((path) => existsSync(path)) });
    const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    if (resumed && !existsSync(join(sessions, resumed))) {
      process.stderr.write("raw stderr detail: no such thread\n");
      process.exit(1);
    }
    const thread = prompt.includes("rethread")
      ? crypto.randomUUID()
      : (resumed ?? crypto.randomUUID());
    writeFileSync(join(sessions, thread), prompt);
    write({ type: "thread.started", thread_id: thread });
    write({ type: "turn.started" });
    if (prompt.includes("stubborn"))
      await stubborn(prompt.includes("detached"));
    if (prompt.includes("swap")) {
      const link = process.env["STARGATE_TEST_LINK"] ?? "";
      rmSync(link);
      symlinkSync(process.env["STARGATE_TEST_TARGET"] ?? "", link);
      spawnSync("git", ["--version"], { stdio: "ignore" });
    }
    if (prompt.includes("hold")) {
      // Absolute interpreter: the CLI's PATH depends on the host.
      const holder = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: ["ignore", "inherit", "inherit"],
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        },
      );
      log({ grandchild: holder.pid });
    }
    if (prompt.includes("hang")) {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );
      log({ grandchild: child.pid });
      setInterval(() => {}, 1000);
      return;
    }
    if (prompt.includes("crash")) {
      process.stderr.write("raw stderr detail: upstream said no\n");
      process.exit(3);
    }
    // "fail", or "fail=<provider message>;". "tool" runs a command first;
    // "fatal" reports through the stream's `error` event instead.
    if (prompt.includes("fail")) {
      const message =
        /fail=([^;]*);/.exec(prompt)?.[1] ?? "raw upstream detail";
      if (prompt.includes("tool"))
        write({
          type: "item.completed",
          item: {
            id: "item_c",
            type: "command_execution",
            command: "deploy",
            aggregated_output: "",
          },
        });
      write({
        type: "item.completed",
        item: { id: "item_e", type: "error", message },
      });
      write(
        prompt.includes("fatal")
          ? { type: "error", message }
          : { type: "turn.failed", error: { message } },
      );
      process.stderr.write("raw stderr detail\n");
      process.exit(1);
    }
    const item = (body: object) =>
      write({
        type: "item.completed",
        item: { id: crypto.randomUUID(), ...body },
      });
    item({ type: "reasoning", text: "private reasoning" });
    item({
      type: "command_execution",
      command: "cat /secret",
      aggregated_output: "SECRETOUTPUT",
      exit_code: 0,
      status: "completed",
    });
    write({
      type: "item.started",
      item: { id: "msg_1", type: "agent_message", text: "" },
    });
    write({
      type: "item.completed",
      item: { id: "msg_1", type: "agent_message", text: "Hello world" },
    });
    item({ type: "error", message: "raw nonfatal detail" });
    item({ type: "agent_message", text: "Done." });
    write({
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    });
    if (prompt.includes("linger")) setInterval(() => {}, 1000);
  })();
});
