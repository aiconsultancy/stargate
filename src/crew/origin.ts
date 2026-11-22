import {
  closesBoundaryContext,
  type InputBoundaryRecord,
  resolveBoundaryContext,
} from "../backends/opencode/input-boundary";
import { InputBoundaryReader } from "../backends/opencode/input-origin";
import type { ResultAPI } from "./result";

/** Resolve the tool's retained turn, not whichever input is newest now. */
export async function readInputOrigin(
  api: ResultAPI,
  sessionID: string,
  messageID: string,
  signal: AbortSignal,
): Promise<string | null> {
  const boundaries = new InputBoundaryReader(api, sessionID, signal);
  let anchored = false;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const chain: InputBoundaryRecord[] = [];
  const origin = () => {
    const input = resolveBoundaryContext(chain);
    return input === chain[0]?.id ? null : (input ?? null);
  };
  // greybeard: 512 retained messages; unknown ancestry remains native-only.
  for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
    signal.throwIfAborted();
    const page = await api.message.list(
      {
        sessionID,
        limit: 64,
        ...(cursor ? { cursor } : { order: "desc" as const }),
      },
      { signal },
    );
    signal.throwIfAborted();
    for (const message of page.data) {
      if (!anchored) {
        if (message.id !== messageID) continue;
        if (message.type !== "assistant") return null;
        anchored = true;
      }
      const record = await boundaries.record(message);
      if (chain.length && closesBoundaryContext(record)) {
        chain.push(record);
        return origin();
      }
      if (record.input === undefined) continue;
      if (!chain.length && record.type !== "synthetic") return record.input;
      chain.push(record);
    }
    cursor = page.cursor.next ?? undefined;
    if (cursor && cursors.has(cursor)) return null;
    if (cursor) cursors.add(cursor);
    if (!cursor) return origin();
  }
  return null;
}
