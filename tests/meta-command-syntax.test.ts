import { expect, test } from "bun:test";
import { metaCommandSyntax } from "../src/meta-commands/meta-command-syntax";
import { MetaCommands } from "../src/meta-commands/meta-commands";
import { Store } from "../src/gateway/store";
import { bot, event, identity } from "./fixtures";

test("update syntax matches the command help catalogue in order", async () => {
  const store = new Store(":memory:");
  try {
    let reply = "";
    const commands = new MetaCommands(store.meta, {
      async post(_channel, _thread, text) {
        reply = text;
      },
    });
    await commands.receive(event("<@UBOT> /help"), bot(), identity, () => true);
    expect(reply.split("\n")).toEqual([
      "Valid commands:",
      ...metaCommandSyntax(),
    ]);
  } finally {
    store.close();
  }
});
