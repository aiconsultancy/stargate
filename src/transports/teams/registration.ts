import { downloadImages, incomingImageRefs } from "./inbound-images";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Result, Schema } from "effect";
import type { AgentBackend, PendingPermission } from "../../backends/backend";
import type { TeamsConfig } from "../../config";
import type { FleetSource } from "../../coordination/fleet/protocol";
import {
  fleetAuthority,
  fleetInstructions,
} from "../../coordination/fleet/fleet-policy";
import {
  fleetResultSource,
  fleetSourceReference,
} from "../../coordination/fleet/fleet-source";
import type { GatewayTransport, TransportDelivery } from "../../gateway/ports";
import { backendFingerprint } from "../../gateway/routing";
import {
  settingsDefault,
  settingsPattern,
  settingsUUID,
} from "../../config/settings-schema";
import type { Store } from "../../gateway/store";
import { resolveWaiting } from "../../config/waiting-overrides";
import { botDisplayName } from "../../shared/waiting";
import {
  BotFrameworkKeyStore,
  checkActivityBinding,
  verifyBotFrameworkToken,
} from "./botframework-auth";
import { ConnectorClient, ManagedIdentityTokenProvider } from "./connector";
import { createTeamsListener } from "./http";
import { teamsImageTransport } from "./images";
import { TeamsPresence } from "./presence";
import { isAllowedServiceUrl } from "./service-url";
import { TEAMS_MESSAGE_BYTE_BUDGET, chunkText, extractText } from "./teams";
import {
  type SocketIdentity,
  listenOnUnixSocket,
  unlinkOwnSocket,
} from "../../lib/unix-socket";

const account = Schema.Struct({
  id: Schema.String.check(Schema.isMinCodePoints(1)),
  aadObjectId: Schema.optional(settingsUUID),
  role: Schema.optional(Schema.String),
});

const timestamp = Schema.String.check(
  settingsPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z)$/,
  ),
).annotate({ format: "date-time" });

export const activitySchema = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(512),
  ),
  channelId: Schema.Literal("msteams"),
  serviceUrl: Schema.String.check(Schema.makeFilter(isAllowedServiceUrl)),
  from: account,
  recipient: account,
  conversation: Schema.Struct({
    id: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(1024),
    ),
    conversationType: Schema.Literals(["personal", "channel", "groupChat"]),
    tenantId: Schema.optional(settingsUUID),
  }),
  channelData: Schema.optional(
    Schema.Struct({
      tenant: Schema.optional(Schema.Struct({ id: settingsUUID })),
      channel: Schema.optional(Schema.Struct({ id: Schema.String })),
    }),
  ),
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        contentType: Schema.optional(Schema.String),
        contentUrl: Schema.optional(Schema.String),
      }),
    ),
  ),
  text: Schema.String.check(Schema.isMaxCodePoints(40_000)).pipe(
    settingsDefault(""),
  ),
  timestamp: Schema.optional(timestamp),
  entities: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          text: Schema.optional(Schema.String),
          mentioned: Schema.optional(account),
        }),
      ),
    ),
  ),
});

export type TeamsActivity = typeof activitySchema.Type;

function activityTenantMatches(activity: TeamsActivity, expected: string) {
  const conversation = activity.conversation.tenantId;
  const channel = activity.channelData?.tenant?.id;
  const tenant = expected.toLowerCase();

  return (
    (conversation !== undefined || channel !== undefined) &&
    (conversation === undefined || conversation.toLowerCase() === tenant) &&
    (channel === undefined || channel.toLowerCase() === tenant)
  );
}

export function allowedActivity(config: TeamsConfig, activity: TeamsActivity) {
  const user = activity.from.aadObjectId?.toLowerCase();
  const channel = activity.channelData?.channel?.id ?? activity.conversation.id;

  return Boolean(
    user &&
    (!config.fleetPolicy ||
      fleetAuthority(config.fleetPolicy, user) === "human") &&
    activityTenantMatches(activity, config.tenantId) &&
    activity.from.id !== activity.recipient.id &&
    activity.from.role !== "bot" &&
    config.access.users.some((id) => id.toLowerCase() === user) &&
    !config.access.deniedUsers.some((id) => id.toLowerCase() === user) &&
    !config.access.deniedChannels.includes(channel) &&
    (activity.conversation.conversationType === "personal" ||
      config.access.channels.includes(channel)),
  );
}

type Reference = {
  conversation: string;
  service: string;
  recipient: string;
  user: string;
  personal: number;
  scope: string;
};

type Approval = {
  token: string;
  request: string;
  session: string;
  conversation: string;
  user: string;
  input: string;
  expires: number;
  fingerprint: string;
  used: number;
  notified: number;
};

const permissionFingerprint = (request: PendingPermission) =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");

/** Authenticated intake and durable references; no approval text reaches a model. */
export class TeamsRegistration {
  public sourceRecorder: ((source: FleetSource) => void) | undefined;
  public readonly key: string;
  public readonly transport: GatewayTransport;
  public readonly delivery: TransportDelivery;
  private readonly db: Database;
  private readonly connector: Pick<ConnectorClient, "sendToConversation"> &
    Partial<Pick<ConnectorClient, "fetchImage">>;
  private server: Server | undefined;
  private socketIdentity: SocketIdentity | undefined;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  public constructor(
    public readonly config: TeamsConfig,
    path: string,
    private readonly store: Store,
    private readonly backend: AgentBackend,
    private readonly log: (message: string) => void,
    connector?: Pick<ConnectorClient, "sendToConversation"> &
      Partial<Pick<ConnectorClient, "fetchImage">>,
  ) {
    this.key = JSON.stringify([
      "teams",
      config.id,
      config.botClientId,
      config.tenantId,
      backendFingerprint(config),
    ]);
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.run(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS conversations(conversation TEXT PRIMARY KEY, service TEXT NOT NULL, recipient TEXT NOT NULL, user TEXT NOT NULL, personal INTEGER NOT NULL, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS approvals(token TEXT PRIMARY KEY, request TEXT NOT NULL UNIQUE, session TEXT NOT NULL, conversation TEXT NOT NULL, user TEXT NOT NULL, input TEXT NOT NULL, expires INTEGER NOT NULL, fingerprint TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0);",
    );

    // A pre-migration offer may have been delivered. Retrying its notification
    // Is harmless: it retains the same one-use token, and used rows stay used.
    if (
      !this.db
        .query<{ name: string }, []>("PRAGMA table_info(approvals)")
        .all()
        .some((column) => column.name === "notified")
    ) {
      this.db.run(
        "ALTER TABLE approvals ADD COLUMN notified INTEGER NOT NULL DEFAULT 0",
      );
    }

    this.connector =
      connector ??
      new ConnectorClient({
        tokenProvider: new ManagedIdentityTokenProvider({
          clientId: config.botClientId,
        }),
      });

    const presence =
      config.livePresence !== false ? new TeamsPresence() : undefined;

    this.transport = {
      ...(presence && {
        turnStatus: (job) =>
          !job.fleet &&
          !job.sender &&
          job.eventId === `${job.channel}:${job.thread}` &&
          job.received &&
          Math.abs(Date.now() - job.received) <= 120_000
            ? ("notice" as const)
            : ("quiet" as const),
      }),
      name: "teams",
      key: this.key,
      allowed: (user, channel) => this.allowed(user, channel),
      source: (job) => {
        const resultSource = fleetResultSource(job);

        if (resultSource) {
          return resultSource;
        }

        return {
          transport: "teams",
          channel: job.channel,
          thread: job.thread,
          message: job.eventId.slice(job.channel.length + 1),
          user: job.user,
          ...(this.sourceRecorder && {
            reference: fleetSourceReference(
              "teams",
              this.key,
              job.channel,
              job.eventId.slice(job.channel.length + 1),
            ),
          }),
          ...(config.fleetPolicy && { authority: "human" as const }),
        };
      },
      note: () => {},
      ...(config.fleetPolicy && {
        instructions: () =>
          config.fleetPolicy ? fleetInstructions(config.fleetPolicy) : "",
      }),
    };
    this.delivery = {
      ...(presence && {
        working: async (channel, thread, signal, allowed, mode, read) => {
          const ref = this.reference(channel);

          if (mode !== "notice" || !ref || !allowed) {
            return;
          }

          const active = () =>
            allowed() &&
            this.allowed(ref.user, channel) &&
            this.reference(channel)?.service === ref.service;

          // The same settings and captain override as Slack, read once
          // Per turn; an active turn keeps its initial values.
          const waiting = {
            ...(await resolveWaiting(config)),
            name: botDisplayName(config),
          };

          await presence.working(
            channel,
            thread,
            AbortSignal.any([signal, this.abort.signal]),
            active,
            read ?? (() => {}),
            async (activity, signal) => {
              if (!active()) {
                throw new Error("Teams presence no longer available");
              }

              return this.connector.sendToConversation(
                ref.service,
                channel,
                activity,
                { signal, retryServerErrors: false },
              );
            },
            waiting,
          );
        },
      }),
      files: teamsImageTransport(
        async (channel, _thread, activity, signal, allowed) => {
          const reference = this.reference(channel);

          if (
            !reference ||
            !this.allowed(reference.user, channel) ||
            (allowed && !allowed())
          ) {
            throw new Error("Teams image delivery access denied");
          }

          return this.connector.sendToConversation(
            reference.service,
            channel,
            activity,
            {
              signal: AbortSignal.any([signal, this.abort.signal]),
              retryServerErrors: false,
            },
          );
        },
        async (refs, channel, stop) => {
          const ref = this.reference(channel);

          if (
            !ref ||
            !this.allowed(ref.user, channel) ||
            !this.connector.fetchImage
          ) {
            throw new Error("Teams image unavailable");
          }

          const fetchImage = this.connector.fetchImage.bind(this.connector);

          const signal = AbortSignal.any([
            stop,
            this.abort.signal,
            AbortSignal.timeout(30_000),
          ]);

          return downloadImages(ref.service, refs, signal, (url, active) =>
            fetchImage(ref.service, url, active),
          );
        },
      ),
      post: async (channel, thread, text, _stop, unit) => {
        if (unit?.allowed && !(await unit.allowed())) {
          return;
        }

        if (
          presence &&
          unit &&
          "part" in unit &&
          unit.part === 0 &&
          this.store.jobByEvent(this.key, `${channel}:${thread}`)?.id ===
            unit.job
        ) {
          const ref = this.reference(channel);

          if (
            ref &&
            this.allowed(ref.user, channel) &&
            (await presence.final(
              channel,
              thread,
              { type: "message", text },
              this.abort.signal,
              (activity, signal) =>
                this.connector.sendToConversation(
                  ref.service,
                  channel,
                  activity,
                  { signal, retryServerErrors: false },
                ),
            ))
          ) {
            return;
          }
        }

        await this.send(channel, text, thread);
      },
      prepareReply: (text) =>
        chunkText(text, 12_000, TEAMS_MESSAGE_BYTE_BUDGET),
    };
  }
  private reference(conversation: string) {
    return this.db
      .query<Reference, [string]>(
        "SELECT * FROM conversations WHERE conversation=?",
      )
      .get(conversation);
  }
  private allowed(user: string, conversation: string) {
    const reference = this.reference(conversation);

    return Boolean(
      reference &&
      (reference.personal ||
        this.config.access.channels.includes(reference.scope)) &&
      this.config.access.users.some(
        (id) => id.toLowerCase() === user.toLowerCase(),
      ) &&
      !this.config.access.deniedUsers.some(
        (id) => id.toLowerCase() === user.toLowerCase(),
      ) &&
      !this.config.access.deniedChannels.includes(reference.scope),
    );
  }
  private async send(conversation: string, text: string, replyToId?: string) {
    const reference = this.reference(conversation);

    if (!reference || !this.allowed(reference.user, conversation)) {
      throw new Error("Teams conversation is unavailable");
    }

    const response = await this.connector.sendToConversation(
      reference.service,
      conversation,
      { type: "message", text, ...(replyToId && { replyToId }) },
      { signal: this.abort.signal, retryServerErrors: false },
    );

    return response.id;
  }
  public async accept(raw: unknown): Promise<boolean> {
    const parsed = Schema.decodeUnknownResult(activitySchema)(raw);

    if (
      Result.isFailure(parsed) ||
      !allowedActivity(this.config, parsed.success)
    ) {
      return false;
    }

    const activity = parsed.success;
    const user = activity.from.aadObjectId?.toLowerCase() ?? "";
    const conversation = activity.conversation.id;

    const files =
      this.config.incomingImages === false
        ? []
        : incomingImageRefs(activity.serviceUrl, activity.attachments);

    if (
      files.length > 0 &&
      activity.conversation.conversationType !== "personal" &&
      !activity.entities?.some(
        (entity) =>
          entity.type === "mention" &&
          entity.mentioned?.id === activity.recipient.id,
      )
    ) {
      return false;
    }

    const text = extractText({
      text: activity.text,
      recipient: { id: activity.recipient.id },
      entities: (activity.entities ?? []).map((entity) => ({
        ...(entity.type && { type: entity.type }),
        ...(entity.text && { text: entity.text }),
        ...(entity.mentioned && { mentioned: { id: entity.mentioned.id } }),
      })),
    });

    if (!text && files.length === 0) {
      return false;
    }

    this.db
      .query(
        "INSERT INTO conversations VALUES(?,?,?,?,?,?) ON CONFLICT(conversation) DO UPDATE SET service=excluded.service,recipient=excluded.recipient,user=excluded.user,personal=excluded.personal,scope=excluded.scope",
      )
      .run(
        conversation,
        activity.serviceUrl,
        activity.recipient.id,
        user,
        Number(activity.conversation.conversationType === "personal"),
        activity.channelData?.channel?.id ?? conversation,
      );

    if (/^\/?(?:approve|deny)\b/i.test(text)) {
      await this.approve(activity, text);

      return true;
    }

    if (this.sourceRecorder && this.config.fleetPolicy) {
      this.sourceRecorder({
        reference: fleetSourceReference(
          "teams",
          this.key,
          conversation,
          activity.id,
        ),
        transport: "teams",
        account: user,
        authority: fleetAuthority(this.config.fleetPolicy, user),
        text: activity.text,
        channel: conversation,
        messageID: activity.id,
        receivedAt: activity.timestamp ?? new Date().toISOString(),
        origin: { botKey: this.key, eventId: `${conversation}:${activity.id}` },
      });
    }

    this.store.enqueue({
      eventId: `${conversation}:${activity.id}`,
      botKey: this.key,
      conversation: JSON.stringify([this.key, conversation]),
      channel: conversation,
      thread: activity.id,
      ...(this.config.livePresence !== false && {
        received: activity.timestamp
          ? Date.parse(activity.timestamp)
          : Date.now(),
      }),
      user,
      text: text || "Inspect the attached screenshot.",
      files,
    });

    return true;
  }
  private async approve(activity: TeamsActivity, text: string) {
    const match = /^\/?(approve|deny) ([a-f0-9]{32})$/i.exec(text);
    const user = activity.from.aadObjectId?.toLowerCase() ?? "";

    if (
      !match ||
      activity.conversation.conversationType !== "personal" ||
      !this.config.approvalUsers.some((id) => id.toLowerCase() === user)
    ) {
      return;
    }

    const token = match[2];

    if (!token) {
      return;
    }

    const row = this.db
      .query<Approval, [string]>("SELECT * FROM approvals WHERE token=?")
      .get(token);

    if (
      !row ||
      row.used ||
      row.user !== user ||
      row.conversation !== activity.conversation.id ||
      row.expires <= Date.now() ||
      row.session !== this.backend.sessionID
    ) {
      return;
    }

    if (!this.backend.replyPermission || !(await this.currentApproval(row))) {
      return;
    }

    // Consume before the API call: an uncertain outcome can never replay approval.
    if (
      !this.db
        .query(
          "UPDATE approvals SET used=1 WHERE token=? AND used=0 AND expires>?",
        )
        .run(token, Date.now()).changes
    ) {
      return;
    }

    await this.backend.replyPermission(
      row.session,
      row.request,
      match[1]?.toLowerCase() === "approve" ? "once" : "reject",
      this.abort.signal,
    );
    await this.send(row.conversation, "Permission decision recorded.");
  }

  /** A notification and a decision require the same current native evidence. */
  private async currentApproval(
    row: Approval,
  ): Promise<PendingPermission | undefined> {
    const reference = this.reference(row.conversation);

    if (
      row.used ||
      row.expires <= Date.now() ||
      row.session !== this.backend.sessionID ||
      !reference?.personal ||
      reference.user !== row.user ||
      !this.config.approvalUsers.some((id) => id.toLowerCase() === row.user) ||
      !this.allowed(row.user, row.conversation)
    ) {
      return;
    }

    const pending = await this.backend.pendingPermissions?.(
      row.session,
      this.abort.signal,
    );

    const request = pending?.find(
      (request) =>
        request.id === row.request && request.sessionID === row.session,
    );

    if (!request || permissionFingerprint(request) !== row.fingerprint) {
      return;
    }

    if (
      !(await this.backend.permissionBelongsToInput?.(
        row.session,
        row.request,
        row.input,
        this.abort.signal,
      ))
    ) {
      return;
    }

    this.abort.signal.throwIfAborted();
    const owner = this.store.jobByInput(this.key, row.input);
    const currentReference = this.reference(row.conversation);

    if (
      owner?.status !== "running" ||
      owner.fleet?.kind === "result" ||
      owner.user !== row.user ||
      owner.channel !== row.conversation ||
      !currentReference?.personal ||
      currentReference.user !== row.user ||
      row.session !== this.backend.sessionID ||
      row.expires <= Date.now() ||
      !this.config.approvalUsers.some((id) => id.toLowerCase() === row.user) ||
      !this.allowed(row.user, row.conversation)
    ) {
      return;
    }

    return request;
  }
  public async pollApprovals() {
    const session = this.backend.sessionID;

    if (
      !session ||
      !this.backend.pendingPermissions ||
      !this.backend.permissionBelongsToInput
    ) {
      return;
    }

    for (const request of await this.backend.pendingPermissions(
      session,
      this.abort.signal,
    )) {
      if (request.sessionID !== session) {
        continue;
      }

      let owner:
        | { user: string; conversation: string; input: string }
        | undefined;

      for (const candidate of this.store.permissionCandidates(this.key)) {
        if (
          candidate.input &&
          candidate.fleet?.kind !== "result" &&
          this.config.approvalUsers.some(
            (id) => id.toLowerCase() === candidate.user,
          ) &&
          this.reference(candidate.channel)?.personal &&
          (await this.backend.permissionBelongsToInput(
            session,
            request.id,
            candidate.input,
            this.abort.signal,
          ))
        ) {
          owner = {
            user: candidate.user,
            conversation: candidate.channel,
            input: candidate.input,
          };
          break;
        }
      }

      if (!owner) {
        continue;
      }

      const offerOwner = owner;

      const row = this.db
        .transaction((): Approval | undefined => {
          const existing = this.db
            .query<Approval, [string]>(
              "SELECT * FROM approvals WHERE request=?",
            )
            .get(request.id);

          const fingerprint = permissionFingerprint(request);

          if (existing) {
            // A consumed token is a permanent tombstone, including uncertain API
            // Outcomes. A changed owner or request may never borrow an old offer.
            if (
              existing.used ||
              existing.session !== session ||
              existing.user !== offerOwner.user ||
              existing.conversation !== offerOwner.conversation ||
              existing.input !== offerOwner.input ||
              existing.fingerprint !== fingerprint
            ) {
              return;
            }

            if (existing.expires > Date.now()) {
              return existing;
            }

            const token = randomBytes(16).toString("hex");
            const expires = Date.now() + this.config.approvalTTLms;
            this.db
              .query(
                "UPDATE approvals SET token=?,expires=?,notified=0 WHERE token=? AND used=0",
              )
              .run(token, expires, existing.token);

            return { ...existing, token, expires, notified: 0 };
          }

          const fresh: Approval = {
            token: randomBytes(16).toString("hex"),
            request: request.id,
            session,
            conversation: offerOwner.conversation,
            user: offerOwner.user,
            input: offerOwner.input,
            expires: Date.now() + this.config.approvalTTLms,
            fingerprint,
            used: 0,
            notified: 0,
          };

          this.db
            .query(
              "INSERT INTO approvals(token,request,session,conversation,user,input,expires,fingerprint,used,notified) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              fresh.token,
              fresh.request,
              fresh.session,
              fresh.conversation,
              fresh.user,
              fresh.input,
              fresh.expires,
              fresh.fingerprint,
              fresh.used,
              fresh.notified,
            );

          return fresh;
        })
        .immediate();

      if (!row || row.notified) {
        continue;
      }

      const current = await this.currentApproval(row);

      const live = this.db
        .query<Approval, [string]>("SELECT * FROM approvals WHERE token=?")
        .get(row.token);

      if (
        !current ||
        !live ||
        live.used ||
        live.notified ||
        live.expires <= Date.now()
      ) {
        continue;
      }

      // Tool arguments and provider errors may contain secrets; publish only action.
      await this.send(
        row.conversation,
        `OpenCode requests ${current.action.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80)}. Reply approve ${row.token} or deny ${row.token}. Valid once for ${Math.max(1, Math.ceil((row.expires - Date.now()) / 1000))} seconds.`,
      );
      this.db
        .query("UPDATE approvals SET notified=1 WHERE token=? AND used=0")
        .run(row.token);
    }
  }
  public async start(open: () => boolean) {
    const keyStore = new BotFrameworkKeyStore();
    this.server = createTeamsListener({
      verifyToken: (authorization) =>
        verifyBotFrameworkToken(authorization, {
          keyStore,
          appId: this.config.botClientId,
        }),
      checkActivity: (token, activity) => {
        checkActivityBinding(token, {
          serviceUrl: activity["serviceUrl"],
          channelId: activity["channelId"],
        });
      },
      onActivity: async (activity) => {
        if (!open()) {
          throw new Error("Teams intake stopped");
        }

        await this.accept(activity);
      },
      log: this.log,
    });
    this.socketIdentity = await listenOnUnixSocket(
      this.server,
      this.config.socketPath,
      { signal: this.abort.signal },
    );
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        await this.pollApprovals().catch(() => {
          this.log("Teams permission check unavailable");
        });
        await delay(1000, undefined, { signal: this.abort.signal }).catch(
          () => {},
        );
      }
    })();
  }
  public async close() {
    this.abort.abort();
    const server = this.server;

    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }

    unlinkOwnSocket(this.config.socketPath, this.socketIdentity);
    await this.loop;
    this.db.close();
  }
}
