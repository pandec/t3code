// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface BackgroundService {
  readonly name: string;
  readonly home: string | undefined;
  readonly restartCommand: string;
}

export function defaultT3Home(): string {
  return NodePath.resolve(process.env["T3CODE_HOME"] || NodePath.join(NodeOS.homedir(), ".t3"));
}

// A service without T3CODE_HOME serves the default home, whatever this shell's T3CODE_HOME says.
export function serviceOwnsHome(service: BackgroundService, home: string): boolean {
  return (service.home ?? NodePath.join(NodeOS.homedir(), ".t3")) === home;
}

// Mirrors `bootServiceBaseDirOf` in apps/server/src/cloud/bootService.ts, which scripts can't import.
function unitHomeOf(unit: string): string | undefined {
  const raw = /^Environment=T3CODE_HOME=(.*)$/m.exec(unit)?.[1]?.trim();
  if (raw === undefined) return undefined;
  const value =
    raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
      : raw;
  return NodePath.resolve(value.replaceAll("%%", "%"));
}

export function installedBackgroundService(
  platform: NodeJS.Platform,
): BackgroundService | undefined {
  if (platform === "linux") {
    const unit = NodeChildProcess.spawnSync("systemctl", ["--user", "cat", "t3code.service"], {
      encoding: "utf8",
    });
    if (unit.status !== 0) return undefined;
    return {
      name: "t3code.service",
      home: unitHomeOf(unit.stdout),
      restartCommand: "systemctl --user restart t3code.service",
    };
  }
  if (platform !== "darwin") return undefined;
  const launchAgent = NodePath.join(
    NodeOS.homedir(),
    "Library/LaunchAgents/com.t3tools.t3code.service.plist",
  );
  if (!NodeFS.existsSync(launchAgent)) return undefined;
  const home = NodeChildProcess.spawnSync(
    "plutil",
    ["-extract", "EnvironmentVariables.T3CODE_HOME", "raw", "-o", "-", launchAgent],
    { encoding: "utf8" },
  );
  return {
    name: "com.t3tools.t3code.service",
    home: home.status === 0 ? NodePath.resolve(home.stdout.trim()) : undefined,
    restartCommand: `launchctl kickstart -k gui/${String(process.getuid?.())}/com.t3tools.t3code.service`,
  };
}
