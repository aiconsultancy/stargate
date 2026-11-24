import type { IrcConfig } from "../../config";
import { sensitive } from "./audit";
import type { IrcClient } from "./client";
import { type IrcMessage, cleanText } from "./protocol";
import { shipAccounts } from "./routing";
import type { IrcOperations } from "./store-contract";

/** IRC copy text limit, in bytes. */
const copyBytes = 1800;

/** Client-only tag of an IRC copy: the stargate_dm's Mesij receipt ID. */
export const copyTag = "+stargate/dm";

/**
 * IRC text of a stargate_dm copy: marked `[stargate_dm]`, plain text, at most
 * `copyBytes`, and withheld entirely when it may carry a credential (the
 * server stores every DM).
 */
export function copyText(item: { id: string; text: string }) {
  const clean = item.text
    .split("\n")
    .map((item) => cleanText(item))
    .join("\n")
    .trim();

  if (sensitive(item.text) || sensitive(clean))
    return `[stargate_dm ${item.id}: not copied to IRC, it may contain credentials. Read it with stargate_mail.]`;
  const marked = `[stargate_dm] ${clean}`;

  if (Buffer.byteLength(marked) <= copyBytes) return marked;
  const suffix = " … (truncated; full text in stargate_mail)";
  let cut = marked;

  while (Buffer.byteLength(cut + suffix) > copyBytes)
    cut = Array.from(cut).slice(0, -64).join("");

  return `${cut.trimEnd()}${suffix}`;
}

/**
 * A DM to this connection that is one of this ship's own stargate_dm copies:
 * from a ship account, tagged with a receipt ID this process recorded.
 * An unknown ID is an ordinary ship DM.
 */
export function isOwnDmCopy(
  config: IrcConfig,
  client: Pick<IrcClient, "fold" | "isChannel" | "nick">,
  message: IrcMessage,
  store: Pick<IrcOperations, "stargateDmCopy">,
) {
  const id = message.tags.get(copyTag);
  const account = message.tags.get("account");
  const target = message.params[0] ?? "";

  return (
    message.command === "PRIVMSG" &&
    id !== undefined &&
    /^[a-f0-9]{32}$/.test(id) &&
    account !== undefined &&
    !client.isChannel(target) &&
    client.fold(target) === client.fold(client.nick) &&
    shipAccounts(config, client.fold).has(client.fold(account)) &&
    store.stargateDmCopy(id)
  );
}
