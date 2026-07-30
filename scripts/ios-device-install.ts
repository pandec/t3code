#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { IosTestFlightError, resolveSettings, runCommand } from "./ios-testflight.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

const SCHEME = "T3Code";
const ARTIFACT_DIRECTORY = "local/ios-device";

/**
 * Builds the production Release app for a physically connected iPhone or iPad
 * and installs it with devicectl, signing through the App Store Connect API
 * key instead of an Xcode account session. Installing over the TestFlight app
 * upgrades it in place and preserves its data, which makes this the canonical
 * way to reproduce and verify device-only issues.
 *
 * Flags: `--device <udid>` picks a device when several are connected;
 * `--no-console` skips the blocking console-attached launch.
 */

interface DevicectlDevice {
  readonly identifier?: string;
  readonly deviceProperties?: { readonly name?: string; readonly osVersionNumber?: string };
  readonly hardwareProperties?: { readonly platform?: string };
  readonly connectionProperties?: { readonly pairingState?: string; readonly tunnelState?: string };
}

export function selectDevice(
  payload: unknown,
  requestedUdid: string | undefined,
): { readonly identifier: string; readonly label: string } | { readonly error: string } {
  const devices: ReadonlyArray<DevicectlDevice> =
    (payload as { result?: { devices?: ReadonlyArray<DevicectlDevice> } }).result?.devices ?? [];
  const candidates = devices.filter(
    (device) =>
      device.identifier !== undefined &&
      device.hardwareProperties?.platform === "iOS" &&
      device.connectionProperties?.pairingState === "paired",
  );
  const chosen = requestedUdid
    ? candidates.find((device) => device.identifier === requestedUdid)
    : candidates[0];
  if (!chosen?.identifier) {
    return {
      error: requestedUdid
        ? `No paired iOS device matches --device ${requestedUdid}.`
        : "No paired iOS device found. Connect the device and trust this Mac.",
    };
  }
  const name = chosen.deviceProperties?.name ?? chosen.identifier;
  // "unavailable" means the CoreDevice tunnel is down; xcodebuild would fail
  // later with an unhelpful "Unable to find a destination". Fail early with
  // the actionable cause instead.
  if (chosen.connectionProperties?.tunnelState === "unavailable") {
    return {
      error: `${name} is paired but unavailable. Plug it in (or rejoin the network), unlock it, and retry.`,
    };
  }
  const osVersion = chosen.deviceProperties?.osVersionNumber ?? "unknown iOS";
  return { identifier: chosen.identifier, label: `${name} (iOS ${osVersion})` };
}

export function parseArgs(argv: ReadonlyArray<string>): {
  readonly requestedUdid: string | undefined;
  readonly attachConsole: boolean;
} {
  const deviceIndex = argv.indexOf("--device");
  return {
    requestedUdid: deviceIndex === -1 ? undefined : argv[deviceIndex + 1],
    attachConsole: !argv.includes("--no-console"),
  };
}

const main = Effect.fn("iosDeviceInstall.main")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const mobileDir = path.join(repoRoot, "apps", "mobile");
  const { requestedUdid, attachConsole } = parseArgs(process.argv.slice(2));

  const settings = resolveSettings(loadRepoEnv());
  if ("missing" in settings) {
    return yield* new IosTestFlightError({
      message: `Cannot build for a device. Fix in .env.local: ${settings.missing.join(", ")}`,
      cause: undefined,
    });
  }
  const keyPath = path.isAbsolute(settings.keyPath)
    ? settings.keyPath
    : path.join(repoRoot, settings.keyPath);
  if (!(yield* fs.exists(keyPath))) {
    return yield* new IosTestFlightError({
      message: `App Store Connect key not found at ${keyPath}.`,
      cause: undefined,
    });
  }

  const artifactDir = path.join(repoRoot, ARTIFACT_DIRECTORY);
  yield* fs.makeDirectory(artifactDir, { recursive: true });

  const devicesJsonPath = path.join(artifactDir, "devices.json");
  yield* runCommand(spawner, "xcrun", [
    "devicectl",
    "list",
    "devices",
    "--json-output",
    devicesJsonPath,
    "--quiet",
  ]);
  // @effect-diagnostics-next-line preferSchemaOverJson:off - devicectl output is sniffed as unknown and validated by selectDevice.
  const devicesPayload: unknown = JSON.parse(yield* fs.readFileString(devicesJsonPath));
  const device = selectDevice(devicesPayload, requestedUdid);
  if ("error" in device) {
    return yield* new IosTestFlightError({ message: device.error, cause: undefined });
  }
  yield* Effect.log(`[ios-device] Installing ${settings.bundleId} on ${device.label}.`);

  const buildEnv = {
    ...process.env,
    APP_VARIANT: "production",
    EXPO_NO_GIT_STATUS: "1",
  };

  yield* Effect.log("[ios-device] Generating the native iOS project...");
  yield* runCommand(spawner, "vp", ["exec", "expo", "prebuild", "--clean", "--platform", "ios"], {
    cwd: mobileDir,
    env: buildEnv,
  });

  // DerivedData is kept between runs on purpose: unlike the TestFlight
  // archive, a device build benefits from incremental compilation.
  const derivedDataPath = path.join(artifactDir, "DerivedData");
  yield* Effect.log("[ios-device] Building Release for the device (this takes a while)...");
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
      `platform=iOS,id=${device.identifier}`,
      // CoreDevice discovery can take a while when the device tunnel is cold
      // or Xcode is busy preparing the device; the default timeout gives up
      // in seconds.
      "-destination-timeout",
      "180",
      "-derivedDataPath",
      derivedDataPath,
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      keyPath,
      "-authenticationKeyID",
      settings.keyId,
      "-authenticationKeyIssuerID",
      settings.issuerId,
      "build",
      // withIosDevelopmentTeam.cjs already stamps DEVELOPMENT_TEAM at prebuild;
      // kept as a belt-and-braces override, mirroring the TestFlight archive.
      `DEVELOPMENT_TEAM=${settings.teamId}`,
    ],
    { cwd: mobileDir, env: buildEnv },
  );

  const appPath = path.join(
    derivedDataPath,
    "Build",
    "Products",
    "Release-iphoneos",
    `${SCHEME}.app`,
  );
  if (!(yield* fs.exists(appPath))) {
    return yield* new IosTestFlightError({
      message: `No app was produced at ${appPath}`,
      cause: undefined,
    });
  }

  yield* Effect.log("[ios-device] Installing (existing app data is preserved)...");
  yield* runCommand(spawner, "xcrun", [
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    device.identifier,
    appPath,
  ]);

  if (!attachConsole) {
    yield* Effect.log(
      `[ios-device] Installed ${settings.bundleId}. Launch skipped (--no-console).`,
    );
    return;
  }
  yield* Effect.log("[ios-device] Launching with the console attached; Ctrl-C detaches...");
  yield* runCommand(spawner, "xcrun", [
    "devicectl",
    "device",
    "process",
    "launch",
    "--console",
    "--terminate-existing",
    "--device",
    device.identifier,
    settings.bundleId,
  ]);
});

if (import.meta.main) {
  main().pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
