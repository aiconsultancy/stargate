import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { configSchema } from "../src/config";
import {
  buildUpdateSnapshot,
  noticeTools,
  UpdateNotices,
} from "../src/update-notice";
import { bot } from "./fixtures";

const config = {
  notifications: { updateNotice: true },
  maintenance: { models: { updateGlobalCatalog: false } },
  bots: [
    {
      id: "captain",
      access: { users: ["private-user"] },
      backend: {
        model: { id: "gpt-6.1-sol", providerID: "proxy" },
        headersEnv: { authorization: "SECRET_ENV" },
      },
    },
  ],
};
const snapshot = (version = "0.37.0", extra = {}) =>
  buildUpdateSnapshot(
    version,
    { ...config, ...extra },
    "## Unreleased\n- Add update notices (default off).\n- token=super-secret\n",
  );

test("version changes queue once per session; an unchanged restart sends nothing", async () => {
  const db = new Database(":memory:");
  try {
    let state = new UpdateNotices(db);
    const sent: string[] = [];
    const queue = async (id: string, text: string) => {
      sent.push(`${id}:${text}`);
    };
    for (const session of ["ses_captain", "ses_crew"])
      await state.deliver(session, snapshot("0.36.0"), "queued", queue);
    state = new UpdateNotices(db);
    for (const session of ["ses_captain", "ses_crew"])
      await state.deliver(session, snapshot("0.37.0"), "queued", queue);
    for (const session of ["ses_captain", "ses_crew"])
      await state.deliver(session, snapshot("0.37.0"), "queued", queue);
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)).toContain("0.36.0 → 0.37.0");
  } finally {
    db.close();
  }
});

test("configuration changes alone queue one notice, containing no secrets or private permission values", async () => {
  const db = new Database(":memory:");
  try {
    const state = new UpdateNotices(db);
    const texts: string[] = [];
    const queue = async (_id: string, text: string) => {
      texts.push(text);
    };
    await state.deliver("ses_captain", snapshot(), "queued", queue);
    await state.deliver(
      "ses_captain",
      snapshot("0.37.0", {
        maintenance: { models: { updateGlobalCatalog: true } },
      }),
      "queued",
      queue,
    );
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("maintenance.models.updateGlobalCatalog: on");
    expect(texts[1]).toContain(
      "https://github.com/aiconsultancy/stargate/releases/tag/v0.37.0",
    );
    for (const secret of ["private-user", "SECRET_ENV", "super-secret"])
      expect(texts.join("\n")).not.toContain(secret);
  } finally {
    db.close();
  }
});

test("uncertain admission is not replayed; concurrent ready/turn checks do not duplicate it", async () => {
  const db = new Database(":memory:");
  try {
    const state = new UpdateNotices(db);
    let count = 0;
    const queue = async () => {
      count++;
      throw new Error("receipt lost");
    };
    const results = await Promise.all([
      state.deliver("ses_busy", snapshot(), "queued", queue),
      state.deliver("ses_busy", snapshot(), "queued", queue),
    ]);
    expect(results.some((r) => r.status === "uncertain")).toBe(true);
    await state.deliver("ses_busy", snapshot(), "queued", queue);
    expect(count).toBe(1);
  } finally {
    db.close();
  }
});

test("tool diff contains only names; descriptions, schemas and permission resources are not notice content", async () => {
  const db = new Database(":memory:");
  try {
    const state = new UpdateNotices(db);
    const texts: string[] = [];
    const queue = async (_id: string, text: string) => {
      texts.push(text);
    };
    await state.deliver(
      "ses_captain",
      {
        ...snapshot(),
        tools: noticeTools([{ id: "stargate_crew", description: "before" }]),
      },
      "queued",
      queue,
    );
    await state.deliver(
      "ses_captain",
      {
        ...snapshot(),
        tools: noticeTools([
          { id: "stargate_crew", description: "secret-description" },
          { id: "stargate_model", description: "hidden" },
        ]),
      },
      "queued",
      queue,
    );
    expect(texts[1]).toContain("Changed tools: stargate_crew");
    expect(texts[1]).toContain("New tools: stargate_model");
    expect(texts[1]).not.toContain("secret-description");
  } finally {
    db.close();
  }
});

test("notifications.updateNotice is off by default", () => {
  const parsed = Schema.decodeUnknownSync(configSchema)({ bots: [bot()] });
  expect(parsed.notifications.updateNotice).toBe(false);
});

test("version-range summaries exclude earlier release notes and uncertain sends do not advance the told baseline", async () => {
  const db = new Database(":memory:");
  try {
    const state = new UpdateNotices(db);
    const texts: string[] = [];
    await state.deliver(
      "ses_captain",
      snapshot("0.36.0"),
      "queued",
      async () => {},
    );
    await state.deliver(
      "ses_captain",
      snapshot("0.37.0"),
      "queued",
      async () => {
        throw new Error("unknown admission");
      },
    );
    const next = buildUpdateSnapshot(
      "0.38.0",
      config,
      "## Unreleased\n- Current feature\n## 0.37.0\n- Missed feature\n## 0.36.0\n- Old feature\n",
    );
    await state.deliver("ses_captain", next, "queued", async (_id, text) => {
      texts.push(text);
    });
    expect(texts[0]).toContain("0.36.0 → 0.38.0");
    expect(texts[0]).toContain("Missed feature");
    expect(texts[0]).not.toContain("Old feature");
  } finally {
    db.close();
  }
});

test("tool ordering and unknown tool reads do not turn unchanged restarts into extra notices", async () => {
  const db = new Database(":memory:");
  try {
    const state = new UpdateNotices(db);
    let count = 0;
    const queue = async () => {
      count++;
    };
    const tools = [
      { id: "stargate_model", description: "Models" },
      { id: "stargate_crew", description: "Crew" },
    ];
    await state.deliver(
      "ses_captain",
      { ...snapshot(), tools: noticeTools(tools) },
      "queued",
      queue,
    );
    await state.deliver(
      "ses_captain",
      { ...snapshot(), tools: noticeTools([...tools].reverse()) },
      "queued",
      queue,
    );
    await state.deliver("ses_captain", snapshot(), "queued", queue);
    expect(count).toBe(1);
  } finally {
    db.close();
  }
});
