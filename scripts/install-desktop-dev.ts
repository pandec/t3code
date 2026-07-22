#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const MAC_APP_PATH = "/Applications/T3 Code (Dev).app";
const MAC_APP_PROCESS = "T3 Code (Dev)";
const MAC_APP_ID = "com.t3tools.t3code.dev";
const LINUX_APP_PROCESS = "t3code-dev";
const LINUX_SERVICE = "t3code.service";
const PROCESS_STOP_ATTEMPTS = 20;

export class DesktopInstallError extends Data.TaggedError("DesktopInstallError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

interface DesktopInstallLifecycle {
  readonly isRunning: Effect.Effect<boolean, DesktopInstallError>;
  readonly stop: Effect.Effect<void, DesktopInstallError>;
  readonly build: Effect.Effect<void, DesktopInstallError>;
  readonly install: Effect.Effect<void, DesktopInstallError>;
  readonly start: Effect.Effect<void, DesktopInstallError>;
}

interface CommandOptions {
  readonly cwd?: string;
  readonly quiet?: boolean;
}

function formatCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

function asDesktopInstallError(message: string, cause: unknown): DesktopInstallError {
  return cause instanceof DesktopInstallError ? cause : new DesktopInstallError({ message, cause });
}

const runCommand = Effect.fn("installDesktopDev.runCommand")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    command: string,
    args: ReadonlyArray<string>,
    options: CommandOptions = {},
  ) {
    const output = options.quiet ? "ignore" : "inherit";
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        cwd: options.cwd,
        stdin: "ignore",
        stdout: output,
        stderr: output,
      }),
    );
    if (Number(exitCode) !== 0) {
      return yield* new DesktopInstallError({
        message: `${formatCommand(command, args)} failed with exit code ${String(exitCode)}`,
        cause: exitCode,
      });
    }
  },
  Effect.mapError((cause) => asDesktopInstallError("Command execution failed", cause)),
);

const captureCommand = Effect.fn("installDesktopDev.captureCommand")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    command: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* spawner.string(
      ChildProcess.make(command, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      }),
    );
  },
  Effect.mapError((cause) => asDesktopInstallError("Command output capture failed", cause)),
);

const commandSucceeds = Effect.fn("installDesktopDev.commandSucceeds")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
) {
  return yield* runCommand(spawner, command, args, { quiet: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

const waitForProcessToStop = Effect.fn("installDesktopDev.waitForProcessToStop")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  processName: string,
) {
  for (let attempt = 0; attempt < PROCESS_STOP_ATTEMPTS; attempt += 1) {
    if (!(yield* commandSucceeds(spawner, "pgrep", ["-x", processName]))) return true;
    yield* Effect.sleep("250 millis");
  }
  return !(yield* commandSucceeds(spawner, "pgrep", ["-x", processName]));
});

const findLatestArtifact = Effect.fn("installDesktopDev.findLatestArtifact")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    directory: string,
    prefix: string,
    suffix: string,
  ) {
    const entries = yield* fs.readDirectory(directory);
    const candidates = yield* Effect.forEach(
      entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix)),
      (entry) =>
        Effect.gen(function* () {
          const artifactPath = path.join(directory, entry);
          const info = yield* fs.stat(artifactPath);
          if (info.type !== "File") return undefined;
          return {
            artifactPath,
            modifiedAt: Option.match(info.mtime, {
              onNone: () => 0,
              onSome: (value) => value.getTime(),
            }),
          };
        }),
    );
    const latest = candidates
      .filter((candidate) => candidate !== undefined)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
    if (!latest) {
      return yield* new DesktopInstallError({
        message: `No ${prefix}*${suffix} artifact found in ${directory}`,
        cause: undefined,
      });
    }
    return latest.artifactPath;
  },
  Effect.mapError((cause) => asDesktopInstallError("Failed to inspect desktop artifacts", cause)),
);

export function parseMacDmgMountPoint(output: string): string | undefined {
  const line = output.split("\n").find((candidate) => candidate.includes("/Volumes/"));
  return line?.slice(line.indexOf("/Volumes/")).trim() || undefined;
}

const stopMacApp = Effect.fn("installDesktopDev.stopMacApp")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  yield* commandSucceeds(spawner, "osascript", [
    "-e",
    `tell application id "${MAC_APP_ID}" to quit`,
  ]);
  if (yield* waitForProcessToStop(spawner, MAC_APP_PROCESS)) return;
  yield* runCommand(spawner, "pkill", ["-x", MAC_APP_PROCESS]);
  if (!(yield* waitForProcessToStop(spawner, MAC_APP_PROCESS))) {
    return yield* new DesktopInstallError({
      message: `${MAC_APP_PROCESS} did not stop`,
      cause: undefined,
    });
  }
});

const installMacArtifact = Effect.fn("installDesktopDev.installMacArtifact")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    fs: FileSystem.FileSystem,
    path: Path.Path,
    releaseDirectory: string,
  ) {
    const dmgPath = yield* findLatestArtifact(fs, path, releaseDirectory, "T3-Code-Dev-", ".dmg");
    let mountPoint: string | undefined;
    let temporaryAppPath: string | undefined;

    const install = Effect.gen(function* () {
      mountPoint = parseMacDmgMountPoint(
        yield* captureCommand(spawner, "hdiutil", ["attach", "-nobrowse", "-readonly", dmgPath]),
      );
      if (!mountPoint) {
        return yield* new DesktopInstallError({
          message: `Could not determine the mount point for ${dmgPath}`,
          cause: undefined,
        });
      }

      const sourceAppPath = path.join(mountPoint, "T3 Code (Dev).app");
      const sourceInfo = yield* fs.stat(sourceAppPath);
      if (sourceInfo.type !== "Directory") {
        return yield* new DesktopInstallError({
          message: `${sourceAppPath} is missing from the DMG`,
          cause: undefined,
        });
      }

      temporaryAppPath = `/Applications/.T3 Code (Dev).app.installing.${String(process.pid)}`;
      yield* fs.remove(temporaryAppPath, { recursive: true, force: true });
      yield* runCommand(spawner, "ditto", [sourceAppPath, temporaryAppPath]);
      yield* fs.remove(MAC_APP_PATH, { recursive: true, force: true });
      yield* fs.rename(temporaryAppPath, MAC_APP_PATH);
      temporaryAppPath = undefined;
    });

    yield* install.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (mountPoint) yield* commandSucceeds(spawner, "hdiutil", ["detach", mountPoint]);
          if (temporaryAppPath) {
            yield* fs
              .remove(temporaryAppPath, { recursive: true, force: true })
              .pipe(Effect.ignore);
          }
        }),
      ),
    );
    yield* Effect.log(`Installed ${MAC_APP_PATH}`);
  },
  Effect.mapError((cause) => asDesktopInstallError("Failed to install the macOS Dev app", cause)),
);

const createMacLifecycle = Effect.fn("installDesktopDev.createMacLifecycle")(function* (
  repoRoot: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const releaseDirectory = path.join(repoRoot, "release-dev");
  return {
    isRunning: commandSucceeds(spawner, "pgrep", ["-x", MAC_APP_PROCESS]),
    stop: stopMacApp(spawner),
    build: runCommand(spawner, "vp", ["run", "dist:desktop:dev"], { cwd: repoRoot }),
    install: installMacArtifact(spawner, fs, path, releaseDirectory),
    start: runCommand(spawner, "open", [MAC_APP_PATH]),
  } satisfies DesktopInstallLifecycle;
});

const stopLinuxApp = Effect.fn("installDesktopDev.stopLinuxApp")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  if (
    yield* commandSucceeds(spawner, "systemctl", ["--user", "is-active", "--quiet", LINUX_SERVICE])
  ) {
    yield* runCommand(spawner, "systemctl", ["--user", "stop", LINUX_SERVICE]);
  }
  if (!(yield* commandSucceeds(spawner, "pgrep", ["-x", LINUX_APP_PROCESS]))) return;

  yield* runCommand(spawner, "pkill", ["-TERM", "-x", LINUX_APP_PROCESS]);
  if (yield* waitForProcessToStop(spawner, LINUX_APP_PROCESS)) return;
  yield* runCommand(spawner, "pkill", ["-KILL", "-x", LINUX_APP_PROCESS]);
  if (!(yield* waitForProcessToStop(spawner, LINUX_APP_PROCESS))) {
    return yield* new DesktopInstallError({
      message: `${LINUX_APP_PROCESS} did not stop`,
      cause: undefined,
    });
  }
});

function linuxDesktopEntry(appPath: string): string {
  return `${[
    "[Desktop Entry]",
    "Type=Application",
    "Name=T3 Code (Dev)",
    "Comment=T3 Code desktop build",
    `Exec=${appPath} --no-sandbox %U`,
    "Icon=t3code-dev",
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=t3code-dev",
    "StartupNotify=true",
    "MimeType=x-scheme-handler/t3code-dev;",
  ].join("\n")}\n`;
}

const installLinuxArtifact = Effect.fn("installDesktopDev.installLinuxArtifact")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    fs: FileSystem.FileSystem,
    path: Path.Path,
    repoRoot: string,
    homeDirectory: string,
  ) {
    const releaseDirectory = path.join(repoRoot, "release-dev");
    const artifactPath = yield* findLatestArtifact(
      fs,
      path,
      releaseDirectory,
      "T3-Code-Dev-",
      ".AppImage",
    );
    const installDirectory = path.join(homeDirectory, ".local/opt/t3code-dev");
    const appPath = path.join(installDirectory, "T3-Code-Dev.AppImage");
    const temporaryAppPath = path.join(
      installDirectory,
      `.T3-Code-Dev.AppImage.installing.${String(process.pid)}`,
    );
    const applicationsDirectory = path.join(homeDirectory, ".local/share/applications");
    const desktopEntryPath = path.join(applicationsDirectory, "t3code-dev.desktop");
    const iconsDirectory = path.join(homeDirectory, ".local/share/icons/hicolor");
    const iconSource = path.join(repoRoot, "assets/prod/black-universal-1024.png");

    yield* fs.makeDirectory(installDirectory, { recursive: true });
    yield* fs.makeDirectory(applicationsDirectory, { recursive: true });
    yield* Effect.gen(function* () {
      yield* fs.copyFile(artifactPath, temporaryAppPath);
      yield* fs.chmod(temporaryAppPath, 0o755);
      yield* fs.rename(temporaryAppPath, appPath);
    }).pipe(Effect.ensuring(fs.remove(temporaryAppPath, { force: true }).pipe(Effect.ignore)));

    for (const iconSize of [16, 32, 48, 64, 128, 256, 512]) {
      const iconDirectory = path.join(
        iconsDirectory,
        `${String(iconSize)}x${String(iconSize)}/apps`,
      );
      const iconPath = path.join(iconDirectory, "t3code-dev.png");
      yield* fs.makeDirectory(iconDirectory, { recursive: true });
      yield* runCommand(spawner, "magick", [
        iconSource,
        "-resize",
        `${String(iconSize)}x${String(iconSize)}`,
        iconPath,
      ]);
      yield* fs.chmod(iconPath, 0o644);
    }

    yield* fs.writeFileString(desktopEntryPath, linuxDesktopEntry(appPath));
    yield* runCommand(spawner, "desktop-file-validate", [desktopEntryPath]);
    yield* runCommand(spawner, "systemctl", ["--user", "daemon-reload"]);
    yield* commandSucceeds(spawner, "update-desktop-database", [applicationsDirectory]);
    yield* runCommand(spawner, "gtk-update-icon-cache", ["-f", "-t", iconsDirectory], {
      quiet: true,
    });
    yield* Effect.log(`Installed ${appPath}`);
  },
  Effect.mapError((cause) => asDesktopInstallError("Failed to install the Linux Dev app", cause)),
);

const createLinuxLifecycle = Effect.fn("installDesktopDev.createLinuxLifecycle")(function* (
  repoRoot: string,
  homeDirectory: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return {
    isRunning: Effect.gen(function* () {
      const serviceRunning = yield* commandSucceeds(spawner, "systemctl", [
        "--user",
        "is-active",
        "--quiet",
        LINUX_SERVICE,
      ]);
      return (
        serviceRunning || (yield* commandSucceeds(spawner, "pgrep", ["-x", LINUX_APP_PROCESS]))
      );
    }),
    stop: stopLinuxApp(spawner),
    build: runCommand(spawner, "vp", ["run", "dist:desktop:dev:linux"], { cwd: repoRoot }),
    install: installLinuxArtifact(spawner, fs, path, repoRoot, homeDirectory),
    start: runCommand(spawner, "systemctl", ["--user", "start", LINUX_SERVICE]),
  } satisfies DesktopInstallLifecycle;
});

export const runDesktopInstallLifecycle = Effect.fn("runDesktopInstallLifecycle")(function* (
  lifecycle: DesktopInstallLifecycle,
) {
  const wasRunning = yield* lifecycle.isRunning;
  const install = Effect.gen(function* () {
    if (wasRunning) yield* lifecycle.stop;
    yield* lifecycle.build;
    yield* lifecycle.install;
  });

  yield* install.pipe(
    Effect.catch((error) =>
      wasRunning
        ? Effect.gen(function* () {
            const restart = yield* Effect.exit(lifecycle.start);
            if (Exit.isFailure(restart)) {
              return yield* new DesktopInstallError({
                message: "Desktop install failed and the previous app could not be restarted",
                cause: [error, Cause.squash(restart.cause)],
              });
            }
            return yield* error;
          })
        : Effect.fail(error),
    ),
  );
  yield* lifecycle.start;
});

const main = Effect.fn("installDesktopDev.main")(function* () {
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const lifecycle =
    hostPlatform === "darwin"
      ? yield* createMacLifecycle(repoRoot)
      : hostPlatform === "linux"
        ? yield* createLinuxLifecycle(repoRoot, NodeOS.homedir())
        : undefined;
  if (!lifecycle) {
    return yield* new DesktopInstallError({
      message: `Installing the T3 Code Dev desktop app is unsupported on ${hostPlatform}`,
      cause: undefined,
    });
  }
  yield* runDesktopInstallLifecycle(lifecycle);
});

if (import.meta.main) {
  main().pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
