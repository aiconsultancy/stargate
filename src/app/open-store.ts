import { Store } from "../gateway/store";
import { IrcRecords } from "../irc/store";

export function openStore(path: string) {
  return new Store(path, (db) => new IrcRecords(db));
}
