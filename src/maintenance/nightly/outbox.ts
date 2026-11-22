import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import { maintenanceDirectory, noticeSchema } from "./report";

/**
 * Gateway-side delivery of maintenance summaries through the configured
 * bot's normal Slack client. A notice is claimed by rename before the post;
 * a crash or uncertain post is never repeated. Never throws: a delivery
 * problem must not stop the gateway.
 */
export class MaintenanceOutbox {
  constructor(
    private readonly dataDirectory: string,
    private readonly channelAllowed: (channel: string) => boolean,
    private readonly announce: (
      channel: string,
      text: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly log: Pick<Logger, "warn">,
  ) {}

  async deliver(signal: AbortSignal) {
    const directory = join(maintenanceDirectory(this.dataDirectory), "outbox");
    let names: string[];
    try {
      names = (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch {
      return 0;
    }
    let sent = 0;
    for (const name of names) {
      if (signal.aborted) break;
      const path = join(directory, name);
      const claimed = `${path}.claimed`;
      try {
        await rename(path, claimed);
      } catch {
        continue;
      }
      let status = "failed";
      try {
        const notice = noticeSchema.parse(
          JSON.parse(await readFile(claimed, "utf8")),
        );
        if (this.channelAllowed(notice.channel)) {
          await this.announce(notice.channel, notice.text, signal);
          status = "sent";
          sent++;
        } else status = "refused";
      } catch {
        this.log.warn("Maintenance summary delivery uncertain; not repeated");
      }
      await rename(claimed, `${path}.${status}`).catch(() => {});
    }
    return sent;
  }

  async work(signal: AbortSignal) {
    while (!signal.aborted) {
      await this.deliver(signal);
      await delay(30_000, undefined, { signal }).catch(() => {});
    }
  }
}
