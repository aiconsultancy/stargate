import type { ircBurstMessageSchema } from "../src/irc/burst";
import type { IrcBurstMessage } from "../src/irc/store-contract";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type Assert<T extends true> = T;

export type StoredBurstShape = Assert<
  Equal<IrcBurstMessage, typeof ircBurstMessageSchema.Type>
>;
