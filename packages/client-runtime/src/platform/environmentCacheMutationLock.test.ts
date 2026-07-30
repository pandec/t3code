import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { withEnvironmentCacheMutationLock } from "./environmentCacheMutationLock.ts";
import type { EnvironmentCacheStore } from "./persistence.ts";

describe("environment cache mutation lock", () => {
  it.effect("lets a cache clear deterministically follow an in-flight save", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-1");
      const cache = {} as EnvironmentCacheStore["Service"];
      const saveStarted = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);

      const save = yield* withEnvironmentCacheMutationLock(
        cache,
        environmentId,
        Deferred.succeed(saveStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSave)),
          Effect.andThen(Ref.update(order, (current) => [...current, "save"])),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(saveStarted);
      const clear = yield* withEnvironmentCacheMutationLock(
        cache,
        environmentId,
        Ref.update(order, (current) => [...current, "clear"]),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(yield* Ref.get(order)).toEqual([]);

      yield* Deferred.succeed(releaseSave, undefined);
      yield* Fiber.join(save);
      yield* Fiber.join(clear);
      expect(yield* Ref.get(order)).toEqual(["save", "clear"]);
    }),
  );
});
