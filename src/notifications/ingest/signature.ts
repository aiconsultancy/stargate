import { createHash } from "node:crypto";
import {
  InvalidNotification,
  type NotificationInput,
  type Source,
  sourceScope,
  utcMillis,
} from "./model";

export function signature(source: Source, input: NotificationInput): string {
  const occurredAt = utcMillis(input.occurredAt);

  if (!occurredAt) throw new InvalidNotification();

  const tags = Object.entries(input.tags ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  return `v1:${createHash("sha256")
    .update(
      JSON.stringify([
        1,
        sourceScope(source),
        input.topic,
        occurredAt,
        tags,
        input.payload.title,
        input.payload.body ?? "",
        input.payload.url ?? "",
      ]),
      "utf8",
    )
    .digest("hex")}`;
}
