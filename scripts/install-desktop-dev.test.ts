import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DesktopInstallError,
  escapeProcessNameForExactMatch,
  parseMacDmgMountPoint,
  runDesktopInstallLifecycle,
} from "./install-desktop-dev.ts";

it("escapes macOS app names before exact pgrep and pkill matching", () => {
  assert.equal(escapeProcessNameForExactMatch("T3 Code (Dev)"), "T3 Code \\(Dev\\)");
});

function lifecycle(events: Array<string>, running: boolean, failAt?: "build" | "install") {
  return {
    isRunning: Effect.sync(() => {
      events.push("check");
      return running;
    }),
    stop: Effect.sync(() => {
      events.push("stop");
    }),
    build: Effect.gen(function* () {
      events.push("build");
      if (failAt === "build") {
        return yield* new DesktopInstallError({ message: "build failed", cause: undefined });
      }
    }),
    install: Effect.gen(function* () {
      events.push("install");
      if (failAt === "install") {
        return yield* new DesktopInstallError({ message: "install failed", cause: undefined });
      }
    }),
    start: Effect.sync(() => {
      events.push("start");
    }),
  };
}

it.effect("stops a running app before building and always launches the installed app", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];

    yield* runDesktopInstallLifecycle(lifecycle(events, true));

    assert.deepStrictEqual(events, ["check", "stop", "build", "install", "start"]);
  }),
);

it.effect("launches the installed app even when it was not running before the build", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];

    yield* runDesktopInstallLifecycle(lifecycle(events, false));

    assert.deepStrictEqual(events, ["check", "build", "install", "start"]);
  }),
);

it.effect("restores a previously running app when the rebuild fails", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];

    const error = yield* runDesktopInstallLifecycle(lifecycle(events, true, "build")).pipe(
      Effect.flip,
    );

    assert.equal(error.message, "build failed");
    assert.deepStrictEqual(events, ["check", "stop", "build", "start"]);
  }),
);

it.effect("does not launch an app that was stopped before a failed install", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];

    const error = yield* runDesktopInstallLifecycle(lifecycle(events, false, "install")).pipe(
      Effect.flip,
    );

    assert.equal(error.message, "install failed");
    assert.deepStrictEqual(events, ["check", "build", "install"]);
  }),
);

it("parses macOS DMG mount paths containing spaces", () => {
  assert.equal(
    parseMacDmgMountPoint(
      "/dev/disk4\tApple_partition_scheme\n/dev/disk4s1\tApple_HFS\t/Volumes/T3 Code Dev 0.0.1\n",
    ),
    "/Volumes/T3 Code Dev 0.0.1",
  );
});
