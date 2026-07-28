#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { loadRepoEnv } from "./lib/public-config.ts";

const SCHEME = "T3Code";
const ARTIFACT_DIRECTORY = "local/ios-testflight";
// CFBundleVersion must strictly increase per upload and stay well inside a 32-bit
// integer, so count minutes since a fixed epoch rather than using a wall-clock
// stamp. That is monotonic, needs no checked-in counter, and only collides if two
// uploads start within the same minute.
const BUILD_NUMBER_EPOCH_MS = Date.UTC(2026, 0, 1);

export class IosTestFlightError extends Data.TaggedError("IosTestFlightError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function formatCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

function asIosTestFlightError(message: string, cause: unknown): IosTestFlightError {
  return cause instanceof IosTestFlightError ? cause : new IosTestFlightError({ message, cause });
}

const runCommand = Effect.fn("iosTestFlight.runCommand")(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    command: string,
    args: ReadonlyArray<string>,
    options: CommandOptions = {},
  ) {
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (Number(exitCode) !== 0) {
      return yield* new IosTestFlightError({
        message: `${formatCommand(command, args)} failed with exit code ${String(exitCode)}`,
        cause: exitCode,
      });
    }
  },
  Effect.mapError((cause) => asIosTestFlightError("Command execution failed", cause)),
);

export function resolveBuildNumber(nowMs: number): string {
  return String(Math.floor((nowMs - BUILD_NUMBER_EPOCH_MS) / 60_000));
}

export function renderExportOptionsPlist(teamId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>${teamId}</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
    <!-- Xcode otherwise rewrites the build number it finds in App Store Connect,
         which would discard the value the prebuild baked into Info.plist. -->
    <key>manageAppVersionAndBuildNumber</key>
    <false/>
  </dict>
</plist>
`;
}

interface TestFlightSettings {
  readonly teamId: string;
  readonly keyId: string;
  readonly issuerId: string;
  readonly keyPath: string;
}

export function resolveSettings(
  env: Readonly<Record<string, string | undefined>>,
): TestFlightSettings | { readonly missing: ReadonlyArray<string> } {
  if (env.T3CODE_IOS_PERSONAL_TEAM === "1") {
    return {
      missing: [
        "T3CODE_IOS_PERSONAL_TEAM must not be 1: a Personal Team cannot sign App Store builds",
      ],
    };
  }
  const required = {
    teamId: "T3CODE_APPLE_TEAM_ID",
    keyId: "T3CODE_ASC_KEY_ID",
    issuerId: "T3CODE_ASC_ISSUER_ID",
    keyPath: "T3CODE_ASC_KEY_PATH",
  } as const;
  const missing = Object.values(required).filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { missing };
  return {
    teamId: env[required.teamId]!.trim().toUpperCase(),
    keyId: env[required.keyId]!.trim(),
    issuerId: env[required.issuerId]!.trim(),
    keyPath: env[required.keyPath]!.trim(),
  };
}

const main = Effect.fn("iosTestFlight.main")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const mobileDir = path.join(repoRoot, "apps", "mobile");

  const repoEnv = loadRepoEnv();
  const settings = resolveSettings(repoEnv);
  if ("missing" in settings) {
    return yield* new IosTestFlightError({
      message: `Cannot upload to TestFlight. Fix in .env.local: ${settings.missing.join(", ")}`,
      cause: undefined,
    });
  }

  const keyPath = path.isAbsolute(settings.keyPath)
    ? settings.keyPath
    : path.join(repoRoot, settings.keyPath);
  if (!(yield* fs.exists(keyPath))) {
    return yield* new IosTestFlightError({
      message: `App Store Connect key not found at ${keyPath}. The .p8 downloads only once; regenerate it if it was lost.`,
      cause: undefined,
    });
  }
  // altool locates the key by name inside this directory, so the file must keep
  // App Store Connect's AuthKey_<keyId>.p8 filename.
  const expectedKeyFileName = `AuthKey_${settings.keyId}.p8`;
  if (path.basename(keyPath) !== expectedKeyFileName) {
    return yield* new IosTestFlightError({
      message: `Expected the key file to be named ${expectedKeyFileName} but found ${path.basename(keyPath)}.`,
      cause: undefined,
    });
  }

  const buildNumber = resolveBuildNumber(Date.now());
  const artifactDir = path.join(repoRoot, ARTIFACT_DIRECTORY);
  const archivePath = path.join(artifactDir, `${SCHEME}.xcarchive`);
  const exportDir = path.join(artifactDir, "export");
  const exportOptionsPath = path.join(artifactDir, "ExportOptions.plist");

  yield* fs.remove(artifactDir, { recursive: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(artifactDir, { recursive: true });
  yield* fs.writeFileString(exportOptionsPath, renderExportOptionsPlist(settings.teamId));

  const buildEnv = {
    ...process.env,
    APP_VARIANT: "production",
    T3CODE_IOS_BUILD_NUMBER: buildNumber,
    EXPO_NO_GIT_STATUS: "1",
  };

  yield* Effect.log(
    `[ios-testflight] Building ${repoEnv.T3CODE_IOS_BUNDLE_ID ?? "the mobile app"} version ${repoEnv.T3CODE_FORK_VERSION ?? "0.1.0"} build ${buildNumber}.`,
  );

  yield* Effect.log("[ios-testflight] Generating the native iOS project...");
  yield* runCommand(spawner, "vp", ["exec", "expo", "prebuild", "--clean", "--platform", "ios"], {
    cwd: mobileDir,
    env: buildEnv,
  });

  const authenticationArgs = [
    "-allowProvisioningUpdates",
    "-authenticationKeyPath",
    keyPath,
    "-authenticationKeyID",
    settings.keyId,
    "-authenticationKeyIssuerID",
    settings.issuerId,
  ];

  yield* Effect.log("[ios-testflight] Archiving (this takes a while)...");
  yield* runCommand(
    spawner,
    "xcodebuild",
    [
      "-workspace",
      path.join(mobileDir, "ios", `${SCHEME}.xcworkspace`),
      "-scheme",
      SCHEME,
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archivePath,
      "archive",
      ...authenticationArgs,
      // expo-sharing's config plugin never writes DEVELOPMENT_TEAM for the
      // expo-sharing-extension target, so a bare `xcodebuild archive` fails on it.
      // `expo run:ios` hides this by injecting the team the same way.
      `DEVELOPMENT_TEAM=${settings.teamId}`,
    ],
    { cwd: mobileDir, env: buildEnv },
  );

  yield* Effect.log("[ios-testflight] Exporting the signed .ipa...");
  yield* runCommand(
    spawner,
    "xcodebuild",
    [
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportOptionsPlist",
      exportOptionsPath,
      "-exportPath",
      exportDir,
      ...authenticationArgs,
    ],
    { cwd: mobileDir, env: buildEnv },
  );

  const exported = yield* fs.readDirectory(exportDir);
  const ipaName = exported.find((entry) => entry.endsWith(".ipa"));
  if (!ipaName) {
    return yield* new IosTestFlightError({
      message: `No .ipa was produced in ${exportDir}`,
      cause: undefined,
    });
  }

  yield* Effect.log(`[ios-testflight] Uploading ${ipaName} to App Store Connect...`);
  yield* runCommand(
    spawner,
    "xcrun",
    [
      "altool",
      "--upload-app",
      "--type",
      "ios",
      "--file",
      path.join(exportDir, ipaName),
      "--apiKey",
      settings.keyId,
      "--apiIssuer",
      settings.issuerId,
    ],
    { cwd: mobileDir, env: { ...buildEnv, API_PRIVATE_KEYS_DIR: path.dirname(keyPath) } },
  );

  yield* Effect.log(
    `[ios-testflight] Uploaded build ${buildNumber}. App Store Connect takes a few minutes to finish processing before TestFlight offers it.`,
  );
});

if (import.meta.main) {
  main().pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
