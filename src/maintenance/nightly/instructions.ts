import { Schema } from "effect";
import { settingsPattern, settingsStruct } from "../../settings-schema";
import { timeZoneSchema } from "./config";

export const nightlyWindowSchema = settingsStruct({
  start: Schema.String.check(settingsPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  end: Schema.String.check(settingsPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  timeZone: timeZoneSchema,
});
export type NightlyWindow = typeof nightlyWindowSchema.Type;

/**
 * Captain and crew paragraph. Rendered with the configured window; empty
 * when nightly maintenance is not configured.
 */
export function nightlyInstructions(window: NightlyWindow | undefined) {
  if (!window) return "";
  return `Nightly maintenance: every night from ${window.start} to ${window.end} (${window.timeZone}), Stargate can update itself, the model proxy, the agent CLIs and agent models. At an idle moment in this window, the Slack gateway, the OpenCode server and your session can restart, and your model can change to a newer model of the same family. Before the window, checkpoint work in progress: commit or push branch work, write a journal note and report task state. Do not start long tasks in the window. After a restart, read your journal and continue from the last checkpoint.`;
}
