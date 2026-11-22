import { Store } from "../gateway/store";

export function openStore(path: string) {
  return new Store(path);
}
