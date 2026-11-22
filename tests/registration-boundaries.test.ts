import { expect, test } from "bun:test";
import * as routing from "../src/gateway/routing";
import {
  backendFingerprint,
  botKey,
  isAllowedChannel,
  isAllowedUser,
} from "../src/shared/registration";

test("registration entry preserves the gateway helper bindings", () => {
  expect(routing.backendFingerprint).toBe(backendFingerprint);
  expect(routing.botKey).toBe(botKey);
  expect(routing.isAllowedChannel).toBe(isAllowedChannel);
  expect(routing.isAllowedUser).toBe(isAllowedUser);
});
