import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import type { BotConfig } from "../config";
import { settingsDefault, settingsStruct } from "../settings-schema";

export const waitingDelaySchema = Schema.NullOr(
  Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0))
    .check(Schema.isLessThanOrEqualTo(3_600_000)),
);
export const waitingSchema = settingsStruct({
  delayMs: waitingDelaySchema.pipe(settingsDefault(5000)),
  intervalMs: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(3_600_000))
    .pipe(settingsDefault(10000)),
});
export type WaitingSettings = typeof waitingSchema.Type;
const overrideSchema = settingsStruct({ delayMs: waitingDelaySchema });

/** Shared captain workspace settings, isolated by configured agent identity. */
export function waitingSettingsPath(directory: string, agent: string): string {
  const id = createHash("sha256").update(agent).digest("hex");
  return join(directory, ".local", "stargate-waiting", `${id}.json`);
}

/** Cosmetic settings fail back to config; corrupt files never fail a turn. */
export async function resolveWaiting(
  bot: Pick<BotConfig, "backend" | "waiting">,
): Promise<WaitingSettings> {
  const backend = bot.backend;
  if (backend.type !== "opencode" || !backend.agent) return bot.waiting;
  try {
    const override = Schema.decodeUnknownSync(overrideSchema)(
      await Bun.file(
        waitingSettingsPath(backend.directory, backend.agent),
      ).json(),
    );
    return { ...bot.waiting, ...override };
  } catch {
    return bot.waiting;
  }
}

/** Caller must verify captain authority before invoking this private write. */
export async function saveWaitingDelay(
  directory: string,
  agent: string,
  delayMs: number | null,
  signal: AbortSignal,
): Promise<void> {
  const settings = Schema.decodeUnknownSync(overrideSchema)({ delayMs });
  signal.throwIfAborted();
  const path = waitingSettingsPath(directory, agent);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings)}\n`, {
      flag: "wx",
      mode: 0o600,
      signal,
    });
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function botDisplayName(
  bot: Pick<BotConfig, "displayName" | "backend" | "id">,
): string {
  return (
    bot.displayName ??
    (bot.backend.type === "opencode" ? bot.backend.agent : undefined) ??
    bot.id
  );
}

const phrases = [
  "thinking",
  "mulling it over",
  "pondering",
  "tinkering",
  "discombobulating",
  "connecting the dots",
  "untangling the noodles",
  "warming up the brain cells",
  "turning the mental gears",
  "following the breadcrumbs",
  "noodling on it",
  "brewing a thought",
  "stirring the idea pot",
  "polishing a possibility",
  "juggling the details",
  "wrangling the what-ifs",
  "herding the hypotheses",
  "tickling the grey matter",
  "coaxing an idea into focus",
  "taking the scenic thought route",
  "assembling the mental jigsaw",
  "chasing a loose thread",
  "squinting at the puzzle",
  "chewing on the question",
  "letting the thought simmer",
  "putting on a thinking cap",
  "rearranging the mental furniture",
  "rummaging through possibilities",
  "shuffling the idea cards",
  "nudging the pieces around",
  "winding up the curiosity engine",
  "taking the idea for a spin",
  "poking the puzzle gently",
  "untying a thought knot",
  "folding a thought into shape",
  "measuring twice in thought",
  "sorting the mental sock drawer",
  "spinning the thought hamster wheel",
  "sifting the idea sand",
  "peering around a mental corner",
  "fiddling with the details",
  "letting the gears click",
  "tuning the thought antenna",
  "puttering through possibilities",
  "sketching on the mental napkin",
  "marinating an idea",
  "taking a cerebral stroll",
  "looking under the thought cushions",
  "untwisting the question mark",
  "giving the puzzle a friendly nudge",
  "toasting a tiny brainwave",
  "chasing the elusive aha",
  "lining up the mental dominoes",
  "turning a notion inside out",
  "tapping on the idea aquarium",
  "navigating the noodle maze",
  "making friends with the question",
  "fishing for a useful thought",
  "dusting off the thinking gears",
  "braiding the loose ends",
  "balancing the thought teacups",
  "doodling in the margins of an idea",
  "kneading the thought dough",
  "trying the puzzle pieces sideways",
  "taking a peek behind the obvious",
  "chipping away at the head-scratcher",
  "rolling the idea between its fingers",
  "untangling the mental headphones",
  "giving a brainwave some elbow room",
  "sailing the sea of maybe",
  "orbiting an interesting notion",
  "gathering the wandering thoughts",
  "wrestling a slippery what-if",
  "building a tiny thought bridge",
  "paddling through the possibilities",
  "tucking the details into place",
  "following a spark of curiosity",
  "taking the question apart gently",
  "shining a light into the idea cupboard",
  "bouncing a thought off the walls",
  "stitching a few notions together",
  "turning over a curious pebble",
  "combing through the mental tangles",
  "watching the thought bubbles rise",
  "percolating",
  "cogitating",
  "ruminating",
  "contemplating",
  "deliberating",
  "daydreaming productively",
  "playing mental hopscotch",
  "giving the idea kaleidoscope a turn",
  "recalibrating the hunch compass",
  "persuading the dots to connect",
  "tiptoeing around a tricky detail",
  "making a small mountain of thoughts",
  "sweeping the cobwebs from a notion",
  "letting a possibility hatch",
  "trying on a different angle",
  "finding the rhythm of the riddle",
] as const;

/** Stable cycling keeps tests deterministic; the caller chooses the start. */
export function waitingPhrase(name: string, index: number): string {
  const whole = Number.isFinite(index) ? Math.trunc(index) : 0;
  const offset = ((whole % phrases.length) + phrases.length) % phrases.length;
  return `${name} is ${phrases[offset]}…`;
}
