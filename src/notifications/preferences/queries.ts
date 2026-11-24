import { join } from "node:path";
import { NotificationStore } from "./notification-store";

/** Read current preferences without retaining a database connection. */
export function notificationQueries(dataDirectory: string, key: () => string) {
  const withStore = <T>(read: (store: NotificationStore) => T): T => {
    const store = new NotificationStore(
      join(dataDirectory, "notifications.sqlite"),
    );

    try {
      return read(store);
    } finally {
      store.close();
    }
  };

  return {
    status: (channel: string, thread: string) =>
      withStore((store) => store.status(key(), channel, thread)),
    listMutes: () =>
      withStore((store) => {
        const result = store.operate(
          key(),
          { op: "list" },
          {
            id: "meta-list",
            caller: "gateway",
            now: Date.now,
          },
        );

        if (result.op !== "list") throw new Error("Expected mute list");

        return result;
      }),
  };
}
