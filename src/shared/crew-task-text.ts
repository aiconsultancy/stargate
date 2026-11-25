/** Raw dispatch and stored task text bound, in code points. */
export const crewTaskTextLimit = 64_000;

/** The ordinary display bounds; the unredacted view counts code points. */
export const crewTaskTextLimits = {
  summary: 180,
  phase: 80,
  progress: 400,
} as const;
