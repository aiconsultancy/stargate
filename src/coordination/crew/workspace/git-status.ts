import { createHash } from "node:crypto";
import { resolve } from "node:path";

const statusSettings =
  /^(core\.(filemode|ignorecase|symlinks|precomposeunicode|autocrlf|eol|sparsecheckout|sparsecheckoutcone|checkstat|trustctime|ignorestat)|(diff|status)\.renames)$/;

export const statusConfigArgs = [
  "config",
  "--null",
  "--get-regexp",
  statusSettings.source,
];

export const excludesConfigArgs = [
  "config",
  "--null",
  "--path",
  "--get",
  "core.excludesFile",
];

/** The ignore file is data, not a status setting to forward unchanged. */
export function configuredExcludesPath(directory: string, output: string) {
  const [path, terminator, ...rest] = output.split("\0");

  return path && !/[\r\n]/.test(path) && terminator === "" && rest.length === 0
    ? resolve(directory, path)
    : undefined;
}

export const fleetGitEnv = {
  GIT_ALLOW_PROTOCOL: "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

export const fleetGitOptions = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "submodule.recurse=false",
];

/** Run in a private Git directory with no info/attributes or filter config. */
export function isolatedGitStatus(
  directory: string,
  gitDir: string,
  format: "sha1" | "sha256",
  config: string,
  excludes: string,
) {
  const settings: string[] = [];

  for (const entry of config.split("\0")) {
    const [key, value = "true", ...rest] = entry.split("\n");

    if (
      key &&
      statusSettings.test(key) &&
      rest.length === 0 &&
      !value.includes("\r")
    ) {
      settings.push("-c", `${key}=${value}`);
    }
  }

  return {
    env: {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: directory,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_ATTR_SOURCE: createHash(format).update("tree 0\0").digest("hex"),
    },
    args: [
      ...settings,
      "-c",
      `core.excludesFile=${excludes}`,
      "-c",
      "core.attributesFile=/dev/null",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // Count changed gitlinks without reading submodule worktrees.
      "--ignore-submodules=dirty",
    ],
  };
}
