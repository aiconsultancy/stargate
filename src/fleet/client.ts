import { request } from "node:http";
import { FleetError, type FleetRequest } from "./protocol";

/** A bounded, cancellable local call. Never falls back to a TCP endpoint. */
export function fleetRequest(
  socketPath: string,
  input: FleetRequest,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const body = JSON.stringify(input);

    const req = request(
      {
        socketPath,
        path: "/fleet",
        method: "POST",
        signal,
        timeout: 20_000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;

          if (bytes > 1_000_000) {
            req.destroy();
            reject(
              new FleetError(
                "Fleet response exceeded its private response limit.",
              ),
            );
          } else chunks.push(chunk);
        });
        response.once("error", () =>
          reject(
            new FleetError(
              "Fleet response was interrupted; inspect the same request ID before retrying.",
            ),
          ),
        );
        response.once("end", () => {
          try {
            const value: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );

            if (typeof value !== "object" || value === null)
              throw new Error("Fleet response is not an object");

            if ("error" in value && typeof value.error === "string")
              throw new FleetError(value.error);

            if (response.statusCode !== 200 || !("result" in value))
              throw new Error("Fleet response has no result");
            resolve(value.result);
          } catch (error) {
            reject(
              error instanceof FleetError
                ? error
                : new FleetError(
                    "Invalid fleet response; raw details withheld.",
                  ),
            );
          }
        });
      },
    );

    req.once("timeout", () => req.destroy());
    req.once("error", () =>
      reject(
        new FleetError(
          "Fleet control unavailable or interrupted; inspect the same request ID before retrying.",
        ),
      ),
    );
    req.end(body);
  });
}
