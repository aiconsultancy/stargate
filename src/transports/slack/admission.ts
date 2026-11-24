import type { BotConfig } from "../../config";
import type { Gateway } from "../../gateway/gateway";
import { botSender, isSlackHuman, peerLookupMs } from "../../gateway/peers";
import { routeReaction } from "../../gateway/routing";

type Admission = (write: () => boolean) => boolean | Promise<boolean>;

type Reaction = NonNullable<ReturnType<typeof routeReaction>>;

export class SlackAdmission {
  private tail = Promise.resolve();

  public constructor(
    private readonly intake: ReturnType<Gateway["slackIntake"]>,
  ) {}

  public handler(open: () => boolean) {
    return async (body: unknown) => open() && this.receive(body, open);
  }

  public async receive(body: unknown, open: () => boolean = () => true) {
    const bot = this.intake.bot();

    if (!bot || !open()) return false;
    const current = () => open() && this.intake.bot() === bot;
    const reaction = routeReaction(body, bot, this.intake.identity);

    if (reaction)
      return this.ordered(current, (admit) =>
        this.receiveReaction(reaction, bot, current, admit),
      );
    const question = this.intake.question(body, current);

    if (question !== false && (await question)) return false;
    const meta = this.intake.meta(body, bot, current);

    if (meta !== false) {
      await meta;

      return false;
    }

    return bot.slack.inboundReactions
      ? this.ordered(current, (admit) =>
          this.receiveMessage(body, bot, current, admit),
        )
      : this.receiveMessage(body, bot, open);
  }

  /** Start lookups on arrival; only the durable writes wait their turn. */
  private async ordered(
    open: () => boolean,
    receive: (admit: Admission) => Promise<boolean>,
  ) {
    const before = this.tail;
    const slot = Promise.withResolvers<void>();
    this.tail = slot.promise;

    try {
      return await receive(async (write) => {
        await before;

        return open() && write();
      });
    } finally {
      // A rejected event must not let a later event pass an earlier lookup.
      await before;
      slot.resolve();
    }
  }

  private async receiveMessage(
    body: unknown,
    bot: BotConfig,
    open: () => boolean,
    admit: Admission = (write) => write(),
  ) {
    const { identity, peers, slack, store } = this.intake;
    const sender = botSender(body);

    if (sender && bot.access.peerCaptains && peers) {
      const verified = await peers
        .verify(sender, AbortSignal.timeout(peerLookupMs))
        .catch(() => false);

      if (!open()) return false;

      return admit(() =>
        this.intake.accept(body, verified ? sender : undefined),
      );
    }

    if (bot.resumeSlackThreads && slack.threadContext && !sender) {
      const input = this.intake.route(body);

      if (!input) return false;
      const before = input.eventId.slice(input.channel.length + 1);

      if (
        before !== input.thread &&
        !input.startsConversation &&
        !input.gate &&
        !store.follows(input.conversation)
      ) {
        // No ACK on a transient lookup failure: Slack can redeliver.
        const history = await slack.threadContext({
          channel: input.channel,
          thread: input.thread,
          before,
          user: input.user,
          botUser: identity.user,
          appId: bot.slack.appId,
          team: identity.team,
          signal: AbortSignal.timeout(1800),
        });

        if (!open() || this.intake.bot() !== bot) return false;

        return admit(() =>
          this.intake.accept(
            body,
            undefined,
            history.messages.some((message) => message.author === "this_bot"),
          ),
        );
      }
    }

    return admit(() => this.intake.accept(body));
  }

  private async receiveReaction(
    input: Reaction,
    bot: BotConfig,
    open: () => boolean,
    admit: Admission,
  ) {
    const {
      channel,
      user,
      slackReaction: { ts },
    } = input;

    const { key, identity, lifetime, slack, store } = this.intake;
    let thread = store.slackReplyThread(key, channel, ts);

    if (!slack.userInfo || (!thread && !slack.reactionThread)) return false;

    // Both reads share the Socket Mode acknowledgement budget.
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(2200)]);

    try {
      if (!isSlackHuman(await slack.userInfo(user, signal), user)) return false;

      if (signal.aborted || !open()) return false;
      thread ??= await slack.reactionThread?.({
        channel,
        ts,
        appId: bot.slack.appId,
        identity,
        signal,
      });
    } catch {
      return false;
    }

    if (!thread || signal.aborted) return false;
    const root = thread;

    return admit(() => this.intake.reaction(input, root, bot));
  }
}
