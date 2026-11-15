/** Owner-approved stable OpenCode MESSAGE key, not a session/config/tool alias. */
export const crewMessageMetadataKey = "pogoCrew";

/** Historical native inputs stay immutable; new inputs use the Stargate label. */
export function taskEnvelopePayload(text: string | undefined) {
  const line = text?.split("\n", 1)[0];
  if (line === undefined) return;
  const prefix = ["Stargate task envelope: ", "Pogo task envelope: "].find(
    (prefix) => line.startsWith(prefix),
  );
  return prefix === undefined ? undefined : line.slice(prefix.length);
}
