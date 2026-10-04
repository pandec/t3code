import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { reserveWorkspace, withWorkspaceLease } from "./workspaceLease.ts";

const makeAlias = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const workspace = path.join(directory, "workspace");
  const alias = path.join(directory, "alias");
  yield* fs.makeDirectory(workspace);
  yield* fs.symlink(workspace, alias);
  return { directory, workspace, alias, path };
});

describe("workspace lease", () => {
  it.effect("serializes aliases of one workspace while other workspaces can start", () =>
    Effect.gen(function* () {
      const { directory, workspace, alias, path } = yield* makeAlias;
      const releaseCleanup = yield* Deferred.make<void>();
      const providerEntered = yield* Deferred.make<void>();
      const otherEntered = yield* Deferred.make<void>();
      const cleanup = yield* withWorkspaceLease(workspace, Deferred.await(releaseCleanup)).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      const provider = yield* withWorkspaceLease(
        alias,
        Deferred.succeed(providerEntered, undefined),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* withWorkspaceLease(
        path.join(directory, "other"),
        Deferred.succeed(otherEntered, undefined),
      );
      assert.isTrue(yield* Deferred.isDone(otherEntered));
      assert.isFalse(yield* Deferred.isDone(providerEntered));
      yield* Deferred.succeed(releaseCleanup, undefined);
      yield* Fiber.join(cleanup);
      yield* Fiber.join(provider);
      assert.isTrue(yield* Deferred.isDone(providerEntered));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reserves aliases and nested paths for removal, released with the scope", () =>
    Effect.gen(function* () {
      const { directory, workspace, alias, path } = yield* makeAlias;
      yield* Effect.gen(function* () {
        assert.isTrue(yield* reserveWorkspace(alias, "claim"));
        assert.isFalse(yield* reserveWorkspace(workspace, "removal"));
        assert.isTrue(yield* reserveWorkspace(path.join(directory, "other"), "removal"));
      }).pipe(Effect.scoped);
      yield* Effect.gen(function* () {
        assert.isTrue(yield* reserveWorkspace(workspace, "removal"));
        assert.isFalse(yield* reserveWorkspace(alias, "claim"));
        assert.isFalse(yield* reserveWorkspace(path.join(workspace, "nested"), "removal"));
      }).pipe(Effect.scoped);
      assert.isTrue(yield* reserveWorkspace(alias, "claim"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
