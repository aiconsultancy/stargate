import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { JournalStore } from "../src/crew/journal";

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
