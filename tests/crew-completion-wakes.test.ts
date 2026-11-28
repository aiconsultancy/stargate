import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CrewSessions } from "../src/coordination/crew/execution/engine";
import { CrewState } from "../src/coordination/crew/execution/state";
import { crewCompletionMessageID } from "../src/coordination/crew/message-protocol";
import { fixtureRoot } from "./fixture-root";

test("only new verified completions wake their original pin, durably and with one native ID", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "crew-wake-"));
  const pin = "ses_captain";

  const open = () =>
    CrewState.open(directory, "work", "identity", undefined, false, pin);

  let state = await open();
  const worker = await open();
  state.completionWakes.configure(pin, true);
  const native = new Map<string, Parameters<CrewSessions["synthetic"]>[0]>();
  let firstWrite = true;

  const sessions = {
    async synthetic(input: Parameters<CrewSessions["synthetic"]>[0]) {
      if (!input.id) {
        throw new Error("Missing native ID");
      }

      native.set(input.id, input);

      if (firstWrite) {
        firstWrite = false;
        throw new Error("Lost admission response");
      }
    },
  };

  const signal = new AbortController().signal;

  try {
    const peer = state.reservePeer("builder");
    const task = state.reserveTask(peer, pin, "Make a mockup", "msg_original");

    if (!task) {
      throw new Error("Missing reserved task");
    }

    worker.complete(task.id, peer.sessionID, "Complete");
    expect(state.task(task.id)?.status).toBe("completed");
    const id = crewCompletionMessageID(task.id);
    await state.completionWakes.deliver("ses_replacement", sessions, signal);
    expect(native.size).toBe(0);
    await expect(
      state.completionWakes.deliver(pin, sessions, signal),
    ).rejects.toThrow("Lost admission response");
    state.close();
    state = await open();
    await state.completionWakes.deliver(pin, sessions, signal);
    expect(native.size).toBe(1);
    expect(native.get(id)).toMatchObject({
      sessionID: pin,
      delivery: "queue",
      resume: true,
      metadata: {
        pogoCrew: { sourceTaskID: task.id, originInputID: "msg_original" },
      },
    });
    native.clear();
    await state.completionWakes.deliver(pin, sessions, signal);
    expect(native.size).toBe(0);
  } finally {
    worker.close();
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
