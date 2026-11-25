import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import { atomicWrite } from "../../automation/maintenance/nightly/files";
import { type GuardState, type QuotaReader, readUsageGuard } from "./quota";
import { type UsageGuardConfig, quotaReading } from "./quota-watch";

type Receipt = GuardState[string];

type Target = { account: string; channel: string };

type Prepare = (
  target: Target,
  message: string,
  signal: AbortSignal,
) => Promise<() => Promise<void | "retry">>;

const defaults = {
  warn: "Stand down extra crew of this kind. Run at most one per ship. Checkpoint and push active work at a safe point.",
  pause:
    "New starts and resumptions are paused. Have active crew finish or checkpoint and push, then stand down. Keep task claims.",
  recover: "Usage is back. Resume saved crew work when ready.",
  reopen:
    "Crew starts and resumptions are available again. Keep at most one crew worker of this kind per ship while quota is low.",
};

export class UsageGuard {
  private readonly messages = new Map<string, string>();

  public constructor(
    private readonly config: UsageGuardConfig & { stateFile: string },
    private readonly reader: Pick<QuotaReader, "read">,
    private readonly targets: readonly Target[],
    private readonly prepare: Prepare,
    private readonly log: Pick<Logger, "warn">,
    private readonly now = Date.now,
  ) {}

  private async save(state: GuardState) {
    await atomicWrite(
      this.config.stateFile,
      JSON.stringify(state) + "\n",
      0o644,
    );
  }

  private warn(key: string, message: string, fields: Record<string, string>) {
    if (this.messages.get(key) !== message) {
      this.messages.set(key, message);
      this.log.warn(fields, message);
    }
  }

  public async tick(signal: AbortSignal) {
    const snapshot = await this.reader.read(signal);
    const now = this.now();
    const before = await readUsageGuard(this.config.stateFile);
    const after: Record<string, Receipt> = {};
    const observed = new Set<string>();

    for (const [provider, settings] of Object.entries(this.config.providers)) {
      const previous = Object.hasOwn(before, provider)
        ? before[provider]
        : undefined;

      const reading = await quotaReading(
        snapshot,
        provider,
        this.config.nativeCodexFile,
        now,
      );

      if (reading.status !== "ok") {
        this.warn(
          provider,
          reading.status === "stale"
            ? "Usage guard quota reading is stale; retaining last verified policy"
            : "Usage guard quota reading unavailable; retaining last verified policy",
          { provider },
        );

        if (previous) {
          after[provider] = {
            ...previous,
            modelPrefixes: settings.modelPrefixes,
          };
        }

        continue;
      }

      if (previous && reading.value.observedAt < previous.observedAt) {
        after[provider] = {
          ...previous,
          modelPrefixes: settings.modelPrefixes,
        };
        this.warn(
          provider,
          "Usage guard received an older quota reading; retaining last verified policy",
          { provider },
        );
        continue;
      }

      this.messages.delete(provider);
      const current = reading.value;

      const limit = settings.limits
        .filter(
          ({ remainingPercent }) =>
            current.remainingPercent <= remainingPercent,
        )
        .toSorted((a, b) => a.remainingPercent - b.remainingPercent)[0];

      const mode = limit?.action ?? "normal";

      const reset =
        previous?.resetAt !== undefined &&
        previous.resetAt !== null &&
        current.observedAt >= previous.resetAt &&
        current.resetAt !== previous.resetAt;

      let notice = previous?.notice ?? null;
      let attempted = previous?.attempted ?? [];

      if (mode !== previous?.mode || reset) {
        notice =
          mode === "normal"
            ? previous && previous.mode !== "normal"
              ? "recover"
              : null
            : mode === "warn" && previous?.mode === "pause"
              ? "reopen"
              : mode;
        attempted = [];
      }

      after[provider] = {
        ...current,
        modelPrefixes: settings.modelPrefixes,
        mode,
        notice,
        attempted,
      };
      observed.add(provider);
    }

    signal.throwIfAborted();
    const directory = resolve(dirname(this.config.stateFile));
    const created = await mkdir(directory, { recursive: true, mode: 0o755 });

    if (created) {
      for (let path = directory; ; path = dirname(path)) {
        await chmod(path, 0o755);

        if (path === created) {
          break;
        }
      }
    } else if (!((await stat(directory)).mode & 0o001)) {
      this.warn(
        "permissions",
        "Usage guard state directory must be traversable by crew engine users",
        { directory },
      );
    }

    const mode = (
      await stat(this.config.stateFile).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }

          return;
        },
      )
    )?.mode;

    // Publish all cutoffs before touching IRC. Simultaneous crossings cannot
    // Wait on an offline captain before taking effect.
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      (mode !== undefined && (mode & 0o777) !== 0o644)
    ) {
      await this.save(after);
    }

    for (const provider of observed) {
      const receipt = after[provider];

      if (receipt?.notice) {
        await this.notify(provider, receipt, after, signal);
      }
    }
  }

  private async notify(
    provider: string,
    receipt: Receipt,
    state: GuardState,
    signal: AbortSignal,
  ) {
    if (!receipt.notice) {
      return;
    }

    const action = receipt.notice;
    const settings = this.config.providers[provider];

    const custom =
      action === "recover"
        ? this.config.recoveryMessage
        : settings?.limits.find((limit) => limit.action === action)?.message;

    const remaining = Number(receipt.remainingPercent.toFixed(2));

    const reset =
      receipt.resetAt === null
        ? "reset unknown"
        : `resets ${new Date(receipt.resetAt).toISOString()}`;

    const name = { claude: "Claude", codex: "Codex" } as Record<string, string>;

    const message = `Usage guard: ${Object.hasOwn(name, provider) ? name[provider] : provider} ${remaining}% remaining (${reset}). ${custom ?? defaults[action]}`;

    for (const target of this.targets) {
      signal.throwIfAborted();
      const account = target.account.toLowerCase();
      const key = `${provider}:${account}`;

      if (receipt.attempted.includes(account)) {
        continue;
      }

      const fields = {
        provider,
        captain: target.account,
        channel: target.channel,
      };

      let send: () => Promise<void | "retry">;

      try {
        send = await this.prepare(target, message, signal);
      } catch {
        signal.throwIfAborted();
        this.warn(
          key,
          "Usage guard captain or ship channel unavailable; will retry",
          fields,
        );
        continue;
      }

      signal.throwIfAborted();
      this.messages.delete(key);
      receipt.attempted = [...receipt.attempted, account];
      await this.save(state);

      try {
        if ((await send()) === "retry") {
          receipt.attempted = receipt.attempted.filter(
            (item) => item !== account,
          );
          await this.save(state);
          this.warn(key, "Usage guard notice was not sent; will retry", fields);
        }
      } catch {
        this.log.warn(
          fields,
          "Usage guard delivery uncertain; attempt will not be repeated",
        );
      }
    }
  }

  public async work(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
        this.messages.delete("poll");
      } catch {
        if (!signal.aborted) {
          this.warn(
            "poll",
            "Usage guard could not update its quota policy",
            {},
          );
        }
      }

      await delay(60_000, undefined, { signal }).catch(() => {});
    }
  }
}
