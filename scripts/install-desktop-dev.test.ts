import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DesktopInstallError,
  escapeProcessNameForExactMatch,
  parseMacDmgMountPoint,
  runDesktopInstallLifecycle,
  startAppWithVerification,
  terminateProcessWithEscalation,
  waitForAppToStart,
} from "./install-desktop-dev.ts";

it("escapes macOS app names before exact pgrep and pkill matching", () => {
  assert.equal(escapeProcessNameForExactMatch("T3 Code (Dev)"), "T3 Code \\(Dev\\)");
});

it.effect("escalates process termination from TERM to KILL", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    let waitCount = 0;

    yield* terminateProcessWithEscalation(
      "T3 Code (Dev)",
      (signal) =>
        Effect.sync(() => {
          events.push(signal);
        }),
      () =>
        Effect.sync(() => {
          events.push("wait");
          waitCount += 1;
          return waitCount === 2;
        }),
    );

    assert.deepStrictEqual(events, ["TERM", "wait", "KILL", "wait"]);
  }),
);

it.effect("treats an app that keeps running as started", () =>
  Effect.gen(function* () {
    let samples = 0;

    const started = yield* waitForAppToStart(
      Effect.sync(() => {
        samples += 1;
        return true;
      }),
      Effect.void,
    );

    assert.isTrue(started);
    assert.equal(samples, 9);
  }),
);

it.effect("treats an app that exits right after launching as not started", () =>
  Effect.gen(function* () {
    let samples = 0;

    const started = yield* waitForAppToStart(
      Effect.sync(() => {
        samples += 1;
        return samples < 4;
      }),
      Effect.void,
    );

    assert.isFalse(started);
    assert.equal(samples, 4);
  }),
);

it.effect("gives up on an app that never appears", () =>
  Effect.gen(function* () {
    let samples = 0;

    const started = yield* waitForAppToStart(
      Effect.sync(() => {
        samples += 1;
        return false;
      }),
      Effect.void,
    );

    assert.isFalse(started);
    assert.equal(samples, 21);
  }),
);

it.effect("retries a launch request until the app is running", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    let waitCount = 0;

    yield* startAppWithVerification(
      "T3 Code (Dev)",
      Effect.sync(() => {
        events.push("start");
      }),
      () =>
        Effect.sync(() => {
          events.push("wait");
          waitCount += 1;
          return waitCount === 2;
        }),
      "check the logs",
      Effect.sync(() => {
        events.push("backoff");
      }),
    );

    assert.deepStrictEqual(events, ["start", "wait", "backoff", "start", "wait"]);
  }),
);

it.effect("fails with a diagnostic hint when neither launch request starts the app", () =>
  Effect.gen(function* () {
    const error = yield* startAppWithVerification(
      "T3 Code (Dev)",
      Effect.void,
      () => Effect.succeed(false),
      "Inspect the launch with: log show",
      Effect.void,
    ).pipe(Effect.flip);

    assert.equal(error.message, "T3 Code (Dev) did not start. Inspect the launch with: log show");
  }),
);

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
