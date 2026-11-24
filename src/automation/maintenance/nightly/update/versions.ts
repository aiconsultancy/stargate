/** Stable MAJOR.MINOR.PATCH with an optional `v`. Pre-releases are rejected. */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(
    text.trim(),
  );

  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareParts(a: readonly number[], b: readonly number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);

    if (difference) {
      return Math.sign(difference);
    }
  }

  return 0;
}

/** Compares stable versions; throws on an invalid version. */
export function compareVersions(a: string, b: string) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  if (!left || !right) {
    throw new Error("Invalid version.");
  }

  return compareParts(left, right);
}

export function normalizeVersion(text: string) {
  const parsed = parseVersion(text);

  return parsed ? parsed.join(".") : null;
}

/**
 * Known model family and version. Exact forms only; suffixed products such
 * as `gpt-6.1-sol-fast` or dated snapshots are not part of a family.
 *
 * - `claude-<name>-<major>[-<minor>]` → family `claude-<name>`
 * - `gpt-<major>[.<minor>]-<name>` → family `gpt-<name>`
 */
export type ModelVersion = {
  family: string;
  version: number[];
  /** Agent-name token, e.g. `opus-5-5` or `sol-6-1`. */
  token: string;
};

export function parseModel(id: string): ModelVersion | null {
  const claude =
    /^claude-([a-z]+)-(0|[1-9]\d{0,3})(?:-(0|[1-9]\d{0,3}))?$/.exec(id);

  if (claude?.[1] && claude[2]) {
    const version = [
      Number(claude[2]),
      ...(claude[3] ? [Number(claude[3])] : []),
    ];

    return {
      family: `claude-${claude[1]}`,
      version,
      token: [claude[1], ...version].join("-"),
    };
  }

  const gpt = /^gpt-(0|[1-9]\d{0,3})(?:\.(0|[1-9]\d{0,3}))?-([a-z]+)$/.exec(id);

  if (gpt?.[1] && gpt[3]) {
    const version = [Number(gpt[1]), ...(gpt[2] ? [Number(gpt[2])] : [])];

    return {
      family: `gpt-${gpt[3]}`,
      version,
      token: [gpt[3], ...version].join("-"),
    };
  }

  return null;
}

/** Orders two IDs of one family; missing minor versions count as zero. */
export function compareModels(a: ModelVersion, b: ModelVersion) {
  return compareParts(a.version, b.version);
}

/**
 * Strictly newer IDs of the same configured family, newest first. Unknown
 * families and equal versions are never candidates, so this never downgrades.
 */
export function newerModels(
  current: string,
  catalog: readonly string[],
  families: readonly string[],
) {
  const base = parseModel(current);

  if (!base || !families.includes(base.family)) {
    return [];
  }

  const seen = new Set<string>();

  return catalog
    .flatMap((id) => {
      const parsed = parseModel(id);

      if (
        !parsed ||
        seen.has(id) ||
        parsed.family !== base.family ||
        compareModels(parsed, base) <= 0
      ) {
        return [];
      }

      seen.add(id);

      return [{ id, parsed }];
    })
    .toSorted(
      (a, b) => compareModels(b.parsed, a.parsed) || a.id.localeCompare(b.id),
    )
    .map(({ id }) => id);
}

/** `provider/model` or `provider/model#variant`. */
export type ModelRef = { providerID: string; id: string; variant?: string };

export function parseRef(text: string): ModelRef | null {
  const match = /^([^/\s#]+)\/([^\s#]+)(?:#([^\s#]+))?$/.exec(text);

  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    providerID: match[1],
    id: match[2],
    ...(match[3] && { variant: match[3] }),
  };
}

export function formatRef(ref: ModelRef) {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
}
