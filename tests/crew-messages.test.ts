import { expect, test } from "bun:test";
import {
  type Pending,
  type Turn,
  SessionMessages,
  isPending,
} from "../src/backends/opencode/crew-messages";

/** Settled turns: kept until the test marks them gone. */
function turns() {
  const gone = new Set<Turn>();

  const turn = (position: number) => {
    const made = {
      position,
      ended: true,
      log: { retained: () => !gone.has(made) },
    } as unknown as Turn;

    return made;
  };

  return { turn, gone };
}

/** The index as sorted plain data. */
function normalized(index: ReturnType<SessionMessages["index"]>) {
  return {
    turns: new Map(
      [...index.turns].map(([turn, messages]) => [turn, messages.toSorted()]),
    ),
    positions: new Map(
      [...index.positions].map(([position, members]) => [
        position,
        new Set(members),
      ]),
    ),
  };
}

/** The index recomputed from what each message reads as now. */
function recomputed(messages: SessionMessages, assistants: Iterable<string>) {
  const index: ReturnType<SessionMessages["index"]> = {
    turns: new Map(),
    positions: new Map(),
  };

  for (const assistant of assistants) {
    const entry = messages.get(assistant);

    if (!entry || isPending(entry) || "evicted" in entry) {
      continue;
    }

    index.turns.set(entry, [...(index.turns.get(entry) ?? []), assistant]);
    const members = index.positions.get(entry.position) ?? [];

    if (!members.includes(entry)) {
      index.positions.set(entry.position, [...members, entry]);
    }
  }

  return normalized(index);
}

test("the known messages' index matches the known map after every change", () => {
  let forgotten = 0;

  const messages = new SessionMessages(() => {
    forgotten += 1;
  });

  const { turn, gone } = turns();
  const [a, b, c] = [turn(0), turn(0), turn(1)];
  const used = new Set<string>();

  const place = (assistant: string, into: Turn) => {
    used.add(assistant);
    messages.place(assistant, into);
  };

  const consistent = () => {
    expect(normalized(messages.index())).toEqual(recomputed(messages, used));
  };

  place("a1", a);
  place("a2", a);
  place("b1", b);
  place("c1", c);
  consistent();
  expect([...messages.turnsAt(0)]).toEqual([a, b]);

  // Placed again into another turn: the last message of b moves to c.
  place("b1", c);
  consistent();
  expect([...messages.turnsAt(0)]).toEqual([a]);

  // A waiting message let go unplaced.
  const pending = (assistant: string, position: number) =>
    ({ assistant, position }) as unknown as Pending;

  used.add("p1");
  messages.track(pending("p1", 0), () => {});
  messages.evict(pending("p1", 0));
  consistent();

  // The recorder evicts a: its messages leave the index with it.
  gone.add(a);
  messages.prune((entry) => gone.has(entry));
  consistent();
  expect(messages.turnsAt(0).next().done).toBe(true);

  // B goes without a prune: the ceiling drops it before forgetting.
  place("d1", b);
  gone.add(b);

  // Three known before: the first message past the ceiling drops d1.
  // The one after it forgets c1, the oldest known.
  for (let index = 0; index < 16_383; index += 1) {
    place(`m${index}`, c);
  }

  consistent();
  expect(forgotten).toBe(1);
  expect(messages.get("d1")).toEqual({ evicted: true, position: 0 });
  expect(messages.get("c1")).toBeUndefined();
  expect([...messages.turns()]).toEqual([c]);
  expect([...messages.turnsAt(1)]).toEqual([c]);
});
