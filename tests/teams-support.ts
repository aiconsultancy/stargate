import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { AgentBackend, PendingPermission } from "../src/backend";
import { teamsSchema } from "../src/config";
import { Store } from "../src/store";
import {
  BOT_FRAMEWORK_ISSUER,
  BOT_FRAMEWORK_OPENID_URL,
} from "../src/teams/botframework-auth";
import type { ConnectorClient, OutgoingActivity } from "../src/teams/connector";
import {
  type TeamsActivity,
  TeamsRegistration,
} from "../src/teams/registration";

export const APP_ID = "11111111-2222-4333-8444-555555555555";
export const TENANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const HUMAN = "99999999-8888-4777-8666-555555555555";
export const OTHER_HUMAN = "12345678-1234-4234-8234-123456789abc";
export const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
export const JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";

export function activity(
  overrides: Partial<TeamsActivity> = {},
): TeamsActivity {
  return {
    type: "message",
    id: "message-1",
    serviceUrl: SERVICE_URL,
    channelId: "msteams",
    from: { id: "29:human", aadObjectId: HUMAN },
    recipient: { id: `28:${APP_ID}` },
    conversation: {
      id: "a:personal-chat-1",
      conversationType: "personal",
      tenantId: TENANT_ID,
    },
    channelData: { tenant: { id: TENANT_ID } },
    text: "Inspect the repository",
    ...overrides,
  };
}

export class TeamsBackend implements AgentBackend {
  sessionID = "session-1";
  pending: PendingPermission[] = [];
  bindings = new Map<string, string>();
  replies: { session: string; request: string; decision: "once" | "reject" }[] =
    [];
  failReply = false;
  async createSession() {
    return this.sessionID;
  }
  async prompt(): Promise<string> {
    throw new Error("Tests do not call a model");
  }
  async close() {}
  async pendingPermissions() {
    return this.pending;
  }
  async permissionBelongsToInput(
    session: string,
    request: string,
    input: string,
  ) {
    return session === this.sessionID && this.bindings.get(request) === input;
  }
  async replyPermission(
    session: string,
    request: string,
    decision: "once" | "reject",
  ) {
    this.replies.push({ session, request, decision });
    if (this.failReply) throw new Error("Uncertain provider outcome");
  }
  permission(input = "native-human-input") {
    const request = {
      id: "permission-1",
      sessionID: this.sessionID,
      action: "bash",
      resources: ["private tool arguments must not reach chat"],
    };
    this.pending = [request];
    this.bindings.set(request.id, input);
    return request;
  }
}

export function registrationFixture(
  options: {
    approvals?: boolean;
    fleet?: boolean;
    presence?: boolean;
    agent?: string;
    displayName?: string;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "sg-teams-"));
  const storePath = join(directory, "queue.sqlite");
  const path = join(directory, "teams.sqlite");
  const config = Schema.decodeUnknownSync(teamsSchema)({
    id: "test-admiral",
    livePresence: options.presence === true,
    botClientId: APP_ID,
    tenantId: TENANT_ID,
    socketPath: join(directory, "bridge.sock"),
    access: { users: [HUMAN, OTHER_HUMAN], channels: ["allowed-channel"] },
    backend: {
      type: "opencode",
      url: "http://127.0.0.1:4096",
      directory,
      ...(options.agent ? { agent: options.agent } : {}),
    },
    ...(options.displayName ? { displayName: options.displayName } : {}),
    ...(options.approvals ? { approvalUsers: [HUMAN, OTHER_HUMAN] } : {}),
    ...(options.fleet
      ? {
          fleetPolicy: {
            role: "rear_admiral",
            humanAccounts: [HUMAN],
            agentAccounts: ["captain"],
            assignedCheckout: directory,
            capabilities: ["read_code", "subspace", "dispatch"],
          },
        }
      : {}),
  });
  const backend = new TeamsBackend();
  const sent: {
    service: string;
    conversation: string;
    activity: OutgoingActivity;
  }[] = [];
  const connector: Pick<ConnectorClient, "sendToConversation"> = {
    async sendToConversation(service, conversation, message) {
      sent.push({ service, conversation, activity: message });
      return { id: `reply-${sent.length}` };
    },
  };
  let store = new Store(storePath);
  let registration = new TeamsRegistration(
    config,
    path,
    store,
    backend,
    () => {},
    connector,
  );
  return {
    config,
    backend,
    sent,
    get store() {
      return store;
    },
    get registration() {
      return registration;
    },
    async running(message = activity(), input = "native-human-input") {
      await registration.accept(message);
      const job = store
        .ready(registration.key, Date.now(), 100)
        .find(
          (job) => job.eventId === `${message.conversation.id}:${message.id}`,
        );
      if (!job) throw new Error("Fixture activity was not queued");
      store.running(job.id);
      store.saveInput(registration.key, job.id, input, backend.sessionID);
      return { ...job, input, status: "running" as const };
    },
    async reopen() {
      await registration.close();
      store.close();
      store = new Store(storePath);
      registration = new TeamsRegistration(
        config,
        path,
        store,
        backend,
        () => {},
        connector,
      );
    },
    async close() {
      await registration.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
    approvalToken() {
      const text = sent.find((call) =>
        call.activity.text?.includes("Reply approve"),
      )?.activity.text;
      const token = /approve ([a-f0-9]{32})/.exec(text ?? "")?.[1];
      if (!token) throw new Error("No approval was offered");
      return token;
    },
  };
}

export type SigningKeyPair = {
  privateKey: CryptoKey;
  jwk: JWK & { kid: string; endorsements: string[] };
};
export async function makeSigningKey(
  kid = "test-key",
  endorsements = ["msteams"],
): Promise<SigningKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  return {
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, use: "sig", endorsements },
  };
}
export async function signToken(
  key: SigningKeyPair,
  overrides: Record<string, unknown> = {},
  header: { alg?: string; kid?: string } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: BOT_FRAMEWORK_ISSUER,
    aud: APP_ID,
    serviceurl: SERVICE_URL,
    nbf: now - 60,
    exp: now + 3600,
    ...overrides,
  };
  for (const name of Object.keys(claims))
    if (claims[name] === undefined) delete claims[name];
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: header.alg ?? "RS256",
      kid: header.kid ?? key.jwk.kid,
      typ: "JWT",
    })
    .sign(key.privateKey);
}
export function unsignedToken() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ iss: BOT_FRAMEWORK_ISSUER, aud: APP_ID, exp: now + 3600 })}.`;
}
export type FetchCall = { url: string; redirect?: RequestRedirect | undefined };
type Route = (
  url: URL,
  call: FetchCall,
) => Response | undefined | Promise<Response | undefined>;
export function mockFetch(route: Route) {
  const calls: FetchCall[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const call = { url: url.href, redirect: init.redirect };
    calls.push(call);
    return (
      (await route(url, call)) ?? new Response("not found", { status: 404 })
    );
  };
  return { fetch: fetchFn as typeof fetch, calls };
}
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
export function botFrameworkKeys(keys: Record<string, unknown>[]): Route {
  return (url) => {
    if (url.href === BOT_FRAMEWORK_OPENID_URL)
      return json({
        issuer: BOT_FRAMEWORK_ISSUER,
        jwks_uri: JWKS_URL,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (url.href === JWKS_URL) return json({ keys });
    return undefined;
  };
}
