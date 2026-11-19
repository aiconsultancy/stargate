import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { CrewReporting } from "../crew/report-rpc";
import type { MaintenanceDrain } from "../maintenance-drain";
import type { UpdateReceipt } from "../update-notice";
import { StepError } from "./exec";
import type { ModelRef } from "./versions";

/** The OpenCode server operations maintenance needs; tests use a fake. */
export interface OpenCodeControl {
  /** Passive host-local context queues only: never sends a native input. */
  maintenanceNotice?(
    notice: MaintenanceDrain,
    signal: AbortSignal,
  ): Promise<UpdateReceipt[]>;
  /** IDs of sessions with a running turn. */
  active(signal: AbortSignal): Promise<string[]>;
  /** IDs of sessions with a pending form or permission request. */
  pendingInput(signal: AbortSignal): Promise<string[]>;
  /** The session that started this one as a subagent; undefined for a root. */
  parent(sessionID: string, signal: AbortSignal): Promise<string | undefined>;
  sessionModel(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<ModelRef | null>;
  switchModel(
    sessionID: string,
    model: ModelRef,
    signal: AbortSignal,
  ): Promise<void>;
  /** Enabled chat models with their variants, at a location or globally. */
  catalog(
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<{ providerID: string; id: string; variants: string[] }[]>;
  /** Local plugin paths and whether each loaded. */
  plugins(
    directory: string,
    signal: AbortSignal,
  ): Promise<{ path: string; active: boolean }[]>;
  agents(
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<{ id: string; mode: string; model: ModelRef | null }[]>;
  reload(signal: AbortSignal): Promise<void>;
}

/**
 * Discover the local shared service. Called again after a restart because
 * the endpoint and its credentials can change. Errors never expose details.
 */
/** Every OpenCode call is bounded; the run's worst-case budget assumes it. */
export const openCodeCallMs = 10_000;

export async function connectOpenCode(): Promise<OpenCodeControl> {
  const endpoint = await Promise.race([
    Service.discover().catch(() => undefined),
    Bun.sleep(openCodeCallMs).then(() => undefined),
  ]);
  if (!endpoint) throw new StepError("health-failed");
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers({
      url: endpoint.url,
      ...(endpoint.auth ? { auth: endpoint.auth } : {}),
    }),
  });
  const bounded = (signal: AbortSignal) =>
    AbortSignal.any([signal, AbortSignal.timeout(openCodeCallMs)]);
  const at = (directory: string | undefined) =>
    directory ? { location: { directory } } : {};
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch {
      // Raw SDK errors can carry request headers; never surface them.
      throw new StepError("health-failed");
    }
  };
  const ref = (model: ModelRef | undefined) =>
    model
      ? {
          providerID: model.providerID,
          id: model.id,
          ...(model.variant ? { variant: model.variant } : {}),
        }
      : null;
  return {
    maintenanceNotice: (notice, signal) =>
      guard(async () => {
        const locations = await client.debug.location.list({
          signal: bounded(signal),
        });
        const receipts: UpdateReceipt[] = [];
        for (const directory of new Set(
          locations.map((location) => location.directory),
        )) {
          signal.throwIfAborted();
          // Most locations do not load Stargate's plugin. Never create one or
          // start a model request merely to deliver a maintenance notice.
          const result = await client
            .rpc(CrewReporting)
            .maintenanceNotice(notice, {
              location: { directory },
              signal: bounded(signal),
            })
            .catch(() => []);
          receipts.push(...result);
        }
        return [
          ...new Map(
            receipts.map((receipt) => [receipt.sessionID, receipt]),
          ).values(),
        ].slice(0, 1000);
      }),
    active: (signal) =>
      guard(async () =>
        Object.keys(await client.session.active({ signal: bounded(signal) })),
      ),
    pendingInput: (signal) =>
      guard(async () => {
        const locations = await client.debug.location.list({
          signal: bounded(signal),
        });
        const directories = new Set<string | undefined>([
          undefined,
          ...locations.map((location) => location.directory),
        ]);
        const waiting = new Set<string>();
        for (const directory of directories) {
          const [forms, permissions] = await Promise.all([
            client.form.list(at(directory), { signal: bounded(signal) }),
            client.permission.request.list(at(directory), {
              signal: bounded(signal),
            }),
          ]);
          for (const request of [...forms.data, ...permissions.data])
            waiting.add(request.sessionID);
        }
        return [...waiting];
      }),
    parent: (sessionID, signal) =>
      guard(
        async () =>
          (await client.session.get({ sessionID }, { signal: bounded(signal) }))
            .parentID,
      ),
    sessionModel: (sessionID, signal) =>
      guard(async () =>
        ref(
          (await client.session.get({ sessionID }, { signal: bounded(signal) }))
            .model,
        ),
      ),
    switchModel: (sessionID, model, signal) =>
      guard(() =>
        client.session.switchModel(
          { sessionID, model },
          { signal: bounded(signal) },
        ),
      ),
    catalog: (directory, signal) =>
      guard(async () =>
        (
          await client.model.list(
            { ...at(directory), types: ["chat"] },
            { signal: bounded(signal) },
          )
        ).data
          .filter((model) => model.enabled)
          .map((model) => ({
            providerID: model.providerID,
            id: model.id,
            variants: model.variants.map((variant) => variant.id),
          })),
      ),
    plugins: (directory, signal) =>
      guard(async () =>
        (
          await client.plugin.list(at(directory), { signal: bounded(signal) })
        ).data.flatMap((plugin) =>
          plugin.source.type === "local"
            ? [
                {
                  path: plugin.source.path,
                  active: plugin.state.status === "active",
                },
              ]
            : [],
        ),
      ),
    agents: (directory, signal) =>
      guard(async () =>
        (
          await client.agent.list(at(directory), { signal: bounded(signal) })
        ).data.map((agent) => ({
          id: agent.id,
          mode: agent.mode,
          model: ref(agent.model),
        })),
      ),
    reload: (signal) =>
      guard(() => client.location.reload({ signal: bounded(signal) })),
  };
}
