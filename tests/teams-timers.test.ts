import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { openStore } from "../src/app/open-store";
import type { Incoming } from "../src/gateway/store-types";
import { fixtureRoot } from "./fixture-root";

const minute = 60_000;
const pin = "ses_officer";

function activity(eventId: string, thread = "original"): Incoming {
  return {
    eventId,
    botKey: "teams-bot",
    channel: "chat",
    conversation: "conversation",
    thread,
    user: "human",
    text: "Check the preview",
  };
}

test("same-thread human input postpones one durable wake and preserves its original reply", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "teams-timers-"));
  const path = join(directory, "queue.sqlite");
  let store = openStore(path);

  try {
    store.teamsTimers.admitHuman(activity("start"), "scope", 0);
    const source = store.jobByEvent("teams-bot", "start");

    if (!source) {
      throw new Error("Missing test source");
    }

    expect(
      store.teamsTimers.change(source, pin, "tool1", { op: "set" }, 0),
    ).toEqual({
      state: "armed",
      dueAt: new Date(30 * minute).toISOString(),
    });
    store.teamsTimers.admitHuman(
      activity("reply", "reply"),
      "scope",
      10 * minute,
    );
    store.teamsTimers.admitHuman(
      activity("other"),
      "another-scope",
      20 * minute,
    );
    expect(
      store.teamsTimers.admitHuman(activity("reply"), "scope", 25 * minute),
    ).toBe(false);
    store.close();
    store = openStore(path);
    store.teamsTimers.releaseDue("teams-bot", "other-pin", 45 * minute);
    store.teamsTimers.releaseDue("teams-bot", pin, 40 * minute - 1);
    expect(store.jobByEvent("teams-bot", "teams-timer:tool1")).toBeNull();
    store.teamsTimers.releaseDue("teams-bot", pin, 40 * minute);

    const wake = store.jobByEvent("teams-bot", "teams-timer:tool1");
    expect(wake).toMatchObject({
      thread: "original",
      user: "human",
      fleet: { kind: "timer", originEvent: "start" },
    });

    if (!wake) {
      throw new Error("Missing wake");
    }

    expect(store.running(wake.id)).toBe(true);
    store.teamsTimers.releaseDue("teams-bot", pin, 40 * minute);

    expect(
      store.teamsTimers.change(
        source,
        pin,
        "tool1",
        { op: "set" },
        41 * minute,
      ),
    ).toEqual({ state: "idle" });
    expect(
      store.teamsTimers.change(
        wake,
        pin,
        "tool2",
        { op: "set", minutes: 15 },
        42 * minute,
      ),
    ).toMatchObject({ state: "armed" });
    expect(
      store.teamsTimers.change(
        wake,
        pin,
        "tool3",
        { op: "cancel" },
        43 * minute,
      ),
    ).toEqual({ state: "idle" });
    store.teamsTimers.releaseDue("teams-bot", pin, 90 * minute);
    expect(store.jobByEvent("teams-bot", "teams-timer:tool2")).toBeNull();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-thread human input postpones a queued timer before the gateway can claim it", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "queued-team-timer-"));
  const store = openStore(join(directory, "queue.sqlite"));
  const now = Date.now();

  try {
    store.teamsTimers.admitHuman(
      activity("original"),
      "scope",
      now - 30 * minute,
    );
    const source = store.jobByEvent("teams-bot", "original");

    if (!source) {
      throw new Error("Missing test source");
    }

    store.teamsTimers.change(
      source,
      pin,
      "tool1",
      { op: "set" },
      now - 30 * minute,
    );
    store.teamsTimers.releaseDue("teams-bot", pin, now);
    const wake = store.jobByEvent("teams-bot", "teams-timer:tool1");

    if (!wake) {
      throw new Error("Missing queued wake");
    }

    expect(store.running(source.id)).toBe(true);
    store.respond(source.id, []);
    store.finish(source.id);
    store.teamsTimers.admitHuman(activity("reply", "reply"), "scope", now);
    expect(store.running(wake.id)).toBe(false);
    const [reply] = store.ready("teams-bot", now, 10);
    expect(reply?.eventId).toBe("reply");

    if (!reply) {
      throw new Error("Missing follow-up");
    }

    expect(store.running(reply.id)).toBe(true);
    store.respond(reply.id, []);
    store.finish(reply.id);

    const deadline = now + 30 * minute;
    store.teamsTimers.releaseDue("teams-bot", pin, deadline - 1);
    expect(store.ready("teams-bot", deadline - 1, 10)).toEqual([]);
    store.teamsTimers.releaseDue("teams-bot", pin, deadline);
    const [newWake] = store.ready("teams-bot", deadline, 10);
    expect(newWake?.id).not.toBe(wake.id);
    expect(newWake?.fleet).toEqual({ kind: "timer", originEvent: "original" });
    expect(newWake?.thread).toBe("original");

    store.teamsTimers.change(source, pin, "tool2", { op: "cancel" }, now);
    expect(store.ready("teams-bot", deadline, 10)).toEqual([]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
