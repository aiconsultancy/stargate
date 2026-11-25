import { type IrcMessage, formatMessage, parseCapabilities } from "./protocol";
import {
  parseStatusMetadataLimit,
  statusMetadataMaxValueBytes,
} from "./status";

/** Required for access decisions: no account tag means no admission. */
const required = ["sasl", "account-tag"];

const optional = [
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
  "account-notify",
  "extended-join",
];

export const chathistoryCaps = ["draft/chathistory", "chathistory"] as const;

/** Smallest draft/multiline max-bytes that Stargate uses. */
const minMultilineBytes = 64;

type CapabilityOptions = {
  clientCertificate?: { cert: string; key: string };
  catchUp?: boolean;
  multiline?: boolean;
  presence?: { alwaysOn: boolean; botMode: boolean; readMarker: boolean };
};

type CapabilityResult =
  | { kind: "none" }
  | { kind: "send"; lines: string[] }
  | { kind: "refuse"; reason: string }
  | { kind: "deleted" };

export class IrcCapabilities {
  private offered = new Map<string, string>();
  private requested = 0;
  private caps = new Set<string>();
  public multilineOffer: { maxBytes: number; maxLines: number } | undefined;
  public statusLimit = statusMetadataMaxValueBytes;

  public constructor(
    private readonly options: CapabilityOptions,
    private readonly statusEnabled: boolean,
  ) {}

  public reset() {
    this.offered = new Map();
    this.requested = 0;
  }

  public disconnect() {
    this.caps = new Set();
  }

  public has(name: string) {
    return this.caps.has(name);
  }

  public capability(message: IrcMessage, welcomed: boolean): CapabilityResult {
    const params = message.params;
    const sub = params[1];

    if (sub === "LS") {
      return this.list(params);
    }

    if (sub === "ACK" || sub === "NAK") {
      for (const name of (params.at(-1) ?? "").split(" ")) {
        if (!name) {
          continue;
        }

        if (sub === "NAK") {
          if (required.includes(name)) {
            return {
              kind: "refuse",
              reason: "IRC server refused a required capability",
            };
          }
        } else if (name.startsWith("-")) {
          this.caps.delete(name.slice(1));
        } else {
          this.caps.add(name);
        }
      }

      if (welcomed || --this.requested > 0) {
        return { kind: "none" };
      }

      const mechanism = this.options.clientCertificate ? "EXTERNAL" : "PLAIN";

      return { kind: "send", lines: [`AUTHENTICATE ${mechanism}`] };
    }

    if (sub === "DEL") {
      for (const name of (params.at(-1) ?? "").split(" ")) {
        this.caps.delete(name);
      }

      return { kind: "deleted" };
    }

    return { kind: "none" };
  }
  private list(params: readonly string[]): CapabilityResult {
    const more = params[2] === "*";

    for (const [name, value] of parseCapabilities(params.at(-1) ?? "")) {
      this.offered.set(name, value);
    }

    if (more) {
      return { kind: "none" };
    }

    const offered = this.offered;
    this.offered = new Map();
    const sasl = offered.get("sasl");
    const mechanism = this.options.clientCertificate ? "EXTERNAL" : "PLAIN";

    if (
      !required.every((cap) => offered.has(cap)) ||
      (sasl && !sasl.split(",").includes(mechanism))
    ) {
      return {
        kind: "refuse",
        reason: `IRC server lacks SASL ${mechanism} or account-tag`,
      };
    }

    const history =
      this.options.catchUp === false
        ? undefined
        : chathistoryCaps.find((cap) => offered.has(cap));

    const multiline = offered.get("draft/multiline");

    if (multiline !== undefined) {
      const limits = new Map(
        multiline.split(",").map((item) => {
          const [key = "", value = ""] = item.split("=");

          return [key, Number(value)] as const;
        }),
      );

      const maxBytes = limits.get("max-bytes") ?? 0;
      const maxLines = limits.get("max-lines") ?? 100;
      // Below 64 bytes a batch holds less than a plain line: not used.
      this.multilineOffer =
        Number.isInteger(maxBytes) && maxBytes >= minMultilineBytes
          ? {
              maxBytes,
              maxLines:
                Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 100,
            }
          : undefined;
    } else {
      this.multilineOffer = undefined;
    }

    const presence = this.options.presence;
    const metadata = offered.get("draft/metadata-2");
    this.statusLimit = parseStatusMetadataLimit(metadata);

    const wanted = [
      ...required,
      ...optional.filter((cap) => offered.has(cap)),
      ...(this.statusEnabled && metadata !== undefined && offered.has("batch")
        ? ["draft/metadata-2"]
        : []),
      ...(history ? [history] : []),
      ...(presence?.alwaysOn !== false && offered.has("draft/persistence")
        ? ["draft/persistence"]
        : []),
      ...(presence?.readMarker !== false && offered.has("draft/read-marker")
        ? ["draft/read-marker"]
        : []),
      ...(this.multilineOffer && this.options.multiline !== false
        ? ["draft/multiline"]
        : []),
    ];

    this.requested = wanted.length;

    return {
      kind: "send",
      lines: wanted.map((cap) => formatMessage("CAP", ["REQ", cap])),
    };
  }
}
