/**
 * Fail-closed ACP tool-permission evaluator with symlink-aware canonical path
 * containment. Adapted from T3 Code `packages/provider-acp/src/server/clientPolicy.ts`
 * (MIT License, Copyright 2026 T3 Tools Inc.).
 */
import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { AcpPermissionPolicy } from "../config";
import {
  type AcpPermissionOption,
  type AcpPermissionRequest,
  asRecord,
} from "./protocol";

const MAX_ACP_CHANGED_PATHS = 256;
const RAW_INPUT_PATH_KEYS = ["path", "filePath", "file_path"] as const;
const READ_ONLY_KINDS = new Set(["read", "search", "think", "fetch"]);
const MUTATING_KINDS = new Set(["edit", "delete", "move"]);

export type AcpChangedPaths = readonly string[] | "unknown";

export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

function checkablePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0")
  ) {
    return undefined;
  }

  if (isAbsolute(value)) {
    return value;
  }

  if (value.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return undefined;
  }

  if (sep === "/" && value.includes("\\")) {
    return undefined;
  }

  return value;
}

function resolvePermissionPath(
  path: string,
  cwd: string | null,
): string | undefined {
  if (path.trim().length === 0) {
    return undefined;
  }

  if (isAbsolute(path)) {
    return path;
  }

  if (cwd === null || cwd.trim().length === 0) {
    return undefined;
  }

  return `${cwd}${cwd.endsWith(sep) ? "" : sep}${path}`;
}

/**
 * Canonicalize existing ancestors for symlink-aware checks of new paths;
 * fail closed on any filesystem error other than ENOENT.
 */
export function canonicalPathForContainment(path: string): string | undefined {
  let candidate = path;
  const missingSuffix: string[] = [];

  for (let depth = 0; depth < 256; depth++) {
    try {
      return resolve(realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    try {
      lstatSync(candidate);

      // Existing dangling symlink or non-traversable entry: fail closed.
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    const parent = dirname(candidate);

    if (parent === candidate) {
      return undefined;
    }

    missingSuffix.unshift(basename(candidate));
    candidate = parent;
  }

  return undefined;
}

export function pathIsWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);

  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * Every path a tool call mutates, or `"unknown"` when any location/diff/input
 * cannot be checked reliably. Unknown paths are never auto-approved.
 */
export function changedPathsOfToolCall(toolCall: {
  readonly locations?: unknown;
  readonly content?: unknown;
  readonly rawInput?: unknown;
}): AcpChangedPaths {
  const paths = new Set<string>();
  let complete = true;

  const requirePath = (value: unknown) => {
    const path = checkablePath(value);

    if (path === undefined) {
      complete = false;
    } else {
      paths.add(path);
    }
  };

  if (Array.isArray(toolCall.locations)) {
    for (const entry of toolCall.locations) {
      requirePath(asRecord(entry)?.["path"]);
    }
  } else if (toolCall.locations !== undefined && toolCall.locations !== null) {
    complete = false;
  }

  if (Array.isArray(toolCall.content)) {
    for (const entry of toolCall.content) {
      const record = asRecord(entry);

      if (record?.["type"] === "content" || record?.["type"] === "terminal") {
        continue;
      }

      if (record?.["type"] !== "diff") {
        complete = false;
        continue;
      }

      requirePath(record["path"]);
    }
  } else if (toolCall.content !== undefined && toolCall.content !== null) {
    complete = false;
  }

  const input = asRecord(toolCall.rawInput);

  if (input !== undefined) {
    for (const key of RAW_INPUT_PATH_KEYS) {
      if (key in input && input[key] !== undefined && input[key] !== null) {
        requirePath(input[key]);
      }
    }
  }

  if (!complete || paths.size > MAX_ACP_CHANGED_PATHS) {
    return "unknown";
  }

  return [...paths];
}

function allPathsWithinRoots(
  paths: AcpChangedPaths,
  cwd: string,
  extraRoots: readonly string[],
): boolean {
  if (paths === "unknown" || paths.length === 0) {
    return false;
  }

  const roots = [cwd, ...extraRoots].flatMap((root) => {
    const resolved = canonicalPathForContainment(root);

    return resolved === undefined ? [] : [resolved];
  });

  if (roots.length === 0) {
    return false;
  }

  for (const rawPath of paths) {
    const resolved = resolvePermissionPath(rawPath, cwd);

    if (resolved === undefined) {
      return false;
    }

    const canonical = canonicalPathForContainment(resolved);

    if (
      canonical === undefined ||
      !roots.some((root) => pathIsWithinRoot(canonical, root))
    ) {
      return false;
    }
  }

  return true;
}

function selectOption(
  options: readonly AcpPermissionOption[],
  decision: "allow" | "deny",
): AcpPermissionOutcome {
  if (decision === "allow") {
    const allowOnce =
      options.find((option) => option.kind === "allow_once") ??
      options.find(
        (option) =>
          option.kind !== "reject_once" &&
          option.kind !== "reject_always" &&
          option.kind !== "allow_always",
      );

    return allowOnce
      ? { outcome: "selected", optionId: allowOnce.optionId }
      : { outcome: "cancelled" };
  }

  const rejectOnce =
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind === "reject_always");

  return rejectOnce
    ? { outcome: "selected", optionId: rejectOnce.optionId }
    : { outcome: "cancelled" };
}

/**
 * Evaluate one incoming ACP `session/request_permission` against Stargate's
 * fail-closed policy. Never selects `allow_always`.
 */
export function evaluateAcpPermission(
  policy: AcpPermissionPolicy,
  cwd: string,
  extraRoots: readonly string[],
  request: AcpPermissionRequest,
): AcpPermissionOutcome {
  if (policy === "deny") {
    return selectOption(request.options, "deny");
  }

  if (policy === "allow-all") {
    return selectOption(request.options, "allow");
  }

  // `workspace-write`: allow read/search/think/fetch, and allow file mutations
  // Strictly inside canonical `cwd` + `extraRoots`. Deny shell/execute and unknown.
  const kind = request.toolCall.kind;

  if (kind !== undefined && READ_ONLY_KINDS.has(kind)) {
    return selectOption(request.options, "allow");
  }

  if (kind !== undefined && MUTATING_KINDS.has(kind)) {
    const changed = changedPathsOfToolCall(request.toolCall);

    return selectOption(
      request.options,
      allPathsWithinRoots(changed, cwd, extraRoots) ? "allow" : "deny",
    );
  }

  return selectOption(request.options, "deny");
}
