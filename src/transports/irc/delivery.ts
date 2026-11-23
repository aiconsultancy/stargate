import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import type { AttachmentTransport } from "../../attachments/attachment-delivery";
import type {
  DeliveryUnit,
  IrcTurnStatus,
  RequestOutcome,
  TransportDelivery,
} from "../../gateway/ports";
import type { ReactionName } from "../../shared/reactions";
import { settingsStruct } from "../../config/settings-schema";
import {
  type TurnProgress,
  type TurnStage,
  turnProgressText,
} from "../../shared/turn-progress";
import type { IrcClient } from "./client";
import { type Filehost, safeFileURL } from "./filehost";
import { cleanText, ircParts, utf8Bytes } from "./protocol";
import { isIrcChannel, validMsgid } from "./routing";
import { ircLines, plainText } from "./text";

/** IRCv3 `+draft/react` values for the gateway's reaction names. */
const emoji: Record<ReactionName, string> = {
  eyes: "👀",
  thumbsup: "👍",
  heart: "❤️",
  tada: "🎉",
  white_check_mark: "✅",
  thinking_face: "🤔",
  pray: "🙏",
  joy: "😂",
};

/** FILEHOST access of one IRC registration. */
export type IrcFiles = {
  files: Filehost;
  /** Effective FILEHOST now; undefined means files are unavailable. */
  filehost(): URL | undefined;
  /** Features.filesIn: download FILEHOST links of admitted messages. */
  download: boolean;
  /** Features.filesOut: upload published files and post their links. */
  upload: boolean;
};

/** Optional per-turn signals. */
export type IrcPresence = {
  /** Features.typing: +typing while a turn runs. */
  typing: boolean;
  fleetTyping?: boolean;
  /** Features.reactions: +draft/react for reaction replies. */
  reactions?: boolean;
};

/** A fresh default object for each delivery: typing off. */
function noPresence(): IrcPresence {
  return { typing: false };
}

/** Persisted plan and progress of one stored chunk (see Store). */
export type IrcProgress = {
  plan(unit: DeliveryUnit, plan: string): { plan: string; done: number };
  /** Replace the plan; its first `done` units must stay the same. */
  replan(unit: DeliveryUnit, plan: string): void;
  done(unit: DeliveryUnit, done: number): void;
};

const planSchema = settingsStruct({
  batched: Schema.Boolean,
  units: Schema.mutable(
    Schema.Array(
      settingsStruct({
        lines: Schema.mutable(
          Schema.Array(
            settingsStruct({ text: Schema.String, concat: Schema.Boolean }),
          ),
        ).check(Schema.isMinLength(1)),
      }),
    ),
  ),
});

type Plan = typeof planSchema.Type;

type Part = Plan["units"][number]["lines"][number];

/** Draft/multiline bytes as Stargate counts them (see packBatches). */
function batchBytes(lines: readonly Part[]) {
  return lines.reduce(
    (sum, line, index) =>
      sum + utf8Bytes(line.text) + (index && !line.concat ? 1 : 0),
    0,
  );
}

/**
 * Pack parts into batches within draft/multiline max-bytes and max-lines.
 * Bytes count each part's text plus one line break before each new line
 * (at least what the server counts). Each part
 * must already fit `maxBytes`. A batch never starts with a concatenation.
 */
export function packBatches(
  parts: readonly Part[],
  limits: { maxBytes: number; maxLines: number },
) {
  const units: Plan["units"] = [];
  let lines: Part[] = [];
  let bytes = 0;

  for (const part of parts) {
    const cost = (line: Part, first: boolean) =>
      utf8Bytes(line.text) + (first || line.concat ? 0 : 1);

    if (
      lines.length > 0 &&
      (lines.length >= limits.maxLines ||
        bytes + cost(part, false) > limits.maxBytes)
    ) {
      units.push({ lines });
      lines = [];
      bytes = 0;
    }

    const line = lines.length > 0 ? part : { ...part, concat: false };
    bytes += cost(line, lines.length === 0);
    lines.push(line);
  }

  if (lines.length > 0) units.push({ lines });

  return units;
}

/**
 * Gateway delivery over one IRC connection. A stored reply chunk becomes
 * plain-text lines that fit 512 bytes (or multiline batches); every unit
 * replies to the stored thread root, if any. Each unit waits for the
 * server's labeled echo when labeled-response is available. A failure
 * throws, so the gateway retries the chunk later without rerunning the
 * agent. IRC cannot edit or delete, so there are no previews, streaming
 * updates or Stop buttons.
 *
 * Extension point: `remove` (and edits) are not implemented. Ergo ships
 * with draft/message-redaction disabled; a `REDACT <target> <msgid>`
 * version of `remove` belongs here, used only when the server offers it.
 */
/** Direct targets plan for a 32-character nick (see `plan`). */
function planTarget(channel: string) {
  return isIrcChannel(channel) ? channel : "n".repeat(32);
}

export class IrcDelivery implements TransportDelivery {
  public constructor(
    private readonly client: IrcClient,
    /** Wait for a reconnect before a delivery attempt fails. */
    private readonly readyMs = 30_000,
    private readonly hosted?: IrcFiles,
    private readonly progress?: IrcProgress,
    private readonly presence: IrcPresence = noPresence(),
    /** Thread roots resolve separately from their request/Stop identity. */
    private readonly replyParent?: (request: string) => string | undefined,
  ) {
    // Without reactions the gateway never asks for one.
    if (presence.reactions !== false)
      this.react = (channel, ts, name, allowed) =>
        this.reaction(channel, ts, name, allowed);
  }

  /**
   * Fleet turns use bounded request notices. Other registrations send
   * +typing=active every `typingMs` (3 s) until the turn ends, then
   * +typing=done. Direct messages type only to a nick that WHOIS shows
   * holds the requester's account, rechecked for each TAGMSG and at its
   * socket write like direct lines: once the nick changes hands, typing
   * stops for this turn. Skipped when the send queue is busy.
   */
  public async working(
    channel: string,
    thread: string,
    signal: AbortSignal,
    allowed?: () => boolean,
    turnStatus?: IrcTurnStatus,
    readProgress?: () => TurnProgress | undefined,
    request?: string,
  ) {
    const finish = this.client.startStatus();

    if (signal.aborted) {
      finish();

      return;
    }

    // Typing may stop early (for example a DM nick changed hands); the turn
    // Still owns its aggregate status handle until its actual lifecycle ends.
    signal.addEventListener("abort", finish, { once: true });

    const fleetTyping =
      turnStatus && turnStatus !== "quiet" && this.presence.fleetTyping
        ? this.typing(channel, signal, allowed).catch(() => {})
        : undefined;

    const active = () => !signal.aborted && (allowed?.() ?? true);

    try {
      if (turnStatus) {
        if (turnStatus === "live") {
          let previous: TurnProgress | undefined;
          let sent = false;
          await delay(Math.min(3000, this.client.turnStatusMs), undefined, {
            signal,
          }).catch(() => {});

          while (active()) {
            const observed = readProgress?.();

            if (
              !sent ||
              (observed &&
                (!previous ||
                  previous.stage !== observed.stage ||
                  !!previous.disconnected !== !!observed.disconnected))
            ) {
              previous = observed;
              sent = true;
              await this.turnNotice(
                channel,
                thread,
                observed
                  ? turnProgressText(observed)
                  : "Stargate received your request. Waiting for backend activity.",
                active,
                observedProgress(request, observed),
              ).catch(() => {});
            }

            await delay(Math.min(30_000, this.client.turnStatusMs), undefined, {
              signal,
            }).catch(() => {});
          }

          return;
        }

        if (turnStatus === "notice") {
          void this.turnNotice(
            channel,
            thread,
            "Checking that now…",
            active,
            observedProgress(request),
          ).catch(() => {});
          let reported: TurnProgress | undefined;
          let first = true;

          while (!signal.aborted) {
            await delay(this.client.turnStatusMs, undefined, { signal }).catch(
              () => {},
            );

            if (signal.aborted || (allowed && !allowed())) break;
            const progress = readProgress?.();

            if (!first && reported === progress) continue;
            first = false;
            reported = progress;
            void this.turnNotice(
              channel,
              thread,
              readProgress
                ? turnProgressText(progress)
                : "This request is still open.",
              active,
              progress ? observedProgress(request, progress) : undefined,
            ).catch(() => {});

            if (!readProgress) break;
          }
        }

        return;
      }

      await this.typing(channel, signal, allowed);
    } finally {
      await fleetTyping;

      if (signal.aborted) finish();
    }
  }

  public async requestSettled(
    channel: string,
    request: string,
    outcome: RequestOutcome,
    signal: AbortSignal,
    allowed: () => boolean,
  ) {
    if (signal.aborted) return;

    if (!this.client.registered) {
      try {
        await this.client.waitReady(this.readyMs, signal);
      } catch {
        return;
      }
    }

    await this.turnNotice(
      channel,
      request,
      outcome === "completed"
        ? "Stargate completed this request."
        : "Stargate could not complete this request.",
      () => !signal.aborted && allowed(),
      { request, stage: outcome },
    );
  }

  private async typing(
    channel: string,
    signal: AbortSignal,
    allowed?: () => boolean,
  ) {
    if (!this.presence.typing || !this.client.hasCap("message-tags")) {
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });

      return;
    }

    const target = await this.target(channel);
    const guard = this.guard(channel, target, allowed);
    const timer = this.client.typingMs;

    while (!signal.aborted) {
      if (guard && !guard()) return;
      this.client.notify(target, { "+typing": "active" }, guard);
      await delay(timer, undefined, { signal }).catch(() => {});
    }

    this.client.notify(target, { "+typing": "done" }, guard);
  }

  /** NOTICE cannot wake another bot or count as the captain joining a thread. */
  private async turnNotice(
    channel: string,
    thread: string,
    text: string,
    active: () => boolean,
    progress?: NoticeProgress,
  ) {
    if (!active() || !this.client.registered) return;

    const terminal =
      progress?.stage === "completed" || progress?.stage === "failed";

    if (terminal && !this.client.hasCap("message-tags")) return;
    const target = await this.target(channel).catch(() => {});

    if (!target || !active()) return;
    const parent = progress?.request ?? this.replyParent?.(thread) ?? thread;

    const tags: Record<string, string> =
      this.client.hasCap("message-tags") &&
      validMsgid(parent) &&
      !parent.startsWith("stargate-")
        ? { "+draft/reply": parent }
        : {};

    if (progress && tags["+draft/reply"])
      tags["+stargate/progress"] =
        progress.stage + (progress.disconnected ? ",disconnected" : "");

    if (terminal && !tags["+stargate/progress"]) return;
    // A missing acknowledgement or IRC confirmation must not hold up a reply.
    void this.client
      .send(
        "NOTICE",
        [target, text],
        tags,
        this.guard(channel, target, active),
        "low",
      )
      .catch(() => {});
  }

  /**
   * Split one stored chunk into delivery units: multiline batches when the
   * server offers draft/multiline, otherwise single lines. Direct targets
   * plan for a 32-character nick, so a nick change cannot overflow a line.
   */
  private plan(channel: string, text: string, reply: Record<string, string>) {
    const target = planTarget(channel);
    const plain = plainText(text);
    const limits = this.client.multiline;

    if (!limits) {
      const budget = this.client.budget("PRIVMSG", target, reply);

      return {
        batched: false,
        units: ircLines(plain, budget).map((line) => ({
          lines: [{ text: line, concat: false }],
        })),
      };
    }

    // A fragment fits both one IRC line and the whole batch limit.
    const budget = Math.min(
      limits.maxBytes,
      this.client.budget("PRIVMSG", target, {
        batch: `stargate${"9".repeat(12)}`,
        "draft/multiline-concat": "",
      }),
    );

    const parts = plain
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .flatMap((line) =>
        ircParts(line, budget).map((piece, index) => ({
          text: piece,
          concat: index > 0,
        })),
      );

    return { batched: true, units: packBatches(parts, limits) };
  }

  /**
   * FILEHOST attachments while the server offers one; undefined otherwise,
   * so the gateway keeps its "attachment unavailable" behaviour.
   */
  public get files(): AttachmentTransport | undefined {
    const hosted = this.hosted;

    if (!hosted?.filehost()) return undefined;

    return {
      download: (urls, _channel, signal) => {
        if (!hosted.download)
          return Promise.reject(new Error("IRC file input is off"));

        return hosted.files.download(urls, signal);
      },
      ...(hosted.upload && {
        upload: (file, signal) => hosted.files.upload(file, signal),
        link: (channel, thread, url, title, _signal, allowed) =>
          this.link(channel, thread, url, title, allowed),
      }),
    };
  }

  /** One line `title: URL`; the title is cut, never the URL. */
  private async link(
    channel: string,
    thread: string,
    url: string,
    title: string,
    allowed?: () => boolean,
  ) {
    await this.client.waitReady(this.readyMs);
    const host = this.hosted?.filehost();

    if (!host || !URL.canParse(url) || !safeFileURL(new URL(url), host))
      throw new Error("IRC file link is not a plain FILEHOST URL");
    const target = await this.target(channel);
    const reply = this.reply(thread, channel);
    const budget = this.client.budget("PRIVMSG", target, reply);
    const room = budget - utf8Bytes(`: ${url}`);
    let name = cleanText(title).trim() || "File";

    while (name && utf8Bytes(name) > room)
      name = Array.from(name).slice(0, -1).join("");

    if (!name || utf8Bytes(url) > budget)
      throw new Error("IRC file link does not fit one line");
    await this.client.privmsg(
      target,
      `${name}: ${url}`,
      reply,
      this.guard(channel, target, allowed),
      "normal",
      thread,
    );
  }

  /**
   * Channel, or the nick that WHOIS proves holds the direct-message account
   * right now. Throws (and the gateway retries) when no nick does.
   */
  private target(channel: string) {
    return isIrcChannel(channel)
      ? Promise.resolve(channel)
      : this.client.verifiedNick(channel);
  }

  /**
   * For a direct reply: true while the verified nick still holds the
   * recipient account. Checked when a line is queued and again at the
   * socket write, so a QUIT or NICK seen meanwhile drops the line; the
   * stored reply stays for the gateway's retry.
   */
  private guard(channel: string, target: string, allowed?: () => boolean) {
    if (isIrcChannel(channel)) return allowed;

    return () => this.client.holds(channel, target) && (allowed?.() ?? true);
  }

  private reply(thread: string, channel?: string): Record<string, string> {
    const parent =
      channel !== undefined && this.replyParent
        ? (this.replyParent(thread) ??
          (isIrcChannel(channel) ? undefined : thread))
        : thread;

    return this.client.hasCap("message-tags") && validMsgid(parent)
      ? { "+draft/reply": parent }
      : {};
  }

  /**
   * Deliver one chunk. With a delivery unit, the plan and the count of
   * confirmed units are stored, so a retry resends only the units after the
   * last confirmed one: no line or batch is repeated, except one whose
   * confirmation was lost.
   */
  public async post(
    channel: string,
    thread: string,
    text: string,
    _stopJob?: number,
    unit?: DeliveryUnit | { allowed: () => boolean },
  ) {
    await this.client.waitReady(this.readyMs);

    if (unit?.allowed && !unit.allowed())
      throw new Error("IRC delivery access denied");
    const target = await this.target(channel);
    const reply = this.reply(thread, channel);
    const tracked = unit && "job" in unit ? unit : undefined;
    let plan: Plan = this.plan(channel, text, reply);
    let done = 0;

    if (tracked && this.progress) {
      const stored = this.progress.plan(tracked, JSON.stringify(plan));
      plan = Schema.decodeUnknownSync(planSchema)(JSON.parse(stored.plan));
      done = stored.done;
    }

    const limits = this.client.multiline;

    if (
      plan.batched &&
      (!limits ||
        plan.units
          .slice(done)
          .some(
            ({ lines }) =>
              lines.length > limits.maxLines ||
              batchBytes(lines) > limits.maxBytes,
          ))
    ) {
      // Multiline is gone (or its limits shrank) since the plan was made:
      // Each remaining line becomes its own unit, stored, so line progress
      // Survives a retry.
      plan = this.unbatch(plan, done, planTarget(channel), reply);

      if (tracked && this.progress)
        this.progress.replan(tracked, JSON.stringify(plan));
    }

    // Greybeard: a nick that changes hands without a QUIT/NICK/ACCOUNT we
    // Can see (no shared channel) after WHOIS is not detected for the
    // Lines of this chunk; each delivery attempt revalidates with WHOIS.
    const recipient = this.guard(channel, target);
    const guard = () => (recipient?.() ?? true) && (unit?.allowed?.() ?? true);

    for (let index = done; index < plan.units.length; index++) {
      const lines = plan.units[index]?.lines ?? [];

      if (plan.batched)
        await this.client.sendBatch(
          target,
          lines,
          reply,
          guard,
          "normal",
          thread,
        );
      else
        for (const line of lines)
          await this.client.privmsg(
            target,
            line.text,
            reply,
            guard,
            "normal",
            thread,
          );

      if (tracked && this.progress) this.progress.done(tracked, index + 1);
    }
  }

  /**
   * A batched plan as plain lines: the first `done` units stay (their
   * indexes are the stored progress), every later line is one unit,
   * re-split if it does not fit a plain line with the reply tag.
   */
  private unbatch(
    plan: Plan,
    done: number,
    target: string,
    reply: Record<string, string>,
  ): Plan {
    const budget = this.client.budget("PRIVMSG", target, reply);

    return {
      batched: false,
      units: [
        ...plan.units.slice(0, done),
        ...plan.units.slice(done).flatMap((unit) =>
          unit.lines.flatMap((line) =>
            ircParts(line.text, budget).map((text) => ({
              lines: [{ text, concat: false }],
            })),
          ),
        ),
      ],
    };
  }

  /** +draft/react to a request's message; absent with reactions off. */
  public react?: (
    channel: string,
    ts: string,
    name: ReactionName,
    allowed?: () => boolean,
  ) => Promise<void>;

  private async reaction(
    channel: string,
    ts: string,
    name: ReactionName,
    allowed?: () => boolean,
  ) {
    await this.client.waitReady(this.readyMs);
    const reply = this.reply(ts);

    if (!("+draft/reply" in reply))
      throw new Error("IRC reactions need message tags");
    const target = await this.target(channel);
    await this.client.tagmsg(
      target,
      { ...reply, "+draft/react": emoji[name] },
      this.guard(channel, target, allowed),
    );
  }
}

type NoticeProgress = { request: string } & (
  | {
      stage: "received" | Exclude<TurnStage, "completed">;
      disconnected?: boolean;
    }
  | { stage: RequestOutcome; disconnected?: never }
);

/** A backend event is an observation, even if the backend says it ended. */
function observedProgress(
  request: string | undefined,
  progress?: TurnProgress,
): NoticeProgress | undefined {
  if (!request || progress?.stage === "completed") return;

  return {
    request,
    stage: progress?.stage ?? "received",
    ...(progress?.disconnected && { disconnected: true }),
  };
}
