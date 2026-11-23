export type Logger = (message: string) => void;

/** Never expose upstream exception text, headers or request bodies. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.name : "TransportError";
}
