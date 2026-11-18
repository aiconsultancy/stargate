import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { JournalStore, journalInputSchema } from "../src/crew/journal";

test("journal input keeps strict branches, defaults, trim and Unicode bounds", () => {
  const parse = Schema.decodeUnknownSync(journalInputSchema, {
    onExcessProperty: "error",
  });
  expect(parse({ op: "read" })).toEqual({
    op: "read",
    after: 0,
    limit: 20,
  });
  expect(parse({ op: "append", text: "  note \n" })).toEqual({
    op: "append",
    text: "note",
  });
  expect(parse({ op: "append", text: "😀".repeat(64000) })).toEqual({
    op: "append",
    text: "😀".repeat(64000),
  });
  expect(
    parse({
      op: "read",
      after: Number.MAX_SAFE_INTEGER,
      limit: 100,
      member: "x".repeat(64),
    }),
  ).toMatchObject({ after: Number.MAX_SAFE_INTEGER, limit: 100 });
  for (const input of [
    {},
    { op: "unknown" },
    { op: "append", text: "  " },
    { op: "append", text: `${"😀".repeat(64000)}x` },
    { op: "append", text: "note", after: 0 },
    { op: "read", text: "wrong branch" },
    { op: "read", unexpected: true },
    { op: "read", after: -1 },
    { op: "read", after: 0.5 },
    { op: "read", after: Number.MAX_SAFE_INTEGER + 1 },
    { op: "read", after: null },
    { op: "read", member: "" },
    { op: "read", member: "x".repeat(65) },
    { op: "read", limit: 0 },
    { op: "read", limit: 101 },
    { op: "read", limit: 1.5 },
    { op: "read", limit: "20" },
  ])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(journalInputSchema, {
          onExcessProperty: "error",
        })(input),
      ),
    ).toBe(true);
});

test("journal persists bounded redacted milestones, retry identity and scoped cursors", () => {
  const db = new Database(":memory:");
  const journal = new JournalStore(db);
  try {
    const note = {
      member: "chief",
      captainID: "root-a",
      taskID: null,
      kind: "note" as const,
      text: `Checked token=private-value ${"x".repeat(2000)}`,
    };
    const first = journal.append(note, "call-1");
    expect(first.created).toBeGreaterThan(0);
    expect(first.text.length).toBe(1500);
    expect(first.text).not.toContain("private-value");
    expect(journal.append(note, "call-1")).toEqual(first);
    journal.append({ ...note, captainID: "root-b" }, "call-2");
    const last = journal.append(
      { ...note, text: "Native workaround succeeded" },
      "call-3",
    );
    const page = journal.read("root-a", 0, 1);
    expect(page.entries).toEqual([first]);
    expect(page.truncated).toBe(true);
    expect(journal.read("root-a", page.nextAfter, 20).entries).toEqual([last]);
    expect(journal.window("root-a", 0, null, "reporter", 8).at(-1)).toEqual(
      last,
    );
    journal.append(note, "token=raw-key-secret");
    expect(
      JSON.stringify(db.query("SELECT * FROM journal").all()),
    ).not.toContain("raw-key-secret");
  } finally {
    db.close();
  }
});
