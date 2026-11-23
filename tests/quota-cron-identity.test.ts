import { Schema } from "effect";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/automation/cron/store";
import {
  QuotaReader,
  quotaObservationSchema,
  quotaSnapshotSchema,
} from "../src/quota/quota";

test("cron identities survive credential reordering, disabling, removal and restart without leaking into public quota", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-quota-identity-"));
  const managementKeyFile = join(directory, "management.key");
  await writeFile(managementKeyFile, "fixture-management-key", { mode: 0o600 });
  const now = Date.parse("2026-01-01T00:00:00Z");
  let clock = now;
  let firstReset = now + 600_000;

  const first = {
    provider: "codex",
    auth_index: "a".repeat(16),
    email: "first@example.com",
    account_id: "private-first-account",
  };

  const second = {
    provider: "codex",
    auth_index: "b".repeat(16),
    email: "second@example.com",
    account_id: "private-second-account",
  };

  let files: (typeof first & { disabled?: boolean })[] = [first, second];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v8/management/credentials")
        return Response.json({ files });
      const body = await request.json();

      return Response.json({
        status_code: 200,
        body: {
          rate_limit: {
            primary_window: {
              used_percent: 90,
              reset_at:
                (body.auth_index === first.auth_index
                  ? firstReset
                  : now + 900_000) / 1000,
              limit_window_seconds: 18_000,
            },
          },
        },
      });
    },
  });

  const reader = () =>
    new QuotaReader(
      { baseURL: server.url.origin, managementKeyFile },
      () => clock,
      ["codex"],
    );

  const signal = new AbortController().signal;
  const path = join(directory, "cron.sqlite");
  let store = new CronStore(path);
  const owner = { botKey: "bot", channel: "C123", user: "U123" };

  try {
    const definition = {
      name: "Quota",
      expression: "",
      timezone: "UTC",
      prompt: "Check work.",
    };

    store.add(
      owner,
      {
        ...definition,
        trigger: {
          type: "quota-threshold",
          provider: "codex",
          usedPercent: 80,
        },
      },
      now,
    );
    store.add(
      owner,
      {
        ...definition,
        trigger: { type: "quota-reset", provider: "codex" },
      },
      now,
    );
    const initialReader = reader();

    // Exercise the private JSON transport used by the cron RPC.
    const initial = Schema.decodeUnknownSync(quotaObservationSchema)(
      JSON.parse(JSON.stringify(await initialReader.readForCron(signal))),
    );

    const firstIdentity = initial.accounts[0]?.identity;
    const secondIdentity = initial.accounts[1]?.identity;
    expect(firstIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(secondIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstIdentity).not.toBe(secondIdentity);
    expect(await initialReader.readForCron(signal)).toEqual({
      ...initial,
      cached: true,
    });
    const publicSnapshot = await initialReader.read(signal);
    expect(
      Schema.decodeUnknownSync(quotaSnapshotSchema)(publicSnapshot),
    ).toEqual(publicSnapshot);
    expect(JSON.stringify(publicSnapshot)).not.toMatch(
      /identity|sha256|example|private|fixture|aaaaaaaa|bbbbbbbb/,
    );
    const admitted = store.claimQuota(owner.botKey, initial, clock);
    expect(admitted).toHaveLength(1);

    for (const run of admitted) store.finish(run.id, "done", clock);

    files = [second, first];
    clock += 61_000;
    const reordered = await initialReader.readForCron(signal);
    expect(reordered.accounts.map(({ identity }) => identity)).toEqual([
      secondIdentity,
      firstIdentity,
    ]);
    expect(store.claimQuota(owner.botKey, reordered, clock)).toEqual([]);

    store.close();
    store = new CronStore(path);
    files = [{ ...first, disabled: true }, second];
    clock += 61_000;
    const disabled = await reader().readForCron(signal);
    expect(disabled.accounts[0]).toMatchObject({
      account: "codex-1",
      identity: secondIdentity,
    });
    expect(store.claimQuota(owner.botKey, disabled, clock)).toEqual([]);

    files = [second];
    clock += 61_000;
    expect(
      store.claimQuota(owner.botKey, await reader().readForCron(signal), clock),
    ).toEqual([]);

    files = [first];
    clock += 61_000;
    expect(
      store.claimQuota(owner.botKey, await reader().readForCron(signal), clock),
    ).toEqual([]);
    // The previous deadline has elapsed and the next cycle moves over an hour.
    firstReset = now + 18_600_000;
    clock = now + 600_000;

    const advanced = store.claimQuota(
      owner.botKey,
      await reader().readForCron(signal),
      clock,
    );

    expect(advanced).toHaveLength(2);
    expect(advanced.map((run) => run.quotaEvent?.type).sort()).toEqual([
      "quota-reset",
      "quota-threshold",
    ]);

    for (const run of advanced) {
      expect(run.quotaEvent).toMatchObject({
        account: "codex-1",
        previousResetAt: now + 600_000,
        resetAt: firstReset,
      });
      expect(JSON.stringify(run)).not.toMatch(
        /identity|sha256|example|private|fixture|aaaaaaaa|bbbbbbbb/,
      );
    }

    store.close();
    store = new CronStore(path);
    expect(
      store.pending(owner.botKey).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(advanced.toSorted((a, b) => a.id.localeCompare(b.id)));
  } finally {
    store.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
