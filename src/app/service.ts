import { execFile } from "node:child_process";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { mainEntrypoint } from "../lib/installation-paths";

const systemctl = async (...args: string[]) => {
  try {
    return await exec("systemctl", ["--user", ...args]);
  } catch {
    throw new Error(
      "systemctl --user failed. Check that systemd and your user session bus are available.",
    );
  }
};

const marker = "# Managed by Stargate CLI";
const exec = promisify(execFile);

export function serviceName(name = "stargate") {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error("Invalid service name.");
  }

  return `${name}.service`;
}

export function quote(value: string, command = false) {
  if (
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error("Service paths cannot contain control characters.");
  }

  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => (command ? "$$" : "$"))}"`;
}

export function buildUnit(
  configPath: string,
  executable = process.execPath,
  entrypoint = mainEntrypoint,
) {
  for (const path of [configPath, executable, entrypoint]) {
    if (!isAbsolute(path)) {
      throw new Error("Service paths must be absolute.");
    }
  }

  return `${marker}
[Unit]
Description=Stargate Slack assistant
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${dirname(configPath).replaceAll("%", "%%")}/
EnvironmentFile=-${`${configPath}.env`.replaceAll("%", "%%")}
ExecStart=${quote(executable, true)} ${quote(entrypoint, true)} start --config ${quote(configPath, true)}
UMask=0077
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export async function manageService(
  action: string,
  configPath: string,
  name = "stargate",
) {
  if (process.platform !== "linux") {
    throw new Error("User services require Linux with systemd.");
  }

  const unit = serviceName(name);
  const path = join(homedir(), ".config/systemd/user", unit);

  if (action === "install") {
    await mkdir(dirname(path), { recursive: true });
    const contents = buildUnit(resolve(configPath));
    let file: FileHandle;

    try {
      file = await open(path, "wx", 0o600);
    } catch {
      throw new Error(
        "Service file exists or cannot be created. Refusing to overwrite it.",
      );
    }

    try {
      await file.writeFile(contents);
    } finally {
      await file.close();
    }

    await systemctl("daemon-reload");
    console.log(
      `Installed ${unit}. Start: systemctl --user start ${unit}\nEnable at login: systemctl --user enable ${unit}`,
    );

    return;
  }

  if (action === "uninstall") {
    let content: string;

    try {
      content = await readFile(path, "utf8");
    } catch {
      throw new Error("Cannot read installed service.");
    }

    if (!content.startsWith(`${marker}\n`)) {
      throw new Error("Refusing to remove an unrelated service.");
    }

    await systemctl("disable", "--now", unit);
    await unlink(path);
    await systemctl("daemon-reload");
    console.log(`Removed ${unit}.`);

    return;
  }

  if (!["start", "stop", "status"].includes(action)) {
    throw new Error("Unknown service command.");
  }

  // `show` succeeds for an inactive service, unlike `status`.
  const result =
    action === "status"
      ? await systemctl(
          "show",
          unit,
          "--property=LoadState,ActiveState,SubState,UnitFileState",
          "--no-pager",
        )
      : await systemctl(action, unit);

  if (result.stdout) {
    console.log(result.stdout.trimEnd());
  }
}
