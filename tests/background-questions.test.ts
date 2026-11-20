import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend } from "../src/backend";
import { type NativeQuestion, Questions } from "../src/questions";
import { Store } from "../src/store";

const q: NativeQuestion = {
  id: "form_1",
  sessionID: "ses_1",
  inputID: "msg_1",
  toolMessageID: "msg_2",
  toolCallID: "call_1",
  fingerprint: "f".repeat(64),
  title: "A private choice",
  fields: [
    { key: "q0", type: "string", options: [{ label: "Blue", value: "blue" }] },
  ],
};
test("background question retains its case across expiry, ownership changes and an ambiguous write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stargate-background-"));
  const path = join(dir, "gateway.sqlite");
  let store = new Store(path);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let pending = true,
    online = false,
    engineOnline = true,
    replies = 0;
  const sent: string[] = [];
  const route = {
    account: "operator",
    ready: () => online,
    send: async (text: string, allowed: () => boolean) => {
      if (allowed()) sent.push(text);
    },
  };
  const backend: AgentBackend = {
    sessionID: q.sessionID,
    close: async () => {},
    createSession: async () => {
      throw new Error("unexpected session");
    },
    prompt: async () => {
      throw new Error("unexpected prompt");
    },
    pinnedBackgroundQuestions: async () => {
      if (!engineOnline) throw new Error("disconnected");
      return pending ? [q] : [];
    },
    backgroundOutcome: async () => {
      if (!engineOnline) throw new Error("disconnected");
      return pending ? undefined : "answered";
    },
    replyQuestion: async (question, answer, _signal, claim) => {
      expect(question.id).toBe(q.id);
      expect(answer).toEqual({ q0: "blue" });
      if (!claim?.()) throw new Error("route changed");
      replies++;
      pending = false;
      engineOnline = false;
      throw new Error("lost acknowledgement");
    },
  };
  const open = () =>
    new Questions(
      "ship",
      store,
      backend,
      () => ({
        operator: route,
        account: "ship",
        human: () => true,
        publish: async () => {},
      }),
      () => true,
      () => {},
    );
  let bridge = open();
  const signal = new AbortController().signal;
  const poll = async () => {
    bridge.reconcileBackground();
    await bridge.poll(signal);
  };
  const reference = () => {
    const ref = sent.at(-1)?.match(/Q[0-9a-f]{10}/)?.[0];
    if (!ref) throw new Error("Missing reference");
    return ref;
  };
  try {
    await poll();
    expect(sent).toHaveLength(0);
    online = true;
    await poll();
    const old = reference();
    expect(sent[0]).not.toContain(q.title);
    await bridge.operatorAnswer("other", "show " + old, signal);
    expect(sent).toHaveLength(1);
    route.account = "replacement";
    await poll();
    const ref = reference();
    expect(ref).not.toBe(old);
    expect(store.backgroundCases.find("ship", old, false)).toBeNull();
    await bridge.operatorAnswer(route.account, "show " + ref, signal);
    const expired = reference();
    expect(sent.at(-1)).toContain(q.title);
    now += 31 * 60_000;
    await bridge.operatorAnswer(
      route.account,
      "answer " + expired + " 1",
      signal,
    );
    expect(replies).toBe(0);
    await bridge.operatorAnswer(route.account, "show " + ref, signal);
    const token = reference();
    expect(token).not.toBe(expired);
    await bridge.operatorAnswer(
      route.account,
      "answer " + expired + " 1",
      signal,
    );
    expect(replies).toBe(0);
    await Promise.all(
      [1, 2].map(() =>
        bridge.operatorAnswer(route.account, "answer " + token + " 1", signal),
      ),
    );
    expect(replies).toBe(1);
    expect(store.backgroundCases.find("ship", ref, false)?.state).toBe(
      "attempted",
    );
    store.close();
    store = new Store(path);
    bridge = open();
    engineOnline = true;
    await poll();
    expect(store.backgroundCases.find("ship", ref, false)?.state).toBe(
      "answered",
    );
    await bridge.operatorAnswer(
      route.account,
      "answer " + token + " 1",
      signal,
    );
    expect(replies).toBe(1);
  } finally {
    clock.mockRestore();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
