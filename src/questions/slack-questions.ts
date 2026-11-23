import { Option, Schema } from "effect";
import type { BotConfig } from "../config";
import {
  type NativeQuestion,
  type QuestionAnswer,
  type QuestionOffer,
  nativeQuestionSchema,
  questionAnswer,
} from "./questions";
import {
  type Identity,
  botKey,
  isAllowedChannel,
  isAllowedUser,
} from "../shared/registration";
import type { SlackContent, SlackPanelContent } from "../shared/slack-format";
import type { Job, Store } from "../gateway/store";

const button = (action: string, value: string, label: string) => ({
  type: "button" as const,
  action_id: `${prefix}${action}`,
  value,
  text: plain(short(label, 75)),
});

type QuestionDelivery = {
  post(
    channel: string,
    thread: string,
    text: string,
    stopJob?: number,
    unit?: { allowed: () => boolean },
    content?: SlackContent,
  ): Promise<string> | Promise<void>;
  update?(
    channel: string,
    ts: string,
    text: string,
    stopJob?: number,
    content?: SlackContent,
  ): Promise<boolean> | Promise<void>;
  ephemeral?(
    channel: string,
    user: string,
    thread: string,
    text: string,
  ): Promise<void>;
};

const prefix = "stargate_question_";
const timestamp = Schema.String.check(Schema.isPattern(/^\d{1,16}\.\d{1,6}$/));
const humanID = Schema.String.check(Schema.isPattern(/^[UW][A-Z0-9]+$/));
const channelID = Schema.String.check(Schema.isPattern(/^[CGD][A-Z0-9]+$/));

const actionCandidate = Schema.decodeUnknownOption(
  Schema.Struct({
    actions: Schema.Array(Schema.Unknown),
  }),
);

const actionID = Schema.decodeUnknownOption(
  Schema.Struct({ action_id: Schema.String }),
);

const decodeAction = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("block_actions"),
    api_app_id: Schema.String,
    team: Schema.Struct({ id: Schema.String }),
    user: Schema.Struct({
      id: humanID,
      is_bot: Schema.optional(Schema.Literal(false)),
      bot_id: Schema.optional(Schema.Never),
    }),
    bot_id: Schema.optional(Schema.Never),
    channel: Schema.Struct({ id: channelID }),
    container: Schema.Struct({
      type: Schema.Literal("message"),
      channel_id: Schema.String,
      message_ts: timestamp,
      is_ephemeral: Schema.optional(Schema.Literal(false)),
    }),
    message: Schema.Struct({
      user: Schema.String,
      ts: timestamp,
      thread_ts: timestamp,
    }),
    actions: Schema.Array(
      Schema.Struct({
        type: Schema.Literals(["button", "checkboxes"]),
        action_id: Schema.String,
        value: Schema.optional(Schema.String),
        action_ts: timestamp,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
    state: Schema.optional(
      Schema.Struct({
        values: Schema.Record(
          Schema.String,
          Schema.Record(Schema.String, Schema.Unknown),
        ),
      }),
    ),
  }),
);

const decodeSelection = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("checkboxes"),
    selected_options: Schema.Array(
      Schema.Struct({ value: Schema.String }),
    ).check(Schema.isMaxLength(20)),
  }),
);

const decodeTextCandidate = Schema.decodeUnknownOption(
  Schema.Struct({ event: Schema.Struct({ text: Schema.String }) }),
);

const decodeReply = Schema.decodeUnknownOption(
  Schema.Struct({
    api_app_id: Schema.String,
    team_id: Schema.String,
    event: Schema.Struct({
      type: Schema.Literals(["message", "app_mention"]),
      user: humanID,
      channel: channelID,
      text: Schema.String.check(Schema.isMaxLength(4100)),
      ts: timestamp,
      thread_ts: timestamp,
      bot_id: Schema.optional(Schema.Never),
      subtype: Schema.optional(Schema.Never),
      hidden: Schema.optional(Schema.Literal(false)),
    }),
  }),
);

function custom(field: NativeQuestion["fields"][number] | undefined) {
  return (
    !!field &&
    (field.custom === true ||
      (field.type === "string" &&
        field.options === undefined &&
        field.custom !== false))
  );
}

const plain = (text: string) => ({
  type: "plain_text" as const,
  text,
  emoji: false,
});

const short = (text: string, limit: number) =>
  Array.from(text).slice(0, limit).join("");

const selectionBlock = (token: string, revision: number, group: number) =>
  `${token}:${revision}${group ? `:${group}` : ""}`;

/** Each revision displays one complete native field, preserving its native key. */
export function buildQuestionBlocks(
  question: NativeQuestion,
  token: string,
  revision = 0,
): SlackPanelContent {
  if (
    !Number.isInteger(revision) ||
    revision < 0 ||
    revision > question.fields.length
  )
    throw new Error("Invalid clarification revision");
  const field = question.fields[revision];

  if (!field) {
    const text =
      "All clarification answers are recorded. If submission was interrupted, explicitly submit these saved answers. This grants no tool permission.";

    return {
      text,
      blocks: [
        { type: "section", text: plain(text) },
        {
          type: "actions",
          block_id: `${token}:${revision}:complete`,
          elements: [
            {
              type: "button",
              action_id: `${prefix}finish`,
              value: `${token}:${revision}`,
              text: plain("Submit saved answers"),
            },
          ],
        },
      ],
    };
  }

  const control = question.fields.length === 1 ? token : `${token}:${revision}`;

  const description = [
    "OpenCode needs clarification (not a permission approval).",
    question.title,
    `Question ${revision + 1} of ${question.fields.length}: ${field.key}`,
    field.title,
    field.description,
    ...(field.options ?? []).map(
      (option, i) =>
        `${i + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}`,
    ),
    "This offer expires. Never send credentials.",
  ]
    .filter(Boolean)
    .join("\n");

  const blocks: SlackPanelContent["blocks"] = [];
  const chars = Array.from(description);

  for (let i = 0; i < chars.length; i += 2800)
    blocks.push({
      type: "section",
      text: plain(chars.slice(i, i + 2800).join("")),
    });

  const elements: Extract<
    SlackPanelContent["blocks"][number],
    { type: "actions" }
  >["elements"] = [];

  if (field.type === "multiselect" && field.options.length > 0) {
    for (let start = 0; start < field.options.length; start += 10)
      blocks.push({
        type: "actions",
        block_id: selectionBlock(token, revision, start / 10),
        elements: [
          {
            type: "checkboxes",
            action_id: `${prefix}select`,
            options: field.options
              .slice(start, start + 10)
              .map((option, i) => ({
                text: plain(short(option.label, 75)),
                value: `${token}:${revision}:${start + i}`,
              })),
          },
        ],
      });
    elements.push(button("submit", control, "Submit"));
  } else if (field.type === "string") {
    elements.push(
      ...(field.options ?? []).map((option, i) =>
        button(
          `pick_${revision}_${i}`,
          `${token}:${revision}:${i}`,
          option.label,
        ),
      ),
    );
  }

  if (custom(field)) elements.push(button("custom", control, "Type your own"));

  if (field.required === false)
    elements.push(button("skip", control, "Skip optional question"));
  elements.push(button("cancel", control, "Cancel question"));
  blocks.push({
    type: "actions",
    block_id: `${token}:${revision}:controls`,
    elements,
  });

  return {
    text: description
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
    blocks,
  };
}

type Settings = {
  enabled: boolean;
  timeoutMs: number;
  answer: "requester" | "allowed";
};

/** Slack validates provenance; the gateway owns native revalidation and claims. */
export class SlackQuestionControls {
  private tail = Promise.resolve();
  public constructor(
    private readonly store: Store,
    private readonly slack: QuestionDelivery,
    private readonly bot: () => BotConfig | undefined,
    private readonly identity: Identity,
    private readonly isHuman: (user: string) => Promise<boolean>,
    private readonly settings: () => Promise<Settings>,
    private readonly submit: (
      job: Job,
      token: string,
      answer: string | null,
      user: string,
    ) => Promise<void>,
  ) {}

  private owner(token: string) {
    const bot = this.bot();

    if (!bot) return;
    const key = botKey(bot, this.identity);
    const offer = this.store.questions.questionByToken(key, token);

    if (offer?.state !== "offered" || offer.expires <= Date.now()) return;
    const job = this.store.jobByInput(key, offer.inputID);

    if (
      !job ||
      job.id !== offer.jobID ||
      job.status !== "running" ||
      job.sender ||
      job.fleet ||
      job.deferDelivery ||
      !isAllowedUser(bot, job.user) ||
      !isAllowedChannel(bot, job.channel)
    )
      return;

    return { bot, offer, job };
  }

  private bound(token: string) {
    const owner = this.owner(token);
    const binding = this.store.questions.slackQuestion(token);

    if (!owner || !binding) return;

    try {
      const question = Schema.decodeUnknownSync(nativeQuestionSchema)(
        JSON.parse(binding.question),
      );

      if (
        !Number.isInteger(binding.revision) ||
        binding.revision < 0 ||
        binding.revision > question.fields.length ||
        question.id !== owner.offer.formID ||
        question.sessionID !== owner.offer.sessionID ||
        question.inputID !== owner.offer.inputID ||
        question.fingerprint !== owner.offer.fingerprint
      )
        return;

      const progress = questionAnswer(
        { ...question, fields: question.fields.slice(0, binding.revision) },
        binding.progress,
      );

      return {
        ...owner,
        binding,
        question,
        progress,
        field: question.fields[binding.revision],
      };
    } catch {
      return;
    }
  }

  private enqueue(task: () => Promise<boolean>) {
    const next = this.tail.then(task);
    this.tail = next.then(
      () => {},
      () => {},
    );

    return next;
  }

  private async repaint(
    token: string,
    user: string,
    channel: string,
    thread: string,
    open: () => boolean,
  ) {
    const current = await this.admitted(token, user, channel, thread, open);

    if (!current || !this.slack.update || !open()) return;

    const panel = buildQuestionBlocks(
      current.question,
      token,
      current.binding.revision,
    );

    await this.slack.update(
      channel,
      current.binding.ts,
      panel.text,
      undefined,
      panel,
    );
  }

  private async advance(
    current: NonNullable<ReturnType<SlackQuestionControls["bound"]>>,
    answer: QuestionAnswer,
    user: string,
    open: () => boolean,
  ) {
    const revision = current.binding.revision + 1;
    const progress = { ...current.progress, ...answer };
    const text = JSON.stringify(progress);
    questionAnswer(
      {
        ...current.question,
        fields: current.question.fields.slice(0, revision),
      },
      text,
    );

    if (
      !open() ||
      !this.store.questions.advanceSlackQuestion(
        current.offer.token,
        current.binding.revision,
        text,
      )
    )
      return;

    if (revision === current.question.fields.length) {
      await this.submit(current.job, current.offer.token, text, user);

      return;
    }

    await this.repaint(
      current.offer.token,
      user,
      current.job.channel,
      current.job.replyParent ?? current.job.thread,
      open,
    );
  }

  private async admitted(
    token: string,
    user: string,
    channel: string,
    thread: string,
    open: () => boolean,
  ) {
    const matches = (settings: Settings) => {
      const current = this.bound(token);

      if (
        !open() ||
        !settings.enabled ||
        !current ||
        user === this.identity.user ||
        user === "USLACKBOT" ||
        !isAllowedUser(current.bot, user) ||
        current.job.channel !== channel ||
        (current.job.replyParent ?? current.job.thread) !== thread ||
        (settings.answer !== "allowed" && current.job.user !== user)
      )
        return;

      return current;
    };

    if (!matches(await this.settings())) return;

    if (!(await this.isHuman(user))) return;

    return matches(await this.settings());
  }

  public async publishQuestion(
    job: Job,
    offer: QuestionOffer,
    question: NativeQuestion,
    allowed: () => boolean,
  ): Promise<void> {
    const settings = await this.settings();
    const current = this.owner(offer.token);

    if (
      !settings.enabled ||
      !allowed() ||
      !current ||
      current.job.id !== job.id ||
      question.id !== offer.formID ||
      question.fingerprint !== offer.fingerprint ||
      question.sessionID !== offer.sessionID ||
      question.inputID !== offer.inputID
    )
      throw new Error("Clarification publication refused");
    const trusted = Schema.decodeUnknownSync(nativeQuestionSchema)(question);

    if (trusted.fields.length > 1 && !this.slack.update)
      throw new Error("Clarification updates unavailable");
    const panel = buildQuestionBlocks(trusted, offer.token);

    const ts = await this.slack.post(
      job.channel,
      job.replyParent ?? job.thread,
      panel.text,
      undefined,
      { allowed: () => allowed() && !!this.owner(offer.token) },
      panel,
    );

    if (typeof ts !== "string" || !/^\d{1,16}\.\d{1,6}$/.test(ts))
      throw new Error("Clarification publication unconfirmed");
    this.store.questions.saveSlackQuestion(offer.token, ts, trusted);
  }

  public async interactive(
    raw: unknown,
    ack: (payload?: Record<string, unknown>) => Promise<void>,
    open: () => boolean,
  ): Promise<boolean> {
    const candidate = actionCandidate(raw);

    if (
      Option.isNone(candidate) ||
      !candidate.value.actions.some((entry) => {
        const action = actionID(entry);

        return (
          Option.isSome(action) && action.value.action_id.startsWith(prefix)
        );
      })
    )
      return false;
    await ack();

    if (!open()) return true;

    return this.enqueue(async () => {
      try {
        await this.handleInteractive(raw, open);
      } catch {
        /* Fail closed without exposing provider data. */
      }

      return true;
    });
  }

  private async handleInteractive(raw: unknown, open: () => boolean) {
    const parsed = decodeAction(raw);
    const bot = this.bot();

    if (Option.isNone(parsed) || !bot) return;
    const body = parsed.value;
    const action = body.actions[0];

    if (
      !action ||
      body.api_app_id !== bot.slack.appId ||
      body.team.id !== this.identity.team ||
      body.message.user !== this.identity.user ||
      body.container.channel_id !== body.channel.id ||
      body.container.message_ts !== body.message.ts
    )
      return;

    // Checkbox changes only update Slack state. They never answer the form.
    if (action.action_id === `${prefix}select`) return;

    if (action.type !== "button") return;

    const match = /^([a-f0-9]{32})(?::([0-8])(?::([0-9]|1[0-9]))?)?$/.exec(
      action.value ?? "",
    );

    if (!match) return;
    const token = match[1] ?? "";

    const current = await this.admitted(
      token,
      body.user.id,
      body.channel.id,
      body.message.thread_ts,
      open,
    );

    if (!current || current.binding.ts !== body.message.ts) return;

    if (match[2] === undefined && current.question.fields.length !== 1) return;
    const revision = Number(match[2] ?? "0");

    if (revision !== current.binding.revision) {
      if (revision < current.binding.revision)
        await this.repaint(
          token,
          body.user.id,
          body.channel.id,
          body.message.thread_ts,
          open,
        );

      return;
    }

    if (action.action_id === `${prefix}cancel` && match[3] === undefined) {
      if (open()) await this.submit(current.job, token, null, body.user.id);

      return;
    }

    const field = current.field;

    if (!field) {
      if (
        action.action_id === `${prefix}finish` &&
        match[3] === undefined &&
        open()
      )
        await this.submit(
          current.job,
          token,
          JSON.stringify(current.progress),
          body.user.id,
        );

      return;
    }

    let answer: QuestionAnswer;

    if (
      action.action_id === `${prefix}pick_${revision}_${match[3]}` &&
      match[3] !== undefined &&
      field.type === "string"
    ) {
      const option = field.options?.[Number(match[3])];

      if (!option) return;
      answer = { [field.key]: option.value };
    } else if (match[3] !== undefined) return;
    else if (
      action.action_id === `${prefix}submit` &&
      field.type === "multiselect"
    ) {
      const values: string[] = [];

      for (let start = 0; start < field.options.length; start += 10) {
        const selection = decodeSelection(
          body.state?.values[selectionBlock(token, revision, start / 10)]?.[
            `${prefix}select`
          ],
        );

        if (Option.isNone(selection)) return;

        for (const selected of selection.value.selected_options) {
          const index = /^([a-f0-9]{32}):([0-8]):([0-9]|1[0-9])$/.exec(
            selected.value,
          );

          const number = Number(index?.[3]);

          const option =
            index?.[1] === token &&
            Number(index[2]) === revision &&
            number >= start &&
            number < start + 10
              ? field.options[number]
              : undefined;

          if (!option) return;
          values.push(option.value);
        }
      }

      answer = { [field.key]: values };
    } else if (action.action_id === `${prefix}skip` && field.required === false)
      answer = {};
    else if (action.action_id === `${prefix}custom` && custom(field)) {
      if (open())
        await this.slack.ephemeral?.(
          current.job.channel,
          body.user.id,
          body.message.thread_ts,
          `Reply in this thread: <@${this.identity.user}> answer ${token}${current.question.fields.length > 1 ? `:${revision}` : ""} <your answer>${field.type === "multiselect" ? " (comma-separated choices)" : ""}. Never send credentials.`,
        );

      return;
    } else return;
    questionAnswer(
      { ...current.question, fields: [field] },
      JSON.stringify(answer),
    );
    await this.advance(current, answer, body.user.id, open);
  }

  public receive(raw: unknown, open: () => boolean): Promise<boolean> | false {
    const candidate = decodeTextCandidate(raw);

    if (Option.isNone(candidate)) return false;

    const match = new RegExp(
      `^\\s*<@${this.identity.user}>\\s+answer\\s+([a-f0-9]{32})(?::([0-8]))?(?:\\s+([\\s\\S]+))?\\s*$`,
    ).exec(candidate.value.event.text);

    if (!match) return false;

    return this.enqueue(async () => {
      try {
        if (!(await this.settings()).enabled) return false;
        await this.handleReply(
          raw,
          match[1] ?? "",
          match[2],
          (match[3] ?? "").trim(),
          open,
        );
      } catch {
        /* Fail closed. */
      }

      return true;
    });
  }

  private async handleReply(
    raw: unknown,
    token: string,
    revisionText: string | undefined,
    text: string,
    open: () => boolean,
  ) {
    const parsed = decodeReply(raw);
    const bot = this.bot();

    if (Option.isNone(parsed) || !bot || !text || text.length > 4000) return;
    const body = parsed.value;

    if (
      body.api_app_id !== bot.slack.appId ||
      body.team_id !== this.identity.team
    )
      return;

    const current = await this.admitted(
      token,
      body.event.user,
      body.event.channel,
      body.event.thread_ts,
      open,
    );

    if (
      !current ||
      (revisionText === undefined && current.question.fields.length !== 1)
    )
      return;
    const revision = Number(revisionText ?? "0");

    if (revision !== current.binding.revision) {
      if (revision < current.binding.revision)
        await this.repaint(
          token,
          body.event.user,
          body.event.channel,
          body.event.thread_ts,
          open,
        );

      return;
    }

    const field = current.field;

    if (!field || !custom(field)) return;

    const answer = {
      [field.key]:
        field.type === "multiselect"
          ? text.split(",").map((value) => value.trim())
          : text,
    };

    questionAnswer(
      { ...current.question, fields: [field] },
      JSON.stringify(answer),
    );
    await this.advance(current, answer, body.event.user, open);
  }
}
