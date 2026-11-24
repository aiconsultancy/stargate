import { expect, test } from "bun:test";
import { waitingDelaySchema, waitingSchema } from "../src/config/waiting";
import * as overrides from "../src/config/waiting-overrides";
import { botDisplayName, waitingPhrase } from "../src/shared/waiting";

test("waiting entry paths preserve schema and helper binding identities", () => {
  expect(overrides.waitingDelaySchema).toBe(waitingDelaySchema);
  expect(overrides.waitingSchema).toBe(waitingSchema);
  expect(overrides.botDisplayName).toBe(botDisplayName);
  expect(overrides.waitingPhrase).toBe(waitingPhrase);
});
