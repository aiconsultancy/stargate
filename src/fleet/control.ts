import { createServer, type Server } from "node:http";
import { close, readBody, sendJson } from "../teams/http-util";
import {
  listenOnUnixSocket,
  type Ownership,
  type SocketIdentity,
  unlinkOwnSocket,
} from "../teams/unix-socket";
import { FleetLedger } from "./ledger";
import {
  type FleetPermissionRule,
  fleetRequestAllowed,
  validateFleetPermissions,
} from "./permissions";
import {
  type DispatchInput,
  type FleetCaller,
  type FleetControlConfig,
  FleetError,
  type FleetRequest,
  type FleetSource,
  type FleetTarget,
  fleetControlSchema,
  requestSchema,
} from "./protocol";

export type FleetControlOptions = {
  config: FleetControlConfig;
  /** One immutable native root pin and actual transport identity per socket. */
  sessionID: string;
  account: string;
  /** Trusted gateway policy, independent of anything the engine reports. */
  permissions: readonly FleetPermissionRule[];
  /** Gateway policy capability; absent means dispatch is disabled. */
  allowDispatch?: boolean;
  /** Verify retained native assistant/tool ancestry, never the latest sender. */
  authorize(
    caller: FleetCaller,
    signal: AbortSignal,
    request: FleetRequest,
  ): Promise<void>;
  send(target: FleetTarget, text: string, signal: AbortSignal): Promise<void>;
  status?(): Promise<unknown> | unknown;
  /** Transport test seam; production uses the kernel startup lock. */
  ownership?: Ownership;
};

export class FleetControl {
  private readonly permissions: readonly FleetPermissionRule[];
  private readonly ledger: FleetLedger;
  private server: Server | undefined;
  private identity: SocketIdentity | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly stop = new AbortController();
  private closed = false;
  private constructor(private readonly options: FleetControlOptions) {
    validateFleetPermissions(options.permissions);
    this.permissions = options.permissions.map((rule) => ({ ...rule }));
    fleetControlSchema.parse(options.config);
    if (
      !options.sessionID ||
      !options.account ||
      /[\s\p{Cc}]/u.test(options.account)
    )
      throw new FleetError(
        "Fleet control requires a pinned session and actual account.",
      );
    this.ledger = new FleetLedger(options.config.statePath);
  }

  static async open(options: FleetControlOptions) {
    const control = new FleetControl(options);
    try {
      await control.listen();
      return control;
    } catch (error) {
      await control.close();
      throw error;
    }
  }

  /** Only authenticated gateway intake calls this; it is never an IPC operation. */
  recordSource(source: FleetSource) {
    return this.ledger.record(this.options.sessionID, source);
  }

  private async dispatch(
    input: DispatchInput,
    caller: FleetCaller,
    signal: AbortSignal,
  ) {
    if (!this.options.allowDispatch)
      throw new FleetError(
        "Fleet dispatch is disabled by this gateway's capability policy.",
      );
    const target = this.options.config.targets.find(
      (entry) => entry.id === input.target,
    );
    if (!target)
      throw new FleetError("Fleet dispatch target is not configured.");
    const source = this.ledger.verify(caller.sessionID, input.sourceReference);
    if (source.authority === "context")
      throw new FleetError(
        "Context-only messages cannot authorise fleet assignments.",
      );
    const reserved = this.ledger.reserve({
      ownerSessionID: caller.sessionID,
      requestID: input.requestID ?? caller.id,
      source,
      target,
      senderAccount: this.options.account,
      text: input.text,
    });
    if (!reserved.created) return reserved.result;
    // This label reports real transport identity and immutable evidence. Rank,
    // delegated evidence and a human source never grant human approval authority.
    const text = `[fleet_dispatch from=${this.options.account} source=${source.reference} authority=${source.authority}; not human approval] ${target.account}: ${input.text}`;
    try {
      signal.throwIfAborted();
      await this.options.send(target, text, signal);
      signal.throwIfAborted();
      return this.ledger.sent(caller.sessionID, reserved.result);
    } catch {
      // The external write may have happened. The durable reservation remains
      // unknown, including after a process crash; this ID can never resend.
      return reserved.result;
    }
  }

  private async listen() {
    const server = createServer((request, response) => {
      const operation = (async () => {
        const disconnected = new AbortController();
        request.once("aborted", () => disconnected.abort());
        response.once("close", () => {
          if (!response.writableEnded) disconnected.abort();
        });
        const signal = AbortSignal.any([
          this.stop.signal,
          disconnected.signal,
          AbortSignal.timeout(20_000),
        ]);
        try {
          if (request.method !== "POST" || request.url !== "/fleet") {
            sendJson(response, 404, { error: "Not found" });
            return;
          }
          const parsed = requestSchema.safeParse(
            JSON.parse(await readBody(request, 32_768)),
          );
          if (!parsed.success)
            throw new FleetError("Invalid fleet tool request.");
          const value = parsed.data;
          if (value.caller.sessionID !== this.options.sessionID)
            throw new FleetError(
              "Fleet tool caller does not match this gateway's native session pin.",
            );
          signal.throwIfAborted();
          if (!fleetRequestAllowed(this.permissions, value))
            throw new FleetError(
              "Trusted gateway policy refuses this fleet operation.",
            );
          await this.options.authorize(value.caller, signal, value);
          signal.throwIfAborted();
          const result =
            value.operation === "verify"
              ? this.ledger.verify(
                  value.caller.sessionID,
                  value.input.reference,
                )
              : value.operation === "dispatch"
                ? await this.dispatch(value.input, value.caller, signal)
                : value.input.requestID
                  ? (this.ledger.dispatch(
                      value.caller.sessionID,
                      value.input.requestID,
                    ) ?? { state: "not_found", humanApproval: false })
                  : {
                      account: this.options.account,
                      targets: this.options.config.targets,
                      humanApproval: false,
                      ...(this.options.status
                        ? { transport: await this.options.status() }
                        : {}),
                    };
          sendJson(response, 200, { result });
        } catch (error) {
          sendJson(response, 400, {
            error:
              error instanceof FleetError
                ? error.message
                : "Fleet operation unavailable; raw details withheld.",
          });
        }
      })();
      this.pending.add(operation);
      void operation.then(
        () => this.pending.delete(operation),
        () => this.pending.delete(operation),
      );
    });
    this.server = server;
    this.identity = await listenOnUnixSocket(
      server,
      this.options.config.socketPath,
      this.options.ownership,
    );
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stop.abort();
    if (this.server) await close(this.server);
    await Promise.allSettled(this.pending);
    unlinkOwnSocket(
      this.options.config.socketPath,
      this.identity,
      this.options.ownership,
    );
    this.identity = undefined;
    this.ledger.close();
  }
}
