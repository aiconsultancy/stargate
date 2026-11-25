import { expect, test } from "bun:test";
import { IrcCapabilities } from "../src/transports/irc/client-capabilities";
import { parseMessage } from "../src/transports/irc/protocol";

function message(line: string) {
  const parsed = parseMessage(line);

  if (!parsed) {
    throw new Error("invalid test message");
  }

  return parsed;
}

test("CAP fragments, ACKs and reconnect reset keep negotiation state", () => {
  const caps = new IrcCapabilities({}, true);
  const receive = (line: string) => caps.capability(message(line), false);

  expect(
    receive(":server CAP nick LS * :sasl=PLAIN account-tag batch"),
  ).toEqual({ kind: "none" });
  expect(
    receive(
      ":server CAP nick LS :draft/metadata-2=max-value-bytes=20 draft/multiline=max-bytes=128,max-lines=4",
    ),
  ).toEqual({
    kind: "send",
    lines: [
      "CAP REQ sasl",
      "CAP REQ account-tag",
      "CAP REQ batch",
      "CAP REQ draft/metadata-2",
      "CAP REQ draft/multiline",
    ],
  });
  expect(caps.multilineOffer).toEqual({ maxBytes: 128, maxLines: 4 });
  expect(caps.statusLimit).toBe(20);

  for (const name of ["sasl", "account-tag", "batch", "draft/metadata-2"]) {
    expect(receive(`:server CAP nick ACK :${name}`)).toEqual({ kind: "none" });
  }

  expect(receive(":server CAP nick ACK :draft/multiline")).toEqual({
    kind: "send",
    lines: ["AUTHENTICATE PLAIN"],
  });
  expect(receive(":server CAP nick DEL :batch")).toEqual({
    kind: "deleted",
  });
  expect(caps.has("batch")).toBe(false);
  expect(receive(":server CAP nick LS * :sasl=PLAIN")).toEqual({
    kind: "none",
  });
  caps.disconnect();
  caps.reset();
  expect(caps.has("sasl")).toBe(false);
  expect(receive(":server CAP nick LS :account-tag")).toEqual({
    kind: "refuse",
    reason: "IRC server lacks SASL PLAIN or account-tag",
  });
});

test("CAP rejects required NAK and selects the configured SASL mechanism", () => {
  const caps = new IrcCapabilities(
    { clientCertificate: { cert: "cert", key: "key" } },
    false,
  );

  const receive = (line: string) => caps.capability(message(line), false);

  expect(receive(":server CAP nick LS :sasl=EXTERNAL account-tag")).toEqual({
    kind: "send",
    lines: ["CAP REQ sasl", "CAP REQ account-tag"],
  });
  expect(receive(":server CAP nick ACK :sasl")).toEqual({ kind: "none" });
  expect(receive(":server CAP nick ACK :account-tag")).toEqual({
    kind: "send",
    lines: ["AUTHENTICATE EXTERNAL"],
  });
  expect(receive(":server CAP nick NAK :account-tag")).toEqual({
    kind: "refuse",
    reason: "IRC server refused a required capability",
  });
});
