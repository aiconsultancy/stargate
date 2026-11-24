import type { OpenCodeClient } from "@opencode/client";
import type { MaintenanceDrain } from "../../automation/maintenance/maintenance-drain";
import {
  type UpdateSnapshot,
  scopedUpdate,
} from "../../automation/maintenance/update-notice";
import { CrewReporting } from "../../coordination/crew/reporting/report-rpc";
import type { opencodeBackendSchema } from "./config";

/** Location-scoped update and maintenance notices for an attached client. */
export class OpenCodeNotices {
  public constructor(
    private readonly client: OpenCodeClient,
    private readonly config: Pick<
      typeof opencodeBackendSchema.Type,
      "directory" | "agent"
    >,
  ) {}

  public async updateNoticeContext(
    sessionID: string,
    snapshot: UpdateSnapshot,
    signal: AbortSignal,
  ) {
    const session = await this.client.session.get({ sessionID }, { signal });

    if (
      session.id !== sessionID ||
      session.location.directory !== this.config.directory ||
      (this.config.agent && session.agent !== this.config.agent)
    ) {
      throw new Error("Update notice session does not belong to this backend");
    }

    const tools = await this.client
      .rpc(CrewReporting)
      .updateTools(
        {},
        { location: { directory: this.config.directory }, signal },
      )
      .catch(() => null);

    return scopedUpdate(snapshot, tools, {
      model: session.model,
      permissions: session.permissions,
    });
  }

  public async queueUpdateNotice(
    sessionID: string,
    id: string,
    text: string,
    signal: AbortSignal,
  ) {
    const receipt = await this.client
      .rpc(CrewReporting)
      .queueUpdateNotice(
        { sessionID, id, text },
        { location: { directory: this.config.directory }, signal },
      );

    if (receipt.id !== id || receipt.sessionID !== sessionID) {
      throw new Error("Update notice identity changed");
    }
  }

  public async crewUpdateNotice(snapshot: UpdateSnapshot, signal: AbortSignal) {
    const receipts = await this.client
      .rpc(CrewReporting)
      .updateNotice(snapshot, {
        location: { directory: this.config.directory },
        signal,
      });

    return [...receipts];
  }

  public async maintenanceNotice(
    record: MaintenanceDrain,
    signal: AbortSignal,
  ) {
    const receipts = await this.client
      .rpc(CrewReporting)
      .maintenanceNotice(record, {
        location: { directory: this.config.directory },
        signal,
      });

    return [...receipts];
  }

  public async resumeMaintenance(signal: AbortSignal) {
    return this.client
      .rpc(CrewReporting)
      .resumeMaintenance(
        {},
        { location: { directory: this.config.directory }, signal },
      );
  }
}
