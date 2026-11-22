import { expect, test } from "bun:test";
import { waitingDelaySchema, waitingSchema } from "../src/config/waiting";
import * as gatewayWaiting from "../src/gateway/waiting";
import { botDisplayName, waitingPhrase } from "../src/shared/waiting";

test("waiting entry paths preserve schema and helper binding identities", () => {
  expect(gatewayWaiting.waitingDelaySchema).toBe(waitingDelaySchema);
  expect(gatewayWaiting.waitingSchema).toBe(waitingSchema);
  expect(gatewayWaiting.botDisplayName).toBe(botDisplayName);
  expect(gatewayWaiting.waitingPhrase).toBe(waitingPhrase);
});
