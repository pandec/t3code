#!/usr/bin/env node

import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DetachedDesktopRecord = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  repoRoot: Schema.String,
  startedAt: Schema.String,
  logPath: Schema.String,
});
type DetachedDesktopRecord = typeof DetachedDesktopRecord.Type;

const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(DetachedDesktopRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(DetachedDesktopRecord));

const main = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;
  const command = process.argv[2];
  const scriptDir = path.dirname(NodeURL.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const configuredT3Home = process.env.T3CODE_HOME?.trim();
  const t3Home = path.resolve(configuredT3Home || path.join(NodeOS.homedir(), ".t3"));
  const devStateDir = path.join(t3Home, "dev");
  const logPath = path.join(devStateDir, "logs", "dev-desktop-detached.log");
  const recordPath = path.join(devStateDir, "dev-desktop-detached.json");

  const readRecord = fileSystem
    .readFileString(recordPath)
    .pipe(Effect.flatMap(decodeRecord), Effect.option);
  const removeRecord = fileSystem.remove(recordPath, { force: true }).pipe(Effect.ignore);

  const isExpectedRunner = Effect.fn("devDesktopDetached.isExpectedRunner")(function* (
    record: DetachedDesktopRecord,
  ) {
    if (hostPlatform === "win32") {
      const exitCode = yield* spawner
        .exitCode(ChildProcess.make("tasklist", ["/fi", `PID eq ${String(record.pid)}`]))
        .pipe(Effect.option);
      return Option.isSome(exitCode) && Number(exitCode.value) === 0;
    }

    const processCommand = yield* spawner
      .string(ChildProcess.make("ps", ["-p", String(record.pid), "-o", "command="]))
      .pipe(Effect.option);
    return (
      Option.isSome(processCommand) &&
      processCommand.value.includes("dev-runner.ts") &&
      processCommand.value.includes("dev:desktop")
    );
  });

  const writeRecord = Effect.fn("devDesktopDetached.writeRecord")(function* (
    record: DetachedDesktopRecord,
  ) {
    const temporaryPath = `${recordPath}.${String(process.pid)}.tmp`;
    const encoded = yield* encodeRecord(record);
    yield* fileSystem.writeFileString(temporaryPath, `${encoded}\n`, { mode: 0o600 });
    yield* fileSystem.rename(temporaryPath, recordPath);
  });

  const start = Effect.gen(function* () {
    const existing = yield* readRecord;
    if (Option.isSome(existing) && (yield* isExpectedRunner(existing.value))) {
      yield* Effect.log(
        `T3 Code desktop dev is already running (pid ${String(existing.value.pid)}).`,
      );
      yield* Effect.log(`Logs: ${existing.value.logPath}`);
      return;
    }

    yield* removeRecord;
    yield* fileSystem.makeDirectory(path.dirname(logPath), { recursive: true });
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    yield* fileSystem.writeFileString(logPath, `\n--- detached start ${startedAt} ---\n`, {
      flag: "a",
    });

    const devRunnerPath = path.join(scriptDir, "dev-runner.ts");
    const shellCommand = 'exec "$1" "$2" "$3" >>"$4" 2>&1';
    const child = yield* ChildProcess.make(
      "/bin/sh",
      [
        "-c",
        shellCommand,
        "t3code-dev-desktop",
        process.execPath,
        devRunnerPath,
        "dev:desktop",
        logPath,
      ],
      {
        cwd: repoRoot,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const pid = Number(child.pid);
    yield* writeRecord({ pid, repoRoot, startedAt, logPath });
    yield* child.unref.pipe(Effect.asVoid);

    yield* Effect.log(`Started T3 Code desktop dev in the background (pid ${String(pid)}).`);
    yield* Effect.log(`Logs: ${logPath}`);
    yield* Effect.log("Stop: vp run dev:desktop:detached:stop");
  });

  const status = Effect.gen(function* () {
    const record = yield* readRecord;
    if (Option.isNone(record) || !(yield* isExpectedRunner(record.value))) {
      yield* removeRecord;
      yield* Effect.log("T3 Code desktop dev is not running in detached mode.");
      return;
    }

    yield* Effect.log(`T3 Code desktop dev is running (pid ${String(record.value.pid)}).`);
    yield* Effect.log(`Started: ${record.value.startedAt}`);
    yield* Effect.log(`Logs: ${record.value.logPath}`);
  });

  const stop = Effect.gen(function* () {
    const record = yield* readRecord;
    if (Option.isNone(record) || !(yield* isExpectedRunner(record.value))) {
      yield* removeRecord;
      yield* Effect.log("T3 Code desktop dev is not running in detached mode.");
      return;
    }

    if (hostPlatform === "win32") {
      yield* spawner.exitCode(
        ChildProcess.make("taskkill", ["/pid", String(record.value.pid), "/t", "/f"]),
      );
    } else {
      yield* spawner.exitCode(
        ChildProcess.make("/bin/kill", ["-TERM", `-${String(record.value.pid)}`]),
      );
      for (let attempt = 0; attempt < 40 && (yield* isExpectedRunner(record.value)); attempt += 1) {
        yield* Effect.sleep("100 millis");
      }
      if (yield* isExpectedRunner(record.value)) {
        yield* spawner.exitCode(
          ChildProcess.make("/bin/kill", ["-KILL", `-${String(record.value.pid)}`]),
        );
      }
    }

    yield* removeRecord;
    yield* Effect.log("Stopped T3 Code desktop dev detached runner.");
  });

  switch (command) {
    case "start":
      yield* start;
      return;
    case "status":
      yield* status;
      return;
    case "stop":
      yield* stop;
      return;
    default:
      return yield* Effect.die(new Error("Usage: dev-desktop-detached.ts <start|status|stop>"));
  }
});

if (import.meta.main) {
  main.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
