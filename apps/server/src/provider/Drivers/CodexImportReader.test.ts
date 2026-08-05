import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { listCodexImportableSessions } from "./CodexImportReader.ts";

it.effect("passes launch args to the ephemeral app-server process", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        spawned = command;
        throw new Error("Stop after capturing the command");
      }),
    ),
  );

  return Effect.gen(function* () {
    yield* listCodexImportableSessions({
      binaryPath: "codex",
      launchArgs: "--strict-config --enable gateway",
      cwd: "/tmp/project",
    }).pipe(Effect.exit);

    assert.deepEqual(spawned?.args, ["app-server", "--strict-config", "--enable", "gateway"]);
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, spawnerLayer)));
});
