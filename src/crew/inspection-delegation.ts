import type { CrewCaller, CrewEngine, CrewResult } from "./engine";
import { CrewError } from "./error";
import {
  type InspectionAuditSubject,
  type InspectionBinding,
  type InspectionDenial,
  InspectionDenied,
  type InspectionGrantOperation,
  type InspectionGrantView,
  inspectionGrantIDSchema,
  inspectionGrantInputSchemas,
  inspectionGrantLifetimeMs,
  inspectionGrantView,
} from "./inspection-grants";
import type { InspectInput } from "./reconciliation";

export function isInspectionDelegation(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const op = "op" in raw ? raw.op : undefined;
  return (
    op === "grant-inspect" ||
    op === "list-inspect-grants" ||
    op === "revoke-inspect" ||
    op === "audit-inspect-grant" ||
    "grantID" in raw
  );
}

/** One policy over the existing owner. Never substitutes a captain caller,
 * starts native work, edits permissions, or provides authority to other tools. */
export class CrewInspectionDelegation {
  constructor(
    private readonly engine: CrewEngine,
    private readonly now: () => number = Date.now,
  ) {}

  /** Native tool denies happen before engine execution. Record only trusted
   * context and verified stored grant metadata, never the raw attempted input. */
  denied(raw: unknown, caller: CrewCaller, reason: InspectionDenial) {
    if (!isInspectionDelegation(raw)) return;
    let grant: InspectionAuditSubject | null = null;
    if (typeof raw === "object" && raw !== null && "grantID" in raw) {
      const parsed = inspectionGrantIDSchema.safeParse(raw.grantID);
      if (parsed.success) {
        try {
          grant = this.engine.state.inspectionGrants.get(parsed.data);
        } catch {
          /* unverified */
        }
      }
    }
    if (!grant && caller.sessionID === this.engine.options.captainSessionID) {
      const attempted = inspectionGrantInputSchemas[0].safeParse(raw);
      if (attempted.success) {
        const recipient = this.engine.state.task(attempted.data.taskID);
        const resource = this.engine.state.task(attempted.data.resource.taskID);
        if (
          recipient?.crewID === attempted.data.crew &&
          resource?.crewID === attempted.data.resource.crew
        ) {
          grant = {
            id: null,
            issuer: caller.sessionID,
            recipient: {
              sessionID: recipient.workerSessionID,
              taskID: recipient.id,
            },
            resource: { crew: resource.crewID, taskID: resource.id },
          };
        }
      }
    }
    this.engine.state.inspectionGrants.record(
      grant,
      caller,
      typeof raw === "object" &&
        raw !== null &&
        "op" in raw &&
        [
          "inspect",
          "grant-inspect",
          "list-inspect-grants",
          "revoke-inspect",
          "audit-inspect-grant",
        ].includes(String(raw.op))
        ? String(raw.op)
        : "inspection",
      reason === "expired" ? "expired" : "denied",
      reason,
      this.now(),
    );
  }

  private async permission(caller: CrewCaller, resource: string) {
    try {
      if (caller.inspectionPermission)
        await caller.inspectionPermission(resource);
      else if (!this.engine.hostBoundInspectionPi(caller))
        throw new InspectionDenied("native-denied");
    } catch {
      throw new InspectionDenied(
        caller.signal.aborted ? "cancelled" : "native-denied",
      );
    }
    caller.signal.throwIfAborted();
  }

  private current(grant: InspectionGrantView, caller: CrewCaller) {
    this.recipient(grant, caller);
    const current = this.engine.state.inspectionGrants.check(
      grant.id,
      this.now(),
    );
    this.recipient(current, caller);
    this.match(current.recipient, current.issuer);
    this.match(current.resource, current.issuer);
    return current;
  }

  private recipient(grant: InspectionGrantView, caller: CrewCaller) {
    if (
      grant.issuer !== this.engine.options.captainSessionID ||
      grant.recipient.sessionID !== caller.sessionID ||
      grant.recipient.crew !== caller.agent
    )
      throw new InspectionDenied("identity");
  }

  private ownedGrant(id: string, caller: CrewCaller) {
    let grant: InspectionGrantView;
    try {
      grant = this.engine.state.inspectionGrants.get(id);
    } catch (error) {
      if (error instanceof InspectionDenied)
        throw new InspectionDenied("identity");
      throw error;
    }
    this.recipient(grant, caller);
    return grant;
  }

  private match(binding: InspectionBinding, issuer: string) {
    const current = this.engine.inspectionBinding(
      binding.crew,
      binding.taskID,
      issuer,
    );
    if (JSON.stringify(binding) !== JSON.stringify(current))
      throw new InspectionDenied("task");
  }

  private async verify(grant: InspectionGrantView, caller: CrewCaller) {
    await this.engine.authorize(caller);
    await this.engine.verifyInspectionIssuer(grant.issuer, caller.signal);
    await this.engine.verifyInspectionPeer(grant.recipient.crew, caller.signal);
    await this.engine.verifyInspectionPeer(grant.resource.crew, caller.signal);
    await this.permission(caller, "inspect");
    await this.engine.verifyIssuerInspectionPermission(
      grant.issuer,
      caller.signal,
    );
    return this.current(grant, caller);
  }

  private async issue(
    input: Extract<InspectionGrantOperation, { op: "grant-inspect" }>,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    await this.engine.captain(caller);
    await this.engine.verifyInspectionIssuer(caller.sessionID, caller.signal);
    await this.permission(caller, "inspect");
    const store = this.engine.state.inspectionGrants;
    const replay = store.replay(caller.sessionID, input.key, input);
    if (replay)
      return { status: "inspection-grant", grant: inspectionGrantView(replay) };
    const recipient = this.engine.inspectionBinding(
      input.crew,
      input.taskID,
      caller.sessionID,
    );
    const resource = this.engine.inspectionBinding(
      input.resource.crew,
      input.resource.taskID,
      caller.sessionID,
    );
    await this.engine.verifyInspectionPeer(input.crew, caller.signal);
    await this.engine.verifyInspectionPeer(input.resource.crew, caller.signal);
    await this.engine.verifyInspectionIssuer(caller.sessionID, caller.signal);
    await this.permission(caller, "inspect");
    this.match(recipient, caller.sessionID);
    this.match(resource, caller.sessionID);
    const issuedAt = this.now();
    const expiresAt = Date.parse(input.expiresAt);
    if (
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > inspectionGrantLifetimeMs
    )
      throw new InspectionDenied("lifetime");
    const grant = store.issue(
      { issuer: caller.sessionID, recipient, resource, issuedAt, expiresAt },
      input.key,
      input,
      caller,
    );
    return { status: "inspection-grant", grant: inspectionGrantView(grant) };
  }

  private async inspect(
    input: InspectInput,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    if (!input.grantID) throw new InspectionDenied("identity");
    let grant = this.ownedGrant(input.grantID, caller);
    if (!input.taskID || input.requestStatus)
      throw new InspectionDenied("scope");
    if (
      input.crew !== grant.resource.crew ||
      input.taskID !== grant.resource.taskID
    )
      throw new InspectionDenied("scope");
    this.current(grant, caller);
    grant = await this.verify(grant, caller);
    const inspection = await this.engine.readDelegatedInspection(
      grant.resource,
      caller.signal,
    );
    // The awaited snapshot is not authority. Revocation/task/controller/expiry
    // changes can finish internally, but no protected response crosses this gate.
    grant = await this.verify(grant, caller);
    // Awaiting even a successful verifier yields. The release gate itself must
    // stay synchronous with the audit and response construction.
    grant = this.current(grant, caller);
    this.engine.state.inspectionGrants.record(
      grant,
      caller,
      "inspect",
      "used",
      "current-task",
      this.now(),
    );
    return {
      status: "inspected",
      inspection,
      grant: inspectionGrantView(grant),
    };
  }

  private async management(
    input: Exclude<InspectionGrantOperation, { op: "grant-inspect" }>,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const store = this.engine.state.inspectionGrants;
    const captain = caller.agent === this.engine.options.team.captain.id;
    const issuer = this.engine.options.captainSessionID;
    if (!issuer) throw new InspectionDenied("identity");
    await this.engine.verifyInspectionIssuer(issuer, caller.signal);
    await this.engine.authorize(caller);
    await this.permission(caller, input.op);
    if (input.op === "list-inspect-grants") {
      const task = captain ? null : this.engine.state.activeTask(caller.agent);
      if (!captain) {
        if (!task || task.workerSessionID !== caller.sessionID)
          throw new InspectionDenied("task");
        this.engine.inspectionBinding(caller.agent, task.id, issuer);
      }
      const result = store.list(
        captain ? caller.sessionID : null,
        caller.sessionID,
        task?.id ?? null,
        input.after,
        input.limit,
      );
      return {
        status: "inspection-grants",
        ...result,
        grants: result.grants.map(inspectionGrantView),
      };
    }
    const grant = captain
      ? store.get(input.grantID)
      : this.ownedGrant(input.grantID, caller);
    if (grant.issuer !== issuer) throw new InspectionDenied("identity");
    if (input.op === "revoke-inspect") {
      await this.engine.captain(caller);
      await this.permission(caller, input.op);
      return {
        status: "inspection-revoked",
        grant: inspectionGrantView(
          store.revoke(grant, input.key, input, caller, this.now()),
        ),
      };
    }
    if (!captain) {
      await this.verify(grant, caller);
      this.current(grant, caller);
    }
    return {
      status: "inspection-audit",
      ...store.audit(grant.id, input.after, input.limit),
    };
  }

  async run(
    input: InspectionGrantOperation | InspectInput,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    try {
      await this.engine.authorize(caller);
      await this.permission(caller, input.op);
      this.engine.state.inspectionGrants.requireCustody();
      if (input.op === "inspect") return await this.inspect(input, caller);
      if (input.op === "grant-inspect") return await this.issue(input, caller);
      return await this.management(input, caller);
    } catch (error) {
      const reason =
        error instanceof InspectionDenied
          ? error.reason
          : caller.signal.aborted
            ? "cancelled"
            : error instanceof CrewError
              ? "identity"
              : "unavailable";
      this.denied(input, caller, reason);
      throw new InspectionDenied(reason);
    }
  }
}
