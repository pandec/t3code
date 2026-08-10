#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const MAC_APP_PATH = "/Applications/T3 Code (Dev).app";
const MAC_APP_PROCESS = "T3 Code (Dev)";
const MAC_APP_PROCESS_PATTERN = escapeProcessNameForExactMatch(MAC_APP_PROCESS);
const MAC_APP_ID = "com.t3tools.t3code.dev";
const LINUX_APP_PROCESS = "t3code-dev";
const LINUX_SERVICE = "t3code.service";
const PROCESS_STATE_ATTEMPTS = 20;
const PROCESS_POLL_INTERVAL = Duration.millis(250);
// The launches we saw fail died within ~1.3s, so watch a little longer than
// that before believing the app started.
const STARTUP_STABILITY_WINDOW = Duration.seconds(2);
const STARTUP_STABILITY_SAMPLES = Math.ceil(
  Duration.toMillis(STARTUP_STABILITY_WINDOW) / Duration.toMillis(PROCESS_POLL_INTERVAL),
);
// A pause before the second attempt, on the assumption that a launch dying on
// arrival is the moment least worth relaunching into. It only costs time on a
// path that has already failed.
const RELAUNCH_BACKOFF = Duration.seconds(2);
const MAC_DIAGNOSTICS_HINT = `Inspect the launch with: log show --predicate 'process == "${MAC_APP_PROCESS}"' --last 5m`;
const LINUX_DIAGNOSTICS_HINT = `Inspect the launch with: journalctl --user -u ${LINUX_SERVICE} -n 100`;

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
  readonly env?: Record<string, string>;
}

// `open` hands our environment to the app it launches, and ELECTRON_RUN_AS_NODE
// makes an Electron binary run as plain Node — so the app we just installed
// would run nothing and exit within ~50ms, leaving no window and no logs of its
// own. Anything descended from a process that was itself started with that
// variable carries it (an editor launched from a poisoned shell hands it to
// every terminal and agent session it spawns, for the life of that instance),
// so scrub it here rather than trusting the ambient environment.
// apps/desktop/scripts/{dev,start}-electron.mjs strip it for the same reason.
const LAUNCH_ENV_BLOCKLIST = new Set(["ELECTRON_RUN_AS_NODE"]);

export function launchEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !LAUNCH_ENV_BLOCKLIST.has(key)) {
      environment[key] = value;
    }
  }
  return environment;
}

function formatCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

function asDesktopInstallError(message: string, cause: unknown): DesktopInstallError {
  return cause instanceof DesktopInstallError ? cause : new DesktopInstallError({ message, cause });
}

export function escapeProcessNameForExactMatch(processName: string): string {
  return processName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
        ...(options.env ? { env: options.env } : {}),
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
  processPattern: string,
) {
  for (let attempt = 0; attempt < PROCESS_STATE_ATTEMPTS; attempt += 1) {
    if (!(yield* commandSucceeds(spawner, "pgrep", ["-x", processPattern]))) return true;
    yield* Effect.sleep(PROCESS_POLL_INTERVAL);
  }
  return !(yield* commandSucceeds(spawner, "pgrep", ["-x", processPattern]));
});

const waitForAppToAppear = Effect.fn("installDesktopDev.waitForAppToAppear")(function* (
  isRunning: Effect.Effect<boolean, DesktopInstallError>,
  delay: Effect.Effect<void>,
) {
  for (let attempt = 0; attempt < PROCESS_STATE_ATTEMPTS; attempt += 1) {
    if (yield* isRunning) return true;
    yield* delay;
  }
  return yield* isRunning;
});

// Seeing the process once proves it launched, not that it survived. A leaked
// ELECTRON_RUN_AS_NODE used to make the installed bundle run as plain Node and
// exit within ~50ms, which the first-sighting check happily reported as a
// successful launch; launchEnvironment now strips that, but anything else that
// kills the app on arrival should surface as an error rather than a silent
// no-op. Confirm the process is still there before reporting success.
export const waitForAppToStart = Effect.fn("installDesktopDev.waitForAppToStart")(function* (
  isRunning: Effect.Effect<boolean, DesktopInstallError>,
  delay: Effect.Effect<void> = Effect.sleep(PROCESS_POLL_INTERVAL),
) {
  if (!(yield* waitForAppToAppear(isRunning, delay))) return false;

  for (let sample = 0; sample < STARTUP_STABILITY_SAMPLES; sample += 1) {
    yield* delay;
    if (!(yield* isRunning)) return false;
  }
  return true;
});

export const startAppWithVerification = Effect.fn("installDesktopDev.startAppWithVerification")(
  function* (
    appName: string,
    start: Effect.Effect<void, DesktopInstallError>,
    waitForStart: () => Effect.Effect<boolean, DesktopInstallError>,
    // An app that dies on arrival leaves no log of its own, so the error has to
    // say where the evidence actually is.
    diagnosticsHint: string,
    backoff: Effect.Effect<void> = Effect.sleep(RELAUNCH_BACKOFF),
  ) {
    yield* start;
    if (yield* waitForStart()) return;
    yield* backoff;
    yield* start;
    if (!(yield* waitForStart())) {
      return yield* new DesktopInstallError({
        message: `${appName} did not start. ${diagnosticsHint}`,
        cause: undefined,
      });
    }
  },
);

export const terminateProcessWithEscalation = Effect.fn(
  "installDesktopDev.terminateProcessWithEscalation",
)(function* (
  processName: string,
  terminate: (signal: "TERM" | "KILL") => Effect.Effect<void, DesktopInstallError>,
  waitForStop: () => Effect.Effect<boolean, DesktopInstallError>,
) {
  yield* terminate("TERM");
  if (yield* waitForStop()) return;
  yield* terminate("KILL");
  if (!(yield* waitForStop())) {
    return yield* new DesktopInstallError({
      message: `${processName} did not stop`,
      cause: undefined,
    });
  }
});

const terminateProcess = Effect.fn("installDesktopDev.terminateProcess")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  processName: string,
  processPattern: string,
) {
  yield* terminateProcessWithEscalation(
    processName,
    (signal) => runCommand(spawner, "pkill", [`-${signal}`, "-x", processPattern]),
    () => waitForProcessToStop(spawner, processPattern),
  );
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

// pgrep matches on the executable name, and the embedded backend runs the same
// binary through process.execPath — so `pgrep -x "T3 Code (Dev)"` reports both
// the app and its backend child, and a lingering child reads as "the app is
// running". Ask LaunchServices about the bundle instead: it only knows the GUI
// app. Empty output means it is not running. Stopping still waits on the
// executable name, which is the stricter check and leaves no orphaned backend
// behind.
export function parseMacRunningAppPid(output: string): number | undefined {
  const match = /"pid"\s*=\s*(\d+)/u.exec(output);
  if (!match?.[1]) return undefined;
  const pid = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function parseMacDmgMountPoint(output: string): string | undefined {
  const line = output.split("\n").find((candidate) => candidate.includes("/Volumes/"));
  return line?.slice(line.indexOf("/Volumes/")).trim() || undefined;
}

// Stopping now runs on every install, including when the app is already closed,
// so only send the Apple Event when something is there to receive it. Reading
// `is running` does not launch the app. The pgrep/pkill path below stays
// unconditional — that is what reaps a backend child that outlived its app.
export function macQuitScript(bundleId: string): string {
  return [
    `if application id "${bundleId}" is running then`,
    `  tell application id "${bundleId}" to quit`,
    "end if",
  ].join("\n");
}

const stopMacApp = Effect.fn("installDesktopDev.stopMacApp")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  yield* commandSucceeds(spawner, "osascript", ["-e", macQuitScript(MAC_APP_ID)]);
  if (yield* waitForProcessToStop(spawner, MAC_APP_PROCESS_PATTERN)) return;
  yield* terminateProcess(spawner, MAC_APP_PROCESS, MAC_APP_PROCESS_PATTERN);
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
  // Empty output is the ordinary "not running" answer, so only a genuine
  // failure to reach LaunchServices is an error. Swallowing that would let a
  // running app read as absent and have its bundle replaced underneath it.
  const isRunning = captureCommand(spawner, "lsappinfo", ["info", "-only", "pid", MAC_APP_ID]).pipe(
    Effect.map((output) => parseMacRunningAppPid(output) !== undefined),
  );
  const start = runCommand(spawner, "open", [MAC_APP_PATH], { env: launchEnvironment() });
  return {
    isRunning,
    stop: stopMacApp(spawner),
    build: runCommand(spawner, "vp", ["run", "dist:desktop:dev"], { cwd: repoRoot }),
    install: installMacArtifact(spawner, fs, path, releaseDirectory),
    start: startAppWithVerification(
      MAC_APP_PROCESS,
      start,
      () => waitForAppToStart(isRunning),
      MAC_DIAGNOSTICS_HINT,
    ),
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
  yield* terminateProcess(spawner, LINUX_APP_PROCESS, LINUX_APP_PROCESS);
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
  const isRunning = Effect.gen(function* () {
    const serviceRunning = yield* commandSucceeds(spawner, "systemctl", [
      "--user",
      "is-active",
      "--quiet",
      LINUX_SERVICE,
    ]);
    return serviceRunning || (yield* commandSucceeds(spawner, "pgrep", ["-x", LINUX_APP_PROCESS]));
  });
  // No launchEnvironment() here: `systemctl --user start` asks the user manager
  // to start the unit, so the unit's own environment applies and ours is never
  // forwarded. Scrubbing the client side would only look like protection.
  const start = runCommand(spawner, "systemctl", ["--user", "start", LINUX_SERVICE]);
  return {
    isRunning,
    stop: stopLinuxApp(spawner),
    build: runCommand(spawner, "vp", ["run", "dist:desktop:dev:linux"], { cwd: repoRoot }),
    install: installLinuxArtifact(spawner, fs, path, repoRoot, homeDirectory),
    start: startAppWithVerification(
      "T3 Code (Dev)",
      start,
      () => waitForAppToStart(isRunning),
      LINUX_DIAGNOSTICS_HINT,
    ),
  } satisfies DesktopInstallLifecycle;
});

export const runDesktopInstallLifecycle = Effect.fn("runDesktopInstallLifecycle")(function* (
  lifecycle: DesktopInstallLifecycle,
) {
  // wasRunning only decides whether to put the app back after a failed build or
  // install. Stopping is not gated on it: isRunning answers "is the app up",
  // while stop reaps every process belonging to the bundle, including a backend
  // child that outlived its app. Skipping it when the app looks absent would
  // leave that orphan running against the same T3 home as the new install.
  // Stopping when nothing is running is a no-op.
  const wasRunning = yield* lifecycle.isRunning;
  const install = Effect.gen(function* () {
    yield* lifecycle.stop;
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
