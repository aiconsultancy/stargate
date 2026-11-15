import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MesijClient, MesijError } from "../src/crew/mesij";

// Release checks run `bun test` with a minimal PATH and no mise; only the
// real-binary tests need the pinned Mesij, so skip just those there.
const mise = Bun.which("mise");
// Fake-command tests replace this; it only has to pass option validation.
let command = "/nonexistent/mesij";
if (mise) {
  const locator = Bun.spawn([mise, "which", "mesij"], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [locatedCommand, locatorExit] = await Promise.all([
    new Response(locator.stdout).text(),
    locator.exited,
  ]);
  if (locatorExit !== 0)
    throw new Error("Install the pinned Mesij tool with mise.");
  command = locatedCommand.trim();
}
const realMesij = test.skipIf(!mise);
const signal = new AbortController().signal;

async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/stargate-mesij-");
  await chmod(directory, 0o700);
  const projectDirectory = join(directory, "project");
  const dataDirectory = join(directory, "data");
  await mkdir(projectDirectory, { mode: 0o700 });
  await mkdir(dataDirectory, { mode: 0o700 });
  const init = Bun.spawn(["git", "init", "--quiet", projectDirectory], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await init.exited) !== 0) throw new Error("Temporary Git init failed.");
  const options = { command, projectDirectory, dataDirectory };
  return {
    directory,
    options,
    client: new MesijClient(options),
    async executable(source: string) {
      const path = join(directory, "mesij-fixture");
      await writeFile(path, `#!${process.execPath}\n${source}`, {
        mode: 0o700,
      });
      return path;
    },
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const message = {
  actor: "Bowser",
  sessionID: "indra-bowser",
  to: "indra-mario",
  text: 'Review "task"\nNo shell expansion: $SECRET; 日本語',
  key: "task:assignment",
};

realMesij(
  "real Mesij preserves named sessions, direct replies and inbox cursors",
  async () => {
    const setup = await fixture();
    try {
      const first = await setup.client.register(
        "Bowser",
        "indra-bowser",
        signal,
      );
      await setup.client.register("Mario", "indra-mario", signal);
      expect(
        await setup.client.inbox({ sessionID: "indra-mario" }, signal),
      ).toEqual([]);
      const sent = await setup.client.send(message, signal);
      expect(await setup.client.send(message, signal)).toEqual(sent);
      const reopened = new MesijClient(setup.options);
      expect(await reopened.register("Bowser", "indra-bowser", signal)).toEqual(
        first,
      );
      expect(
        await reopened.inbox({ sessionID: "indra-mario", limit: 1 }, signal),
      ).toEqual([
        {
          ...sent,
          actor: "Bowser",
          sessionID: "indra-bowser",
          to: "indra-mario",
          type: "message.posted",
          text: message.text,
        },
      ]);
      const reply = await reopened.send(
        {
          actor: "Mario",
          sessionID: "indra-mario",
          to: "indra-bowser",
          text: "Reviewed.",
          key: "task:reply",
          replyTo: sent.id,
        },
        signal,
      );
      expect(
        await reopened.inbox(
          { sessionID: "indra-bowser", after: sent.sequence },
          signal,
        ),
      ).toEqual([
        {
          ...reply,
          actor: "Mario",
          sessionID: "indra-mario",
          to: "indra-bowser",
          replyTo: sent.id,
          type: "message.replied",
          text: "Reviewed.",
        },
      ]);
      expect(
        await reopened.inbox(
          { sessionID: "indra-mario", after: reply.sequence },
          signal,
        ),
      ).toEqual([]);
      const isolated = new MesijClient({
        ...setup.options,
        dataDirectory: join(setup.directory, "other-data"),
      });
      await isolated.register("Mario", "indra-mario", signal);
      expect(
        await isolated.inbox({ sessionID: "indra-mario" }, signal),
      ).toEqual([]);
    } finally {
      await setup.close();
    }
  },
);

realMesij(
  "real Mesij paginates and rejects changed idempotent retries safely",
  async () => {
    const setup = await fixture();
    try {
      await setup.client.register("Bowser", "indra-bowser", signal);
      await setup.client.register("Mario", "indra-mario", signal);
      const first = await setup.client.send(message, signal);
      const second = await setup.client.send(
        { ...message, text: "Next task.", key: "next:assignment" },
        signal,
      );
      expect(
        await setup.client.inbox(
          { sessionID: "indra-mario", limit: 1 },
          signal,
        ),
      ).toHaveLength(1);
      const page = await setup.client.inbox(
        { sessionID: "indra-mario", after: first.sequence, limit: 1 },
        signal,
      );
      expect(page[0]?.id).toBe(second.id);
      await expect(
        setup.client.send(
          { ...message, text: "Changed private prompt." },
          signal,
        ),
      ).rejects.toThrow("Mesij command failed.");
    } finally {
      await setup.close();
    }
  },
);

test("emit sends strict JSON on stdin, never prompt text in argv", async () => {
  const setup = await fixture();
  try {
    const fake = await setup.executable(`
const input = JSON.parse(await Bun.stdin.text());
if (process.argv.slice(2).at(-1) !== "emit" ||
    process.argv.some(arg => arg.includes(input.message))) process.exit(1);
if (input.actor !== "Bowser" || input.session !== "indra-bowser" ||
    input.to !== "indra-mario" || input.event !== "post") process.exit(1);
process.stdout.write(JSON.stringify({
  id: "a".repeat(32), sequence: 1, actor: input.actor,
  session: input.session, recipient_session: input.to,
  type: "message.posted", payload: {message: input.message}, inserted: true
}));
`);
    const client = new MesijClient({ ...setup.options, command: fake });
    expect(await client.send(message, signal)).toEqual({
      id: "a".repeat(32),
      sequence: 1,
    });
  } finally {
    await setup.close();
  }
});

test("invalid options and inputs produce sanitised typed errors", async () => {
  const setup = await fixture();
  try {
    expect(
      () => new MesijClient({ ...setup.options, command: "mesij" }),
    ).toThrow("Invalid Mesij options.");
    for (const input of [
      { sessionID: "indra-mario", after: -1 },
      { sessionID: "indra-mario", after: Number.MAX_SAFE_INTEGER + 1 },
      { sessionID: "indra-mario", limit: 0 },
      { sessionID: "indra-mario", limit: 1001 },
    ]) {
      await expect(setup.client.inbox(input, signal)).rejects.toThrow(
        "Invalid Mesij input.",
      );
    }
    await expect(
      setup.client.send({ ...message, text: "" }, signal),
    ).rejects.toBeInstanceOf(MesijError);
    await expect(
      setup.client.register("", "indra-bowser", signal),
    ).rejects.toThrow("Invalid Mesij input.");
  } finally {
    await setup.close();
  }
});

test("command failures and malformed output never expose private data", async () => {
  const setup = await fixture();
  try {
    for (const source of [
      'process.stderr.write("PRIVATE STDERR"); process.stdout.write("PRIVATE ENVELOPE"); process.exit(1);',
      'process.stdout.write("PRIVATE INVALID JSON");',
      'process.stdout.write(JSON.stringify({id:"private",sequence:-1}));',
    ]) {
      const fake = await setup.executable(source);
      const client = new MesijClient({ ...setup.options, command: fake });
      try {
        await client.send(message, signal);
        throw new Error("Expected failure.");
      } catch (error) {
        expect(error).toBeInstanceOf(MesijError);
        expect(String(error)).not.toContain("PRIVATE");
        expect(String(error)).not.toContain(message.text);
        expect(
          error instanceof Error ? error.cause : undefined,
        ).toBeUndefined();
      }
    }
    const missing = new MesijClient({
      ...setup.options,
      command: join(setup.directory, "missing-private-command"),
    });
    await expect(missing.send(message, signal)).rejects.toThrow(
      "Mesij command failed.",
    );
  } finally {
    await setup.close();
  }
});

test("oversized stdout kills and awaits the subprocess", async () => {
  const setup = await fixture();
  try {
    const fake = await setup.executable(`
process.stdout.write("x".repeat(4096));
setInterval(() => {}, 10000);
`);
    const client = new MesijClient({
      ...setup.options,
      command: fake,
      maxOutputBytes: 1024,
    });
    await expect(client.send(message, signal)).rejects.toThrow(
      "Mesij output exceeded its limit.",
    );
  } finally {
    await setup.close();
  }
});

test("inbox rejects invalid sequence order, cursors and oversized pages", async () => {
  const setup = await fixture();
  const event = {
    id: "a".repeat(32),
    sequence: 2,
    actor: "Bowser",
    session: "indra-bowser",
    recipient_session: "indra-mario",
    type: "message.posted",
    payload: { message: "Private message." },
  };
  try {
    for (const page of [
      [event, event],
      [{ ...event, sequence: 1 }],
      [event, { ...event, sequence: 3 }, { ...event, sequence: 4 }],
      [{ ...event, type: "session.started" }],
    ]) {
      const fake = await setup.executable(
        `process.stdout.write(${JSON.stringify(JSON.stringify(page))});`,
      );
      const client = new MesijClient({ ...setup.options, command: fake });
      await expect(
        client.inbox({ sessionID: "indra-mario", after: 1, limit: 2 }, signal),
      ).rejects.toThrow("Invalid Mesij response.");
    }
  } finally {
    await setup.close();
  }
});

test("command timeout stops a subprocess that never exits", async () => {
  const setup = await fixture();
  try {
    const fake = await setup.executable("setInterval(() => {}, 10000);");
    const client = new MesijClient({
      ...setup.options,
      command: fake,
      timeoutMs: 25,
    });
    await expect(client.send(message, signal)).rejects.toThrow(
      "Mesij operation timed out.",
    );
  } finally {
    await setup.close();
  }
});

test("abort kills underlying work and waits for process exit", async () => {
  const setup = await fixture();
  const controller = new AbortController();
  let pid: number | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      pid = Number(new URL(request.url).searchParams.get("pid"));
      controller.abort();
      return new Response("ready");
    },
  });
  try {
    const fake = await setup.executable(`
process.on("SIGTERM", () => {});
await fetch(${JSON.stringify(`${server.url}?pid=`)} + process.pid);
setInterval(() => {}, 10000);
`);
    const client = new MesijClient({ ...setup.options, command: fake });
    await expect(client.send(message, controller.signal)).rejects.toThrow(
      "Mesij operation cancelled.",
    );
    expect(pid).toBeGreaterThan(0);
    const exitedPID = pid;
    if (exitedPID !== undefined)
      expect(() => process.kill(exitedPID, 0)).toThrow();
    await expect(client.send(message, controller.signal)).rejects.toThrow(
      "Mesij operation cancelled.",
    );
  } finally {
    await server.stop(true);
    await setup.close();
  }
});
