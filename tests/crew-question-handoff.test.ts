import { expect, test } from "bun:test";
import { CrewQuestionHandoff } from "../src/crew/question-handoff";
import type { CrewTask } from "../src/crew/state";
import type { NativeQuestion } from "../src/questions";

test("a gateway write has one delivery and one final ownership check on the captain route", async () => {
  const task: CrewTask = {
    id: "task_fixture",
    crewID: "worker",
    workerSessionID: "ses_worker",
    originCaptainID: "ses_captain",
    originInputID: null,
    inputID: "msg_input",
    status: "running",
    result: null,
    released: 0,
    notifying: 0,
  };
  const q: NativeQuestion = {
    id: "frm_1",
    sessionID: task.workerSessionID,
    inputID: task.inputID,
    toolMessageID: "msg_tool",
    toolCallID: "call_1",
    fingerprint: "a".repeat(64),
    title: "Colour?",
    fields: [{ type: "string", key: "q0" }],
  };
  const box = new CrewQuestionHandoff();
  let current = true;
  const backend = box.backend(
    task,
    { agent: "worker", directory: "/fixture", namespace: "fixture" },
    () => current,
  );
  const stop = new AbortController();
  const promise = backend.replyQuestion(q, { q0: "blue" }, stop.signal);
  expect(box.take("ses_other").work).toBeNull();
  const work = box.take(task.originCaptainID).work;
  if (!work) throw new Error("Expected claimed command");
  expect(work.owner.task).toBe(task.id);
  expect(box.take(task.originCaptainID).work).toBeNull();
  expect(box.confirm("ses_other", work.id).approved).toBe(false);
  current = false;
  expect(box.confirm(task.originCaptainID, work.id).approved).toBe(false);
  expect(box.finish("ses_other", work.id, { status: "ok" }).received).toBe(
    false,
  );
  box.finish(task.originCaptainID, work.id, { status: "failed" });
  await expect(promise).rejects.toThrow();
  current = true;
  const retry = backend.replyQuestion(q, { q0: "blue" }, stop.signal);
  const other = box.take(task.originCaptainID).work;
  if (!other) throw new Error("Expected second fixture command");
  expect(box.confirm(task.originCaptainID, other.id).approved).toBe(true);
  expect(box.confirm(task.originCaptainID, other.id).approved).toBe(false);
  stop.abort();
  await expect(retry).rejects.toThrow();
  expect(
    box.finish(task.originCaptainID, other.id, { status: "ok" }).received,
  ).toBe(false);
});
