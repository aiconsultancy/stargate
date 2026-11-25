import { type Server, createServer } from "node:http";
import { Result, Schema, SchemaTransformation } from "effect";
import { settingsPattern, settingsStruct } from "../../config/settings-schema";
import { close, readBody, sendJson } from "../../lib/http-util";
import {
  type Ownership,
  type SocketIdentity,
  listenOnUnixSocket,
  unlinkOwnSocket,
} from "../../lib/unix-socket";
import { FleetLedger } from "./ledger";
import {
  type FleetPermissionRule,
  fleetRequestAllowed,
  validateFleetPermissions,
} from "./permissions";
import {
  type DispatchInput,
  type DispatchOffer,
  type FleetCaller,
  type FleetCompletion,
  type FleetControlConfig,
  FleetError,
  type FleetOrigin,
  type FleetRequest,
  type FleetReviewNative,
  type FleetSource,
  type FleetTarget,
  type OfferAnswerInput,
  type PeerMessageInput,
  type VerifiedSource,
  fleetAssignmentText,
  fleetControlSchema,
  requestSchema,
  reviewRepositorySchema,
} from "./protocol";
import { reviewContextPrompt } from "./review-prompts";
import { FleetReviews } from "./reviews";

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
  /** Agent dispatch: send this captain's answer as a reply to the offer. */
  answer?(
    offer: DispatchOffer,
    answer: OfferAnswerInput["answer"],
    reason: string | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  peerMessage?(
    target: FleetTarget,
    input: PeerMessageInput,
    signal: AbortSignal,
  ): Promise<string>;
  status?(): unknown;
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
    Schema.decodeUnknownSync(fleetControlSchema)(options.config);

    if (
      !options.sessionID ||
      !options.account ||
      /[\s\p{Cc}]/u.test(options.account)
    ) {
      throw new FleetError(
        "Fleet control requires a pinned session and actual account.",
      );
    }

    if (options.config.reviews && !options.nativeReviews) {
      throw new FleetError("Native review backend unavailable");
    }

    this.ledger = new FleetLedger(options.config.statePath);

    if (options.config.reviews) {
      if (!options.nativeReviews) {
        throw new FleetError("Native review backend unavailable");
      }

      this.reviews = new FleetReviews({
        ledger: this.ledger,
        config: options.config.reviews,
        sessionID: options.sessionID,
        ship: options.account,
        native: options.nativeReviews,
      });
    }
  }

  public static async open(options: FleetControlOptions) {
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
  public recordSource(source: FleetSource) {
    return this.ledger.record(this.options.sessionID, source);
  }

  /** Authenticated IRC intake only: an offer addressed to this captain. */
  public recordOffer(offer: Omit<DispatchOffer, "account">) {
    this.ledger.recordOffer({ ...offer, account: this.options.account });
  }

  /**
   * The answer tool. Only an offer this gateway's intake recorded for its
   * own account can be answered, once; repeating the same answer resends
   * nothing. The rear admiral decides what the answer means.
   */
  private async answerOffer(input: OfferAnswerInput, signal: AbortSignal) {
    const recorded = this.ledger.dispatchOffer(
      this.options.account,
      input.offerID,
    );

    if (!recorded || recorded.received < Date.now() - 24 * 3_600_000) {
      throw new FleetError(
        "No current offer with this ID was addressed to this captain.",
      );
    }

    const result = {
      offerID: input.offerID,
      answer: input.answer,
      state: "sent" as const,
      note: "The rear admiral confirms in the channel. Accepting asks it to assign the issue to you; it is not human approval.",
      humanApproval: false as const,
    };

    if (recorded.answer === input.answer) {
      return { ...result, repeated: true };
    }

    if (recorded.answer !== null) {
      throw new FleetError("This offer already has a different answer.");
    }

    if (!this.options.answer) {
      throw new FleetError("Offer answers are unavailable on this gateway.");
    }

    try {
      await this.options.answer(
        recorded.offer,
        input.answer,
        input.reason,
        signal,
      );
    } catch {
      throw new FleetError(
        "Answer delivery is unconfirmed; check the channel before answering again.",
      );
    }

    this.ledger.answerOffer(this.options.account, input.offerID, input.answer);

    return result;
  }

  public get resultsEnabled() {
    return this.options.config.results === true;
  }
  public reviewAssignmentPrompt(dispatchID: string): string | undefined {
    if (!this.reviews) {
      return;
    }

    const assignment = this.ledger.reviewContext(
      this.options.sessionID,
      this.options.account,
      dispatchID,
    );

    if (!assignment) {
      return;
    }

    if (
      !this.options.config.reviews?.repositories.includes(
        assignment.context.repository,
      )
    ) {
      throw new FleetError("Review repository is not permitted");
    }

    return reviewContextPrompt(assignment.context, assignment.text);
  }
  public async pollReviews(signal: AbortSignal) {
    await this.reviews?.poll(signal);
  }

  public assignment(
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

  public delegation(dispatchID: string) {
    return this.resultsEnabled
      ? this.ledger.delegation(
          this.options.sessionID,
          this.options.account,
          dispatchID,
        )
      : undefined;
  }

  public complete(
    botKey: string,
    eventId: string,
    completion: FleetCompletion,
  ) {
    if (!this.resultsEnabled) {
      throw new FleetError("Fleet results are disabled");
    }

    this.ledger.complete(
      this.options.sessionID,
      this.options.account,
      botKey,
      eventId,
      completion,
    );
  }

  public bindInput(
    botKey: string,
    eventId: string,
    dispatchID: string,
    inputID: string,
  ) {
    if (!this.resultsEnabled) {
      throw new FleetError("Fleet results are disabled");
    }

    this.ledger.bindInput(
      this.options.sessionID,
      this.options.account,
      botKey,
      eventId,
      dispatchID,
      inputID,
    );
  }

  public pendingResults() {
    return this.resultsEnabled
      ? this.ledger.pendingResults(this.options.sessionID)
      : [];
  }
  public acknowledgeResult(dispatchID: string) {
    this.ledger.acknowledgeResult(this.options.sessionID, dispatchID);
  }

  private resultOrigin(source: VerifiedSource) {
    if (!this.resultsEnabled) {
      return;
    }

    const origin = this.options.origin?.(source);

    if (
      !origin ||
      !source.origin ||
      origin.botKey !== source.origin.botKey ||
      origin.eventId !== source.origin.eventId
    ) {
      throw new FleetError(
        "Fleet result origin has no retained ingress job/native input",
      );
    }

    return origin;
  }

  private async dispatch(
    input: DispatchInput,
    caller: FleetCaller,
    signal: AbortSignal,
  ) {
    if (!this.options.allowDispatch) {
      throw new FleetError(
        "Fleet dispatch is disabled by this gateway's capability policy.",
      );
    }

    if (
      input.review &&
      (!this.reviews ||
        !this.options.config.reviews?.repositories.includes(
          input.review.repository,
        ))
    ) {
      throw new FleetError(
        "Review evidence is disabled or repository is not permitted",
      );
    }

    const target = this.options.config.targets.find(
      (entry) => entry.id === input.target,
    );

    if (!target) {
      throw new FleetError("Fleet dispatch target is not configured.");
    }

    const source = this.ledger.verify(caller.sessionID, input.sourceReference);

    if (source.authority === "context") {
      throw new FleetError(
        "Context-only messages cannot authorise fleet assignments.",
      );
    }

    const origin = this.resultOrigin(source);

    const reserved = this.ledger.reserve({
      ownerSessionID: caller.sessionID,
      requestID: input.requestID ?? caller.id,
      source,
      target,
      senderAccount: this.options.account,
      text: input.text,
      ...(origin && { origin }),
      ...(input.review && { review: input.review }),
    });

    if (!reserved.created) {
      return reserved.result;
    }

    // This label reports real transport identity and immutable evidence. Rank,
    // Delegated evidence and a human source never grant human approval authority.
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
      // Unknown, including after a process crash; this ID can never resend.
      return reserved.result;
    }
  }

  private async listen() {
    const server = createServer((request, response) => {
      const operation = (async () => {
        const disconnected = new AbortController();
        request.once("aborted", () => {
          disconnected.abort();
        });
        response.once("close", () => {
          if (!response.writableEnded) {
            disconnected.abort();
          }
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
              ) {
                sendJson(response, 404, { error: "Review proof unavailable" });
              } else {
                sendJson(response, 200, { proof });
              }

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
            ) {
              throw new FleetError("Invalid review proof lookup");
            }

            const target = Schema.decodeUnknownSync(
              settingsStruct({
                repository: reviewRepositorySchema,
                pullRequest: Schema.String.check(
                  settingsPattern(/^[1-9][0-9]*$/),
                ).pipe(
                  Schema.decodeTo(
                    Schema.Int.check(Schema.isGreaterThan(0)),
                    SchemaTransformation.transform({
                      decode: Number,
                      encode: String,
                    }),
                  ),
                ),
                headSHA: Schema.String.check(settingsPattern(/^[a-f0-9]{40}$/)),
              }),
            )(Object.fromEntries(url.searchParams));

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

          const parsed = Schema.decodeUnknownResult(requestSchema)(
            JSON.parse(
              await readBody(request, this.reviews ? 1_000_000 : 32_768),
            ),
          );

          if (Result.isFailure(parsed)) {
            throw new FleetError("Invalid fleet tool request.");
          }

          const value = parsed.success;

          if (value.caller.sessionID !== this.options.sessionID) {
            throw new FleetError(
              "Fleet tool caller does not match this gateway's native session pin.",
            );
          }

          signal.throwIfAborted();

          if (!fleetRequestAllowed(this.permissions, value)) {
            throw new FleetError(
              "Trusted gateway policy refuses this fleet operation.",
            );
          }

          const nativeOrigin = await this.options.authorize(
            value.caller,
            signal,
            value,
          );

          signal.throwIfAborted();

          if (value.operation === "peer-message") {
            const target = this.options.config.targets.find(
              (entry) =>
                entry.id === value.input.to && entry.role === "captain",
            );

            if (
              !this.options.peerMessage ||
              !target ||
              target.account === this.options.account
            ) {
              throw new FleetError(
                "Peer messaging requires a configured remote captain.",
              );
            }

            const channel = await this.options.peerMessage(
              target,
              value.input,
              signal,
            );

            sendJson(response, 200, {
              result: {
                channel,
                target: target.id,
                state: "sent",
                humanApproval: false,
              },
            });

            return;
          }

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
                  : value.operation === "answer"
                    ? await this.answerOffer(value.input, signal)
                    : value.input.requestID
                      ? (this.ledger.dispatch(
                          value.caller.sessionID,
                          value.input.requestID,
                        ) ?? { state: "not_found", humanApproval: false })
                      : {
                          account: this.options.account,
                          targets: this.options.config.targets,
                          humanApproval: false,
                          ...(this.options.status && {
                            transport: await this.options.status(),
                          }),
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

  public async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stop.abort();

    if (this.server) {
      await close(this.server);
    }

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
