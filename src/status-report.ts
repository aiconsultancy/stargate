import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import type { BotConfig } from "./config";
import { CrewReporting } from "./crew/report-rpc";
import { crewStatusSchema } from "./crew-status";
import { backendFailureKinds } from "./request-failure";
import { readConfiguration } from "./setup";

const maxLogBytes = 2 * 1024 * 1024;
const windowMs = 24 * 60 * 60 * 1000;
const sessionSchema = z.object({
  id: z.string(),
  parentID: z.string().optional(),
  fork: z.unknown().optional(),
  agent: z.string().optional(),
  location: z.object({ directory: z.string() }),
});
type Check = { state: "available" | "failed" | "unknown"; reason: string };
const unknown = (reason: string): Check => ({ state: "unknown", reason });
const available = (reason: string): Check => ({ state: "available", reason });
async function check(
  work: (signal: AbortSignal) => Promise<boolean>,
): Promise<Check> {
  try {
    return (await work(AbortSignal.timeout(5000)))
      ? available("read succeeded")
      : { state: "failed", reason: "incompatible response" };
  } catch {
    return unknown("read failed or timed out");
  }
}

async function capabilities(bot: BotConfig, env: NodeJS.ProcessEnv) {
  const checks = {
    backendRead: unknown("unsupported backend"),
    backendWait: unknown("not tested; no work submitted"),
    pinnedSession: unknown("not configured or unsupported"),
    crewReporting: unknown("unsupported backend"),
    delivery: unknown("delivery not tested; inspect incident evidence"),
    failureReporting: unknown("inspect incident evidence"),
  };
  if (bot.backend.type !== "opencode") return checks;
  const config = bot.backend;
  const headers: Record<string, string> = {};
  for (const [header, name] of Object.entries(config.headersEnv)) {
    const value = env[name];
    if (!value?.trim()) {
      checks.backendRead = unknown("backend credentials unavailable");
      checks.crewReporting = unknown("backend credentials unavailable");
      return checks;
    }
    headers[header] = value;
  }
  const client = OpenCode.make({
    baseUrl: config.url,
    headers,
    fetch: Object.assign(
      (url: URL | RequestInfo, init?: RequestInit) =>
        fetch(url, { ...init, redirect: "error" }),
      { preconnect: fetch.preconnect },
    ),
  });
  checks.backendRead = await check(async (signal) => {
    await client.server.info({ signal });
    return true;
  });
  if (checks.backendRead.state === "available")
    checks.backendRead.reason =
      "server metadata read succeeded; request execution not tested";
  if (config.sessionID)
    checks.pinnedSession = await check(async (signal) => {
      const session = sessionSchema.parse(
        await client.session.get(
          { sessionID: config.sessionID ?? "" },
          { signal },
        ),
      );
      return (
        session.id === config.sessionID &&
        session.parentID === undefined &&
        session.fork === undefined &&
        session.location.directory === config.directory &&
        (config.agent === undefined || session.agent === config.agent)
      );
    });
  // Do not initialize a location for a status request.
  checks.crewReporting = await check(async (signal) => {
    const locations = await client.debug.location.list({ signal });
    if (!locations.some((location) => location.directory === config.directory))
      throw new Error();
    crewStatusSchema.parse(
      await client
        .rpc(CrewReporting)
        .status({}, { location: { directory: config.directory }, signal }),
    );
    return true;
  });
  return checks;
}

type Incident = {
  category: string;
  capability: string;
  scope: string;
  count: number;
  first: string;
  last: string;
  impact: string;
  state: "unknown";
  ticket: null;
  jobs: number[];
};
const categories: Record<
  string,
  { category: string; capability: string; impact: string }
> = {
  "Agent request failed or timed out": {
    category: "agent-failure",
    capability: "backend",
    impact: "agent request failed or timed out",
  },
  "Slack delivery failed": {
    category: "delivery-failure",
    capability: "delivery",
    impact: "reply delivery failed or is unconfirmed",
  },
  "Transcript catch-up failed; retrying with backoff": {
    category: "transcript-failure",
    capability: "transcript",
    impact: "transcript catch-up failed",
  },
  "Transcript read failed; reply deferred": {
    category: "transcript-failure",
    capability: "transcript",
    impact: "reply deferred",
  },
  "Job transition refused; nothing was written": {
    category: "transition-refused",
    capability: "queue",
    impact: "job transition refused",
  },
};
const failures = new Set<string>([
  ...backendFailureKinds,
  "backend",
  "cancelled",
  "context",
  "attachments",
  "transcription",
  "interrupted",
  "reaction",
  "history",
]);

export function summarizeLog(
  text: string,
  bot: string,
  now: number,
  truncated: boolean,
) {
  const groups = new Map<string, Incident>();
  let malformed = 0;
  let earliest = Infinity;
  let ambiguous = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      malformed++;
      continue;
    }
    const record = value as Record<string, unknown>;
    const time =
      typeof record["time"] === "number"
        ? record["time"]
        : typeof record["time"] === "string"
          ? Date.parse(record["time"])
          : NaN;
    if (!Number.isFinite(time)) {
      malformed++;
      continue;
    }
    earliest = Math.min(earliest, time);
    if (time < now - windowMs || time > now) continue;
    const message = record["msg"];
    const category =
      typeof message === "string" && Object.hasOwn(categories, message)
        ? categories[message]
        : undefined;
    if (!category) continue;
    if (typeof record["bot"] === "string" && record["bot"] !== bot) continue;
    const scope = record["bot"] === bot ? "selected-bot" : "unattributed";
    if (scope === "unattributed") ambiguous = true;
    const failure = record["failure"];
    const categoryName =
      category.category === "agent-failure"
        ? `agent-failure:${typeof failure === "string" && failures.has(failure) ? failure : "unknown"}`
        : category.category;
    const key = `${categoryName}:${category.capability}:${scope}`;
    const date = new Date(time).toISOString();
    const previous = groups.get(key);
    if (previous) {
      previous.count++;
      if (date < previous.first) previous.first = date;
      if (date > previous.last) previous.last = date;
    } else
      groups.set(key, {
        ...category,
        category: categoryName,
        scope,
        count: 1,
        first: date,
        last: date,
        state: "unknown",
        ticket: null,
        jobs: [],
      });
    const group = groups.get(key);
    const job = record["job"];
    if (
      group &&
      typeof job === "number" &&
      Number.isSafeInteger(job) &&
      job > 0 &&
      group.jobs.length < 20 &&
      !group.jobs.includes(job)
    )
      group.jobs.push(job);
  }
  return {
    state: "incomplete" as const,
    reasons: [
      "log rotation and source coverage not verified",
      ...(truncated ? ["log truncated to byte limit"] : []),
      ...(malformed ? ["malformed lines excluded"] : []),
      ...(earliest > now - windowMs
        ? ["window start not covered by observed timestamps"]
        : []),
      ...(ambiguous ? ["some incidents have no bot attribution"] : []),
    ],
    malformedLines: malformed,
    incidents: [...groups.values()],
  };
}
async function incidents(path: string | undefined, bot: string, now: number) {
  if (!path)
    return {
      state: "unknown" as const,
      reasons: ["log path not supplied"],
      incidents: [],
    };
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error();
      const start = Math.max(0, stat.size - maxLogBytes);
      const bytes = Buffer.alloc(stat.size - start);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      const text = bytes.subarray(0, bytesRead).toString("utf8");
      return summarizeLog(
        start ? text.slice(text.indexOf("\n") + 1) : text,
        bot,
        now,
        start > 0 || bytesRead !== bytes.length,
      );
    } finally {
      await file.close();
    }
  } catch {
    return {
      state: "unknown" as const,
      reasons: ["log unreadable"],
      incidents: [],
    };
  }
}
export async function statusReport(
  configPath: string,
  botID: string,
  logPath?: string,
  now = Date.now(),
) {
  const config = await readConfiguration(configPath);
  const bot = config.bots.find((item) => item.id === botID);
  if (!bot) throw new Error("Bot not found in configuration.");
  let env: NodeJS.ProcessEnv;
  try {
    let companion = {};
    try {
      companion = parseEnv(await readFile(`${configPath}.env`, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    env = { ...companion, ...process.env };
  } catch {
    env = {};
  }
  const [checks, history] = await Promise.all([
    capabilities(bot, env),
    incidents(logPath, botID, now),
  ]);
  if (history.state !== "unknown")
    checks.failureReporting = available("log readable; coverage incomplete");
  return {
    generatedAt: new Date(now).toISOString(),
    bot: botID,
    window: {
      from: new Date(now - windowMs).toISOString(),
      to: new Date(now).toISOString(),
    },
    checks,
    history,
  };
}
