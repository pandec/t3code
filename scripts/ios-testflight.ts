#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  isAppleTeamId,
  isAppStoreConnectIssuerId,
  isAppStoreConnectKeyId,
  isIosBundleIdentifier,
} from "./lib/apple-mobile-config.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

const SCHEME = "T3Code";
const ARTIFACT_DIRECTORY = "local/ios-testflight";
// CFBundleVersion must strictly increase per upload and stay well inside a 32-bit
// integer, so count minutes since a fixed epoch rather than using a wall-clock
// stamp. That is monotonic, needs no checked-in counter, and only collides if two
// uploads start within the same minute.
const BUILD_NUMBER_EPOCH_MS = Date.UTC(2026, 0, 1);
const ExpoUpdatesFingerprint = Schema.fromJsonString(
  Schema.Struct({
    hash: Schema.String,
  }),
);
const decodeExpoUpdatesFingerprint = Schema.decodeUnknownEffect(ExpoUpdatesFingerprint);

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

export const runCommand = Effect.fn("iosTestFlight.runCommand")(
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
  readonly bundleId: string;
  readonly keyId: string;
  readonly issuerId: string;
  readonly keyPath: string;
}

interface PathContainment {
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...paths: ReadonlyArray<string>) => string;
  readonly relative: (from: string, to: string) => string;
  readonly sep: string;
}

export function isSameOrDescendantPath(
  path: PathContainment,
  parent: string,
  candidate: string,
): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function resolveArtifactCleanupTargets(path: PathContainment, artifactDir: string) {
  return [
    { path: path.join(artifactDir, `${SCHEME}.xcarchive`), recursive: true },
    { path: path.join(artifactDir, "export"), recursive: true },
    { path: path.join(artifactDir, "ExportOptions.plist"), recursive: false },
  ] as const;
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
    bundleId: "T3CODE_IOS_BUNDLE_ID",
    keyId: "T3CODE_ASC_KEY_ID",
    issuerId: "T3CODE_ASC_ISSUER_ID",
    keyPath: "T3CODE_ASC_KEY_PATH",
  } as const;
  const missing = Object.values(required).filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { missing };
  const settings = {
    teamId: env[required.teamId]!.trim().toUpperCase(),
    bundleId: env[required.bundleId]!.trim(),
    keyId: env[required.keyId]!.trim().toUpperCase(),
    issuerId: env[required.issuerId]!.trim(),
    keyPath: env[required.keyPath]!.trim(),
  };
  const invalid = [
    ...(!isAppleTeamId(settings.teamId)
      ? ["T3CODE_APPLE_TEAM_ID must be a 10-character Apple Team ID"]
      : []),
    ...(!isIosBundleIdentifier(settings.bundleId)
      ? ["T3CODE_IOS_BUNDLE_ID must be a reverse-DNS bundle identifier"]
      : []),
    ...(!isAppStoreConnectKeyId(settings.keyId)
      ? ["T3CODE_ASC_KEY_ID must be a 10-character App Store Connect key ID"]
      : []),
    ...(!isAppStoreConnectIssuerId(settings.issuerId)
      ? ["T3CODE_ASC_ISSUER_ID must be a UUID"]
      : []),
  ];
  return invalid.length > 0 ? { missing: invalid } : settings;
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
  const keyInfo = yield* fs
    .stat(keyPath)
    .pipe(
      Effect.mapError((cause) =>
        asIosTestFlightError(`Could not inspect App Store Connect key at ${keyPath}`, cause),
      ),
    );
  if (keyInfo.type !== "File") {
    return yield* new IosTestFlightError({
      message: `App Store Connect key must be a regular file, but ${keyPath} is ${keyInfo.type}.`,
      cause: undefined,
    });
  }
  yield* fs
    .access(keyPath, { readable: true })
    .pipe(
      Effect.mapError((cause) =>
        asIosTestFlightError(`App Store Connect key is not readable at ${keyPath}`, cause),
      ),
    );

  const buildNumber = resolveBuildNumber(yield* Clock.currentTimeMillis);
  const artifactDir = path.join(repoRoot, ARTIFACT_DIRECTORY);
  const cleanupTargets = resolveArtifactCleanupTargets(path, artifactDir);
  const [archiveTarget, exportTarget, exportOptionsTarget] = cleanupTargets;
  const archivePath = archiveTarget.path;
  const exportDir = exportTarget.path;
  const exportOptionsPath = exportOptionsTarget.path;
  const lockPath = path.join(artifactDir, ".lock");
  const repoRootRealPath = yield* fs.realPath(repoRoot);
  const artifactParent = path.dirname(artifactDir);
  yield* fs.makeDirectory(artifactParent, { recursive: true });
  const artifactParentRealPath = yield* fs.realPath(artifactParent);
  if (!isSameOrDescendantPath(path, repoRootRealPath, artifactParentRealPath)) {
    return yield* new IosTestFlightError({
      message: `Refusing to use artifact parent ${artifactParentRealPath} because it resolves outside ${repoRootRealPath}.`,
      cause: undefined,
    });
  }
  yield* fs.makeDirectory(artifactDir, { recursive: true });
  const artifactDirRealPath = yield* fs.realPath(artifactDir);
  if (!isSameOrDescendantPath(path, repoRootRealPath, artifactDirRealPath)) {
    return yield* new IosTestFlightError({
      message: `Refusing to use artifact directory ${artifactDirRealPath} because it resolves outside ${repoRootRealPath}.`,
      cause: undefined,
    });
  }
  yield* Effect.acquireRelease(
    fs
      .open(lockPath, { flag: "wx" })
      .pipe(
        Effect.mapError((cause) =>
          asIosTestFlightError(
            `Another TestFlight run is active, or a stale lock exists at ${lockPath}. Remove it only after confirming no run is active.`,
            cause,
          ),
        ),
      ),
    () => fs.remove(lockPath, { force: true }).pipe(Effect.orDie),
  );

  const keyRealPath = yield* fs.realPath(keyPath);
  for (const target of cleanupTargets) {
    const targetRealPath = (yield* fs.exists(target.path))
      ? yield* fs.realPath(target.path)
      : path.join(artifactDirRealPath, path.relative(artifactDir, target.path));
    if (isSameOrDescendantPath(path, targetRealPath, keyRealPath)) {
      return yield* new IosTestFlightError({
        message: `Refusing to clean ${target.path} because it contains the App Store Connect key at ${keyPath}. Move the key outside generated archive/export paths.`,
        cause: undefined,
      });
    }
  }

  const buildEnv = {
    ...process.env,
    APP_VARIANT: "production",
    T3CODE_IOS_BUILD_NUMBER: buildNumber,
    EXPO_NO_GIT_STATUS: "1",
  };

  yield* Effect.log(
    `[ios-testflight] Building ${settings.bundleId} version ${repoEnv.T3CODE_FORK_VERSION?.trim() || "0.1.0"} build ${buildNumber}.`,
  );

  const authenticationEnvironment = {
    ...buildEnv,
    API_PRIVATE_KEYS_DIR: path.dirname(keyPath),
  };
  // There is deliberately no credential preflight here. altool rejects API-key
  // authentication for every command that would serve as one
  // ("list-providers does not support APIKey authentication"), so such a check
  // fails the run before it starts. Credentials are exercised seconds into the
  // archive instead, when -allowProvisioningUpdates contacts the developer
  // portal — long before the expensive compile.

  for (const target of cleanupTargets) {
    yield* fs.remove(target.path, { recursive: target.recursive, force: true });
  }
  yield* fs.writeFileString(exportOptionsPath, renderExportOptionsPlist(settings.teamId));

  yield* Effect.log("[ios-testflight] Generating the native iOS project...");
  yield* runCommand(spawner, "vp", ["exec", "expo", "prebuild", "--clean", "--platform", "ios"], {
    cwd: mobileDir,
    env: buildEnv,
  });

  // Xcode build phases mutate ios/Pods (prebuilt-core probe markers, regenerated
  // ExpoModulesProvider files), so the fingerprint expo-updates would embed
  // mid-archive never matches the one `eas update` computes from a clean
  // prebuild. Pin the embedded value to the clean post-prebuild state — the same
  // state every later `eas update` run reproduces — via the override EAS Build
  // itself uses. Only fork EAS builds have updates enabled, so skip otherwise.
  let fingerprintEnv: Readonly<Record<string, string>> = {};
  if (repoEnv.T3CODE_EAS_PROJECT_ID?.trim()) {
    yield* Effect.log("[ios-testflight] Computing the update fingerprint...");
    // Strip the build number: it flows into the resolved expo config, which the
    // fingerprint hashes, so leaving it set would mint a unique runtime version
    // per build that no later `eas update` run (which has no build number) can
    // ever reproduce. The native Info.plist copy is already in the
    // fingerprinter's default ignores.
    const fingerprintGenerateEnv = { ...buildEnv, T3CODE_IOS_BUILD_NUMBER: undefined };
    const fingerprintJson = yield* spawner
      .string(
        ChildProcess.make(
          "vp",
          ["exec", "expo-updates", "fingerprint:generate", "--platform", "ios"],
          {
            cwd: mobileDir,
            env: fingerprintGenerateEnv,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "inherit",
          },
        ),
      )
      .pipe(
        Effect.mapError((cause) => asIosTestFlightError("Fingerprint generation failed", cause)),
      );
    const { hash } = yield* decodeExpoUpdatesFingerprint(fingerprintJson).pipe(
      Effect.mapError(
        () =>
          new IosTestFlightError({
            message: "expo-updates fingerprint:generate did not return a hash.",
            cause: fingerprintJson,
          }),
      ),
    );
    yield* Effect.log(`[ios-testflight] Embedding runtime fingerprint ${hash}.`);
    fingerprintEnv = { EXPO_UPDATES_FINGERPRINT_OVERRIDE: hash };
  }

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
      // withIosDevelopmentTeam.cjs already stamps DEVELOPMENT_TEAM at prebuild;
      // kept as a belt-and-braces override so the archive cannot regress to an
      // unsigned target if the plugin is reordered or removed.
      `DEVELOPMENT_TEAM=${settings.teamId}`,
    ],
    { cwd: mobileDir, env: { ...buildEnv, ...fingerprintEnv } },
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
    { cwd: mobileDir, env: authenticationEnvironment },
  );

  yield* Effect.log(
    `[ios-testflight] Uploaded build ${buildNumber}. App Store Connect takes a few minutes to finish processing before TestFlight offers it.`,
  );
});

if (import.meta.main) {
  main().pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
