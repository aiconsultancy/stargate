import { createServer, type Server } from "node:http";
import { z } from "zod";
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
  type FleetCompletion,
  type FleetControlConfig,
  FleetError,
  type FleetOrigin,
  type FleetRequest,
  type FleetReviewNative,
  type FleetSource,
  type FleetTarget,
  fleetAssignmentText,
  fleetControlSchema,
  requestSchema,
  reviewRepositorySchema,
  type VerifiedSource,
} from "./protocol";
import { FleetReviews, reviewContextPrompt } from "./reviews";

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
  ): Promise<void> | Promise<FleetOrigin>;
  send(target: FleetTarget, text: string, signal: AbortSignal): Promise<void>;
  status?(): Promise<unknown> | unknown;
  /** Resolve the immutable authenticated ingress job and native input locally. */
  origin?(source: VerifiedSource): FleetOrigin | undefined;
  /** Transport test seam; production uses the kernel startup lock. */
  ownership?: Ownership;
  nativeReviews?: FleetReviewNative;
};

export class FleetControl {
  private readonly permissions: readonly FleetPermissionRule[];
  private readonly ledger: FleetLedger;
  private server: Server | undefined;
  private identity: SocketIdentity | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly stop = new AbortController();
  private closed = false;
  private readonly reviews: FleetReviews | undefined;
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
    if (options.config.reviews && !options.nativeReviews)
      throw new FleetError("Native review backend unavailable");
    this.ledger = new FleetLedger(options.config.statePath);
    if (options.config.reviews) {
      if (!options.nativeReviews)
        throw new FleetError("Native review backend unavailable");
      this.reviews = new FleetReviews({
        ledger: this.ledger,
        config: options.config.reviews,
        sessionID: options.sessionID,
        ship: options.account,
        native: options.nativeReviews,
      });
    }
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

  get resultsEnabled() {
    return this.options.config.results === true;
  }
  reviewAssignmentPrompt(dispatchID: string): string | undefined {
    if (!this.reviews) return;
    const assignment = this.ledger.reviewContext(
      this.options.sessionID,
      this.options.account,
      dispatchID,
    );
    if (!assignment) return;
    if (
      !this.options.config.reviews?.repositories.includes(
        assignment.context.repository,
      )
    )
      throw new FleetError("Review repository is not permitted");
    return reviewContextPrompt(assignment.context, assignment.text);
  }
  async pollReviews(signal: AbortSignal) {
    await this.reviews?.poll(signal);
  }

  assignment(
    input: {
      sender: string;
      channel: string;
      text: string;
      botKey: string;
      eventId: string;
    },
    fold: (value: string) => string,
  ) {
    return this.resultsEnabled
      ? this.ledger.assignment(
          {
            ...input,
            sessionID: this.options.sessionID,
            account: this.options.account,
          },
          fold,
        )
      : undefined;
  }

  delegation(dispatchID: string) {
    return this.resultsEnabled
      ? this.ledger.delegation(
          this.options.sessionID,
          this.options.account,
          dispatchID,
        )
      : undefined;
  }

  complete(botKey: string, eventId: string, completion: FleetCompletion) {
    if (!this.resultsEnabled)
      throw new FleetError("Fleet results are disabled");
    this.ledger.complete(
      this.options.sessionID,
      this.options.account,
      botKey,
      eventId,
      completion,
    );
  }

  bindInput(
    botKey: string,
    eventId: string,
    dispatchID: string,
    inputID: string,
  ) {
    if (!this.resultsEnabled)
      throw new FleetError("Fleet results are disabled");
    this.ledger.bindInput(
      this.options.sessionID,
      this.options.account,
      botKey,
      eventId,
      dispatchID,
      inputID,
    );
  }

  pendingResults() {
    return this.resultsEnabled
      ? this.ledger.pendingResults(this.options.sessionID)
      : [];
  }
  acknowledgeResult(dispatchID: string) {
    this.ledger.acknowledgeResult(this.options.sessionID, dispatchID);
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
    if (
      input.review &&
      (!this.reviews ||
        !this.options.config.reviews?.repositories.includes(
          input.review.repository,
        ))
    )
      throw new FleetError(
        "Review evidence is disabled or repository is not permitted",
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
    const origin = this.resultsEnabled
      ? this.options.origin?.(source)
      : undefined;
    if (
      this.resultsEnabled &&
      (!origin ||
        !source.origin ||
        origin.botKey !== source.origin.botKey ||
        origin.eventId !== source.origin.eventId)
    )
      throw new FleetError(
        "Fleet result origin has no retained ingress job/native input",
      );
    const reserved = this.ledger.reserve({
      ownerSessionID: caller.sessionID,
      requestID: input.requestID ?? caller.id,
      source,
      target,
      senderAccount: this.options.account,
      text: input.text,
      ...(origin ? { origin } : {}),
      ...(input.review ? { review: input.review } : {}),
    });
    if (!reserved.created) return reserved.result;
    // This label reports real transport identity and immutable evidence. Rank,
    // delegated evidence and a human source never grant human approval authority.
    const text = fleetAssignmentText(
      reserved.result,
      input.text,
      source.authority,
    );
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
          if (request.method === "GET" && request.url?.startsWith("/reviews")) {
            if (!this.reviews) {
              sendJson(response, 404, { error: "Not found" });
              return;
            }
            const url = new URL(request.url, "http://fleet.local");
            const match = /^\/reviews\/(proof_[a-f0-9]{32})$/.exec(
              url.pathname,
            );
            if (match && !url.search) {
              const proof = this.ledger.reviewProof(
                match[1] ?? "",
                this.options.account,
              );
              if (
                !proof ||
                !this.options.config.reviews?.repositories.includes(
                  proof.repository,
                )
              )
                sendJson(response, 404, { error: "Review proof unavailable" });
              else sendJson(response, 200, { proof });
              return;
            }
            if (url.pathname !== "/reviews") {
              sendJson(response, 404, { error: "Not found" });
              return;
            }
            const keys = [...url.searchParams.keys()];
            if (
              keys.length !== 3 ||
              new Set(keys).size !== 3 ||
              keys.some(
                (k) => !["repository", "pullRequest", "headSHA"].includes(k),
              )
            )
              throw new FleetError("Invalid review proof lookup");
            const target = z
              .strictObject({
                repository: reviewRepositorySchema,
                pullRequest: z
                  .string()
                  .regex(/^[1-9][0-9]*$/)
                  .transform(Number)
                  .pipe(z.number().int().positive().safe()),
                headSHA: z.string().regex(/^[a-f0-9]{40}$/),
              })
              .parse(Object.fromEntries(url.searchParams));
            const proofs = this.options.config.reviews?.repositories.includes(
              target.repository,
            )
              ? this.ledger.reviewProofs(this.options.account, target)
              : [];
            sendJson(response, 200, { proofs });
            return;
          }
          if (request.method !== "POST" || request.url !== "/fleet") {
            sendJson(response, 404, { error: "Not found" });
            return;
          }
          const parsed = requestSchema.safeParse(
            JSON.parse(
              await readBody(request, this.reviews ? 1_000_000 : 32_768),
            ),
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
          const nativeOrigin = await this.options.authorize(
            value.caller,
            signal,
            value,
          );
          signal.throwIfAborted();
          const result =
            value.operation === "review"
              ? !this.reviews
                ? (() => {
                    throw new FleetError("Review evidence is disabled");
                  })()
                : value.input.op === "start"
                  ? await this.reviews.start(
                      value.input,
                      nativeOrigin ?? undefined,
                      value.caller.agent,
                      signal,
                    )
                  : {
                      proof:
                        this.ledger.reviewProof(
                          value.input.id,
                          this.options.account,
                        ) ?? null,
                      humanApproval: false,
                    }
              : value.operation === "verify"
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
