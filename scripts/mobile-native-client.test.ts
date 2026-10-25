import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import {
  installedBinary,
  NativeClientError,
  prebuildAndroid,
  selectIosAppPath,
  selectIosScheme,
  selectIosWorkspace,
} from "./mobile-native-client.ts";

effectIt.layer(NodeServices.layer)("mobile native client identity", (it) => {
  it.effect("probes the configured iOS bundle identifier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const app = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-client-test-" });
      const calls: string[][] = [];
      const run = (_program: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "listapps") return Effect.succeed('{ "com.example.personal.t3": {} }');
        if (args[1] === "get_app_container") return Effect.succeed(app);
        return Effect.die(`Unexpected command: ${args.join(" ")}`);
      };

      yield* installedBinary("ios", "SIMULATOR", "com.example.personal.t3", run);

      assert.deepStrictEqual(calls[1], [
        "simctl",
        "get_app_container",
        "SIMULATOR",
        "com.example.personal.t3",
        "app",
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("generated iOS build target discovery", () => {
  it("selects the generated workspace and its matching scheme", () => {
    const workspace = selectIosWorkspace(["Podfile", "T3Code.xcodeproj", "ForkApp.xcworkspace"]);
    expect(workspace).toBe("ForkApp.xcworkspace");
    expect(selectIosScheme(workspace, ["Pods-ForkApp", "ForkApp"])).toBe("ForkApp");
  });

  it("rejects an ambiguous scheme list instead of choosing a Pods scheme", () => {
    expect(selectIosScheme("ForkApp.xcworkspace", ["Pods-ForkApp", "OtherApp"])).toBe("");
  });

  it("selects only the app target matching the configured identifier", () => {
    expect(
      selectIosAppPath(
        [
          { buildSettings: {} },
          {
            buildSettings: {
              PRODUCT_BUNDLE_IDENTIFIER: "org.cocoapods.Library",
              TARGET_BUILD_DIR: "/tmp/Derived/Frameworks",
              FULL_PRODUCT_NAME: "Library.framework",
              WRAPPER_EXTENSION: "framework",
            },
          },
          {
            buildSettings: {
              PRODUCT_BUNDLE_IDENTIFIER: "com.example.personal.t3",
              TARGET_BUILD_DIR: "/tmp/Derived/Apps",
              FULL_PRODUCT_NAME: "Fork App Dev.app",
              WRAPPER_EXTENSION: "app",
            },
          },
        ],
        "com.example.personal.t3",
      ),
    ).toBe("/tmp/Derived/Apps/Fork App Dev.app");
  });
});

const caches = [".gradle/history", "app/.cxx/object"];

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mobile = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-native-client-" });
  const android = path.join(mobile, "android");
  for (const cache of caches) {
    yield* fs.makeDirectory(path.dirname(path.join(android, cache)), { recursive: true });
    yield* fs.writeFileString(path.join(android, cache), cache);
  }
  const cleanPrebuild = Effect.gen(function* () {
    yield* fs.remove(android, { recursive: true });
    yield* fs.makeDirectory(path.join(android, "app"), { recursive: true });
    yield* fs.writeFileString(path.join(android, "app/build.gradle"), "regenerated");
  });
  const assertCachesRestored = Effect.gen(function* () {
    for (const cache of caches) {
      assert.strictEqual(yield* fs.readFileString(path.join(android, cache)), cache);
    }
    assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
  });
  return { fs, path, mobile, android, cleanPrebuild, assertCachesRestored };
});

effectIt.layer(NodeServices.layer)("prebuildAndroid", (it) => {
  it.effect("keeps Gradle and native caches through a clean prebuild", () =>
    Effect.gen(function* () {
      const { fs, path, mobile, android, cleanPrebuild, assertCachesRestored } = yield* fixture;

      yield* prebuildAndroid(mobile, cleanPrebuild);

      assert.strictEqual(
        yield* fs.readFileString(path.join(android, "app/build.gradle")),
        "regenerated",
      );
      yield* assertCachesRestored;
    }),
  );

  it.effect("restores the caches and returns the error when prebuild fails", () =>
    Effect.gen(function* () {
      const { mobile, cleanPrebuild, assertCachesRestored } = yield* fixture;
      const failure = new NativeClientError({ message: "prebuild failed" });

      const error = yield* prebuildAndroid(
        mobile,
        cleanPrebuild.pipe(Effect.andThen(Effect.fail(failure))),
      ).pipe(Effect.flip);

      assert.strictEqual(error, failure);
      yield* assertCachesRestored;
    }),
  );
});
