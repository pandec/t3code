import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { replaceVerifiedMacApp } from "./install-desktop-dev.ts";
import { MacDevSigningError, resolveMacDevSigningTeam } from "./lib/mac-dev-signing.ts";

it.effect("requires an explicit, valid Apple team for Dev signing", () =>
  Effect.gen(function* () {
    for (const team of [undefined, "", "-", 'ABC1234567" or true']) {
      const error = yield* resolveMacDevSigningTeam({
        T3CODE_DESKTOP_MAC_TEAM_ID: team,
      }).pipe(Effect.flip);
      assert.instanceOf(error, MacDevSigningError);
    }
    assert.equal(
      yield* resolveMacDevSigningTeam({ T3CODE_DESKTOP_MAC_TEAM_ID: " ABC1234567 " }),
      "ABC1234567",
    );
  }),
);

for (const exitCode of [0, 1]) {
  it.effect(
    exitCode === 0
      ? "replaces the installed app after codesign accepts the copied bundle"
      : "preserves the installed app when codesign rejects the copied bundle",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped();
        const installed = path.join(root, "installed.app");
        const staged = path.join(root, "staged.app");
        yield* fs.makeDirectory(installed);
        yield* fs.makeDirectory(staged);
        yield* fs.writeFileString(path.join(installed, "version"), "old");
        yield* fs.writeFileString(path.join(staged, "version"), "new");

        const result = yield* replaceVerifiedMacApp(staged, installed, "ABC1234567").pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            exitCode: (command) => {
              assert.equal(command._tag, "StandardCommand");
              if (command._tag === "StandardCommand") {
                assert.equal(command.command, "/usr/bin/codesign");
                assert.deepStrictEqual(command.args.slice(0, 5), [
                  "--verify",
                  "--deep",
                  "--strict",
                  "--verbose=2",
                  "-R",
                ]);
                const requirement = command.args[5] ?? "";
                assert.isTrue(requirement.startsWith("="));
                assert.include(requirement, 'identifier "com.t3tools.t3code.dev"');
                assert.include(requirement, "anchor apple generic");
                assert.include(requirement, "1.2.840.113635.100.6.1.13");
                assert.include(requirement, 'subject.OU] = "ABC1234567"');
                assert.equal(command.args[6], staged);
              }
              return Effect.succeed(ChildProcessSpawner.ExitCode(exitCode));
            },
          }),
          Effect.result,
        );
        assert.equal(result._tag, exitCode === 0 ? "Success" : "Failure");
        assert.equal(
          yield* fs.readFileString(path.join(installed, "version")),
          exitCode === 0 ? "new" : "old",
        );
        assert.equal(yield* fs.exists(staged), exitCode !== 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
