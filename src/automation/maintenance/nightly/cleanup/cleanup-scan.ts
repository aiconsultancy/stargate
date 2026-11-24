import { sep } from "node:path";
import type { CleanupReason } from "./cleanup-config";

export const maxEntries = 20_000;

export const gone = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

export const inside = (path: string, root: string) =>
  path === root || path.startsWith(root === sep ? sep : `${root}${sep}`);

export class Refusal extends Error {
  public constructor(public readonly reason: CleanupReason) {
    super(reason);
  }
}

export function refuse(reason: CleanupReason): never {
  throw new Refusal(reason);
}

export const reasonOf = (error: unknown): CleanupReason =>
  error instanceof Refusal ? error.reason : "metadata-unknown";

export function bounded<T>(values: T[], maximum = maxEntries) {
  if (values.length > maximum) {
    refuse("scan-limit");
  }

  return values;
}
