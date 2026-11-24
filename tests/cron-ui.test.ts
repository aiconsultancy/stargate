import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViewsOpenArguments } from "@slack/web-api";
import pino from "pino";
import { CronStore } from "../src/automation/cron/store";
import { CronUI, type SlackAck } from "../src/automation/cron/ui";
import { botKey } from "../src/gateway/routing";
import { bot, identity } from "./fixtures";

type View = Extract<ViewsOpenArguments["view"], { type: "modal" }>;

const stores: CronStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const input = {
  name: "Daily task",
  expression: "0 9 * * *",
  timezone: "UTC",
  prompt: "Check the build",
};

function fixture() {
  const config = bot();
  const store = new CronStore(":memory:");
  stores.push(store);

  const scope = {
    botKey: botKey(config, identity),
    channel: "C123",
    user: "U123",
  };

  const calls: { kind: string; view: View; id: string; hash?: string }[] = [];
  const acks: (Record<string, unknown> | undefined)[] = [];
  const order: string[] = [];
  const logs: string[] = [];

  const api = {
    async open(id: string, view: View) {
      order.push("open");
      calls.push({ kind: "open", id, view });
    },
    async push(id: string, view: View) {
      order.push("push");
      calls.push({ kind: "push", id, view });
    },
    async update(id: string, hash: string, view: View) {
      order.push("update");
      calls.push({ kind: "update", id, hash, view });
    },
  };

  const log = pino(
    { level: "error" },
    {
      write(text) {
        logs.push(text);
      },
    },
  );

  const ui = new CronUI(config, identity, store, api, log);

  const ack: SlackAck = async (payload) => {
    order.push("ack");
    acks.push(payload);
  };

  return { config, store, scope, calls, acks, order, logs, api, ui, ack };
}

function command(text = "") {
  return {
    command: "/cron",
    api_app_id: "A123",
    team_id: "T123",
    user_id: "U123",
    channel_id: "C123",
    trigger_id: "trigger",
    text,
  };
}

function action(view: View, actionId: string, value = "") {
  return {
    type: "block_actions",
    api_app_id: "A123",
    team: { id: "T123" },
    user: { id: "U123" },
    trigger_id: "trigger-action",
    view: { ...view, id: "V123", hash: "hash-1" },
    actions: [{ type: "button", action_id: actionId, value }],
  };
}

function submission(view: View, values = input) {
  return {
    type: "view_submission",
    api_app_id: "A123",
    team: { id: "T123" },
    user: { id: "U123" },
    view: {
      ...view,
      id: "VADD",
      hash: "hash-add",
      state: {
        values: Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            { value: { type: "plain_text_input", value } },
          ]),
        ),
      },
    },
  };
}

test("slash list is private, scoped, paginated, and ACK precedes API", async () => {
  const f = fixture();

  for (let n = 0; n < 11; n++) {
    f.store.add(f.scope, { ...input, name: `Task ${n}` });
  }

  f.store.add(
    { ...f.scope, user: "UOTHER" },
    { ...input, name: "Other owner" },
  );
  f.store.add(
    { ...f.scope, channel: "D123" },
    { ...input, name: "Other channel" },
  );
  f.store.add({ ...f.scope, botKey: "other" }, { ...input, name: "Other bot" });
  await f.ui.command(command(), f.ack);
  expect(f.order).toEqual(["ack", "open"]);
  const view = f.calls[0]?.view;
  expect(view).toBeDefined();

  if (!view) {
    throw new Error("missing view");
  }

  expect(JSON.stringify(view)).not.toContain("Other owner");
  expect(JSON.stringify(view)).not.toContain("Other channel");
  expect(JSON.stringify(view)).not.toContain("Other bot");
  expect(view.blocks.filter((b) => "accessory" in b)).toHaveLength(10);
  await f.ui.interactive(action(view, "cron_next"), f.ack);
  expect(f.calls.at(-1)).toMatchObject({
    kind: "update",
    id: "V123",
    hash: "hash-1",
  });
  expect(
    f.calls.at(-1)?.view.blocks.filter((b) => "accessory" in b),
  ).toHaveLength(1);
});

test("Add opens form with UTC and saves before ACK; retry stays idempotent", async () => {
  const f = fixture();
  await f.ui.command(command("add"), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  expect(JSON.stringify(view)).toContain('"initial_value":"UTC"');
  expect(JSON.stringify(view)).toContain("authorizes recurring execution");
  expect(view.submit?.text).toBe("Add");
  const body = submission(view);
  const savedAtAck: number[] = [];

  const ack: SlackAck = async (payload) => {
    savedAtAck.push(f.store.list(f.scope).length);
    await f.ack(payload);
  };

  await f.ui.interactive(body, ack);
  await f.ui.interactive(body, ack);
  expect(savedAtAck).toEqual([1, 1]);
  expect(f.acks.at(-1)).toMatchObject({ response_action: "clear" });
});

test("list Add pushes form, and saving clears the modal stack", async () => {
  const f = fixture();
  await f.ui.command(command("list"), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  await f.ui.interactive(action(view, "cron_add"), f.ack);
  expect(f.calls.at(-1)).toMatchObject({ kind: "push", id: "trigger-action" });
  expect(f.calls.at(-1)?.view.submit?.text).toBe("Add");
});

test("invalid form returns field errors and does not save", async () => {
  const f = fixture();
  await f.ui.command(command("add"), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  for (const values of [
    { ...input, expression: "* * * * * *" },
    { ...input, timezone: "Not/AZone" },
    { ...input, name: " " },
    { ...input, prompt: " " },
  ]) {
    await f.ui.interactive(submission(view, values), f.ack);
    expect(f.acks.at(-1)).toMatchObject({ response_action: "errors" });
  }

  expect(f.store.list(f.scope)).toEqual([]);
});

test("remove confirms, checks ownership, and refreshes list with hash", async () => {
  const f = fixture();
  const job = f.store.add(f.scope, input);
  const other = f.store.add({ ...f.scope, user: "UOTHER" }, input);
  await f.ui.command(command("remove"), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  expect(JSON.stringify(view)).toContain('"confirm"');
  await f.ui.interactive(action(view, "cron_remove", other.id), f.ack);
  expect(f.store.list({ ...f.scope, user: "UOTHER" })).toHaveLength(1);
  expect(f.store.list(f.scope)).toHaveLength(1);
  await f.ui.interactive(action(view, "cron_remove", job.id), f.ack);
  expect(f.store.list(f.scope)).toEqual([]);
  expect(f.calls.at(-1)).toMatchObject({ kind: "update", hash: "hash-1" });
});

test("unknown slash subcommands return private usage without API calls", async () => {
  const f = fixture();
  await f.ui.command(command("delete everything"), f.ack);
  expect(f.calls).toEqual([]);
  expect(f.acks).toEqual([
    {
      response_type: "ephemeral",
      text: "Use /cron, /cron list, /cron add, /cron remove, or /cron run NAME_OR_ID.",
    },
  ]);
});

test("commands reject cross-registration, denied users/channels, bots, malformed payloads", async () => {
  const f = fixture();
  f.config.access.users = ["*"];
  f.config.access.channels = ["*"];
  f.config.access.deniedUsers = ["UDENIED"];
  f.config.access.deniedChannels = ["CDENIED"];

  for (const body of [
    { ...command(), api_app_id: "AOTHER" },
    { ...command(), team_id: "TOTHER" },
    { ...command(), user_id: "UDENIED" },
    { ...command(), channel_id: "CDENIED" },
    { ...command(), user_id: "UBOT" },
    { ...command(), user_id: "B123" },
    { ...command(), bot_id: "B123" },
    null,
  ]) {
    await f.ui.command(body, f.ack);
  }

  expect(f.calls).toEqual([]);
  expect(f.acks).toHaveLength(8);
});

test("actions and submissions recheck identity, metadata scope, and current ACL", async () => {
  const f = fixture();
  await f.ui.command(command("add"), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  const submit = submission(view);
  const baseAction = action({ ...view, callback_id: "cron_list" }, "cron_add");

  for (const raw of [submit, baseAction]) {
    await f.ui.interactive({ ...raw, user: { id: "UOTHER" } }, f.ack);
    await f.ui.interactive(
      { ...raw, user: { id: "U123", is_bot: true } },
      f.ack,
    );
    await f.ui.interactive({ ...raw, team: { id: "TOTHER" } }, f.ack);
    await f.ui.interactive({ ...raw, api_app_id: "AOTHER" }, f.ack);
    await f.ui.interactive(
      { ...raw, view: { ...raw.view, private_metadata: "{}" } },
      f.ack,
    );
    f.config.access.deniedChannels = ["C123"];
    await f.ui.interactive(raw, f.ack);
    f.config.access.deniedChannels = [];
    f.config.access.deniedUsers = ["U123"];
    await f.ui.interactive(raw, f.ack);
    f.config.access.deniedUsers = [];
  }

  expect(f.store.list(f.scope)).toEqual([]);
  expect(f.calls).toHaveLength(1);
});

test("API and ACK failures never double ACK or expose raw errors", async () => {
  const f = fixture();
  f.api.open = async () => {
    throw new Error("secret prompt/token");
  };

  await f.ui.command(command(), f.ack);
  expect(f.acks).toHaveLength(1);
  let attempts = 0;
  await f.ui.command(command(), async () => {
    attempts++;
    throw new Error("ACK failed");
  });
  expect(attempts).toBe(1);
  expect(f.logs.join("")).not.toContain("secret prompt/token");
});

test("storage failure returns a safe form error without success ACK", async () => {
  const f = fixture();
  await f.ui.command(command("add"), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  f.store.add = () => {
    throw new Error("private payload in SQLite error");
  };

  await f.ui.interactive(submission(view), f.ack);
  expect(f.acks.at(-1)).toMatchObject({ response_action: "errors" });
  expect(f.store.list(f.scope)).toEqual([]);
  expect(f.logs.join("")).not.toContain("private payload");
});

test("remove persists before ambiguous ACK failure and retries idempotently", async () => {
  const f = fixture();
  const job = f.store.add(f.scope, input);
  await f.ui.command(command(), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  const body = action(view, "cron_remove", job.id);
  const enabledAtAck: boolean[] = [];
  let attempts = 0;
  await f.ui.interactive(body, async (payload) => {
    attempts++;
    enabledAtAck.push(f.store.enabled(job.id));
    await f.ack(payload);
    throw new Error("ACK outcome unknown");
  });
  expect(enabledAtAck).toEqual([false]);
  expect(f.store.enabled(job.id)).toBe(false);
  expect(attempts).toBe(1);
  expect(f.calls).toHaveLength(1);
  await f.ui.interactive(body, async (payload) => {
    enabledAtAck.push(f.store.enabled(job.id));
    await f.ack(payload);
  });
  expect(enabledAtAck).toEqual([false, false]);
  expect(f.store.list(f.scope)).toEqual([]);
  expect(f.calls.at(-1)).toMatchObject({ kind: "update", hash: "hash-1" });
});

test("ACL revocation during ACK does not undo durable removal", async () => {
  const f = fixture();
  const job = f.store.add(f.scope, input);
  await f.ui.command(command(), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  await f.ui.interactive(action(view, "cron_remove", job.id), async () => {
    f.config.access.deniedUsers = ["U123"];
  });
  expect(f.store.list(f.scope)).toEqual([]);
  expect(f.calls).toHaveLength(1);
});

test("manual run commits before ACK, deduplicates retries, and stays owner scoped", async () => {
  const f = fixture();
  f.store.add(f.scope, input);

  const other = f.store.add(
    { ...f.scope, user: "UOTHER" },
    { ...input, name: "private" },
  );

  let commits = 0;
  const runNow = f.store.runNow.bind(f.store);
  f.store.runNow = (...args) => {
    const result = runNow(...args);

    if (result) {
      commits++;
    }

    return result;
  };

  const body = command(`run ${input.name}`);
  await f.ui.command(body, async (payload) => {
    expect(commits).toBe(1);
    await f.ack(payload);
    throw new Error("lost ACK");
  });
  expect(f.acks.at(-1)?.["text"]).toContain("queued");
  await f.ui.command(body, f.ack);
  expect(commits).toBe(1);
  expect(f.acks.at(-1)?.["text"]).toContain("busy");
  await f.ui.command(command(`run ${other.id}`), f.ack);
  expect(commits).toBe(1);
  expect(f.calls).toEqual([]);
});

test("report selector stores daily mode; missing selector retains immediate", async () => {
  const f = fixture();
  await f.ui.command(command("add"), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  expect(JSON.stringify(view)).toContain("local storage");
  expect(JSON.stringify(view)).toContain(
    '"initial_option":{"text":{"type":"plain_text","text":"Immediate"',
  );
  const body = submission(view);
  Object.assign(body.view.state.values, {
    report: {
      value: {
        type: "static_select",
        selected_option: { value: "daily" },
      },
    },
  });
  await f.ui.interactive(body, f.ack);
  expect(f.store.list(f.scope)[0]?.report).toBe("daily");
  const legacy = submission(view, { ...input, name: "Legacy" });
  legacy.view.id = "VLEGACY";
  await f.ui.interactive(legacy, f.ack);
  expect(
    f.store.list(f.scope).find((job) => job.name === "Legacy")?.report,
  ).toBe("immediate");
});

test("configured Add writes a definition, validates names, and retries safely", async () => {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "stargate-cron-ui-"));
  directories.push(directory);
  f.config.cronjobs = {
    directory,
    channel: "C123",
    user: "U123",
    dailyReport: { time: "08:30", timezone: "UTC" },
  };
  await f.ui.command(command("add"), f.ack);
  const view = f.calls[0]?.view;

  if (!view) {
    throw new Error("missing view");
  }

  expect(JSON.stringify(view)).toContain("08:30 UTC");
  await f.ui.interactive(submission(view), f.ack);
  expect(f.acks.at(-1)).toMatchObject({
    response_action: "errors",
    errors: { name: expect.stringContaining("kebab-case") },
  });
  const body = submission(view, { ...input, name: "daily-task" });
  await f.ui.interactive(body, f.ack);
  await f.ui.interactive(body, f.ack);
  expect(f.acks.at(-1)).toMatchObject({ response_action: "clear" });
  expect(
    await Bun.file(join(directory, "daily-task", "CRONJOB.md")).text(),
  ).toContain("Check the build");
  expect(f.store.list(f.scope)).toHaveLength(1);
});
