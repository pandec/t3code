import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

describe("DesktopAssets", () => {
  it.effect("uses the packaged icon for packaged Dev builds", () =>
    Effect.gen(function* () {
      const packagedIconPath = "/Applications/T3 Code.app/Contents/Resources/icon.png";
      const fileSystemLayer = FileSystem.layerNoop({
        exists: (path) => Effect.succeed(path === packagedIconPath),
      });
      const packagedDevEnvironmentLayer = DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/dist-electron",
        homeDirectory: "/Users/alice",
        platform: "darwin",
        processArch: "arm64",
        buildFlavor: "dev",
        appVersion: "1.2.3",
        appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
        isPackaged: true,
        resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
      const assetsLayer = DesktopAssets.layer.pipe(
        Layer.provide(Layer.merge(fileSystemLayer, packagedDevEnvironmentLayer)),
      );
      const assets = yield* DesktopAssets.DesktopAssets.pipe(Effect.provide(assetsLayer));
      const iconPaths = yield* assets.iconPaths;

      assert.equal(Option.getOrThrow(iconPaths.png), packagedIconPath);
    }),
  );
});
